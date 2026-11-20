import { Hono } from 'hono'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { db, getInsertId, schema } from '../db/index.js'
import { success, notFound, created, badRequest, now } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { joinProviderUrl } from '../services/adapters/url.js'
import { isOfficialProvider, parseConfigTemperature } from '../services/ai.js'
import { redactUrl, logTaskError, logTaskProgress, logTaskSuccess } from '../utils/task-logger.js'
import { checkComfyWorkflow, parseComfySettings, validateComfySettings } from '../services/comfyui.js'
import { recordedFetch as fetch, withApiCallContext } from '../services/api-call-log.js'
import { jimengVideoModels } from '../services/jimeng-video.js'
import { denyJimengPrivateAccess, publicJimengAccount, requireJimengPrivateAccess } from './jimeng.js'
import { disconnectJimengAccount, JimengCliError } from '../services/jimeng-cli.js'
import { checkLibTVConnection, disconnectLibTVAccount, LibTVCliError } from '../services/libtv-cli.js'
import { libtvVideoModels } from '../services/libtv-video-models.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess } from '../utils/private-access.js'
import { trustedSiteLoginScope } from './site-session.js'

const app = new Hono()
const libtvPrivateAccess = (c: Parameters<typeof hasLoopbackAccess>[0]) => hasLoopbackAccess(c) || hasPrivateGatewayAccess(c)
const denyLibTVAccess = (c: Parameters<typeof hasLoopbackAccess>[0]) => c.json({ code: 403, message: '请通过私有站点设置 LibTV 官方 CLI 服务' }, 403)
const isLibTVModelList = (models: unknown) =>
  Array.isArray(models) && models.length > 0 && models.every(model => libtvVideoModels.includes(model))

/** 归一化 temperature 入参：null=未设置；合法值 0~2；非法抛错 */
function normalizeTemperature(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error('invalid temperature')
  return n
}

/** 把 settings JSON 中的 temperature 透出为顶层字段，便于前端直接读写 */
function withParsedFields(r: any) {
  return {
    ...toSnakeCase(r),
    model: r.model ? JSON.parse(r.model) : [],
    temperature: parseConfigTemperature(r.settings),
    comfyui: parseComfySettings(r.settings) || null,
  }
}

function bearerHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function geminiHeaders(apiKey?: string, withJson = false) {
  const headers: Record<string, string> = {}
  if (apiKey) {
    headers['x-goog-api-key'] = apiKey
  }
  if (withJson) headers['Content-Type'] = 'application/json'
  return headers
}

function buildProbe(serviceType: string, provider: string, baseUrl: string, model?: string, apiKey?: string) {
  const p = provider.toLowerCase()
  const m = model || ''

  if (p === 'gemini') {
    // 探针统一走 generateContent:文本运行时(AI SDK)走的就是它,官方与中转站都支持;
    // interactions 端点很多中转站未配置,探它会误报 500。
    // 用最小合法请求体而非空体——空体在部分中转站会触发上游认证失败的误报
    const modelName = m || 'gemini-3.1-pro-preview'
    const url = new URL(joinProviderUrl(baseUrl, '/v1beta', `/models/${modelName}:generateContent`))
    if (apiKey) url.searchParams.set('key', apiKey)
    return {
      method: 'POST',
      url: url.toString(),
      headers: geminiHeaders(apiKey, true),
      body: { contents: [{ parts: [{ text: 'hi' }] }] },
    }
  }

  if (p === 'openai' || p === 'aicost') {
    return {
      method: 'GET',
      url: joinProviderUrl(baseUrl, '/v1', '/models'),
      headers: bearerHeaders(apiKey),
      body: undefined,
    }
  }

  if (p === 'volcengine') {
    if (serviceType === 'video') {
      // 只读验证路径和 API Key，不提交生成任务，也不消耗生成额度。
      const url = new URL(joinProviderUrl(baseUrl, '/api/v3', '/contents/generations/tasks'))
      url.searchParams.set('page_size', '1')
      return {
        method: 'GET',
        url: url.toString(),
        headers: bearerHeaders(apiKey),
        body: undefined,
      }
    }
    const path = serviceType === 'video'
      ? '/contents/generations/tasks'
      : serviceType === 'text'
        ? '/chat/completions'
        : '/images/generations'
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v3', path),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'minimax') {
    // MiniMax 仅提供视频服务，空请求体探测鉴权/端点连通性
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/v2', '/video_generation'),
      headers: bearerHeaders(apiKey, true),
      body: {},
    }
  }

  if (p === 'aliyun') {
    // Wan 3.0 仅支持异步提交；空请求体不会创建计费任务，仅用于验证地域端点与鉴权是否可达。
    return {
      method: 'POST',
      url: joinProviderUrl(baseUrl, '/api/v1', '/services/aigc/video-generation/video-synthesis'),
      headers: {
        ...bearerHeaders(apiKey, true),
        'X-DashScope-Async': 'enable',
      },
      body: {},
    }
  }

  return {
    method: 'GET',
    url: joinProviderUrl(baseUrl, '', m ? `/${m}` : '/'),
    headers: bearerHeaders(apiKey),
    body: undefined,
  }
}

// GET /ai-configs?service_type=text
app.get('/', async (c) => {
  const serviceType = c.req.query('service_type')
  let rows = await db.select().from(schema.aiServiceConfigs)
  if (serviceType) rows = rows.filter(r => r.serviceType === serviceType)

  const parsed = rows.map(withParsedFields)
  return success(c, parsed)
})

// POST /ai-configs
app.post('/', async (c) => {
  const body = await c.req.json()
  const ts = now()

  // 验证必填字段
  if (!body.service_type || !body.provider) {
    return badRequest(c, '需要 service_type 与 provider')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }
  const jimeng = String(body.provider).toLowerCase() === 'jimeng'
  const libtv = String(body.provider).toLowerCase() === 'libtv'
  if (jimeng) {
    try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
    if (!isJimengModelList(body.model)) return badRequest(c, '请选择已支持的即梦 Seedance 模型')
  }
  if (libtv) {
    if (!libtvPrivateAccess(c)) return denyLibTVAccess(c)
    if (!isLibTVModelList(body.model)) return badRequest(c, '请选择 LibTV 支持的 Seedance 2.5 模型')
  }

  let temperature: number | null = null
  let comfyui
  try {
    if (body.comfyui != null) comfyui = validateComfySettings(body.comfyui)
  } catch (error: any) { return badRequest(c, error.message) }
  if ('temperature' in body) {
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
  }

  const res = await db.insert(schema.aiServiceConfigs).values({
    serviceType: body.service_type,
    provider: jimeng ? 'jimeng' : libtv ? 'libtv' : body.provider,
    name: body.name || `${body.provider}-${body.service_type}`,
    baseUrl: jimeng || libtv ? '' : body.base_url || '',
    apiKey: jimeng || libtv ? '' : body.api_key || '',
    model: JSON.stringify(body.model || []),
    priority: body.priority || 0,
    isActive: true,
    settings: temperature !== null || comfyui ? JSON.stringify({ ...(temperature !== null ? { temperature } : {}), ...(comfyui ? { comfyui } : {}) }) : null,
    createdAt: ts,
    updatedAt: ts,
  })

  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, getInsertId(res)))

  return created(c, withParsedFields(row))
})

// POST /ai-configs/test
app.post('/test', async (c) => {
  const body = await c.req.json()
  if (body.service_type === 'video' && String(body.provider).toLowerCase() === 'libtv') {
    if (!libtvPrivateAccess(c)) return denyLibTVAccess(c)
    const result = { method: 'CLI', url: '', response_preview: '' }
    try {
      await checkLibTVConnection()
      return success(c, { ...result, ok: true, reachable: true, message: 'LibTV 官方 CLI 已登录，画布可访问' })
    } catch (error) {
      return success(c, { ...result, ok: false, reachable: false,
        message: error instanceof LibTVCliError ? error.message : 'LibTV 官方 CLI 连接检查失败' })
    }
  }
  if (body.service_type === 'video' && String(body.provider).toLowerCase() === 'jimeng') {
    try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
    const account = await publicJimengAccount()
    return success(c, { ok: account.authenticated, reachable: account.available, method: 'CLI', url: '',
      message: account.authenticated ? '已连接即梦账号' : account.message || '请先授权即梦账号', response_preview: '' })
  }
  if (!body.service_type || !body.provider || !body.base_url) {
    return badRequest(c, '需要 service_type、provider 与 base_url')
  }
  if (!isOfficialProvider(body.service_type, body.provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const model = Array.isArray(body.model) ? body.model[0] : body.model
  if (body.provider === 'comfyui') {
    try {
      const comfyui = body.comfyui ? validateComfySettings(body.comfyui) : undefined
      const message = await checkComfyWorkflow({ baseUrl: body.base_url, apiKey: body.api_key || '', model, comfyui }, body.service_type)
      return success(c, { ok: true, reachable: true, status: 200, method: 'GET', url: `${body.base_url}/object_info`, message, response_preview: '' })
    } catch (error: any) {
      return success(c, { ok: false, reachable: false, method: 'GET', url: body.base_url, message: error.message, response_preview: '' })
    }
  }
  const probe = buildProbe(body.service_type, body.provider, body.base_url, model, body.api_key)
  const probeUrl = redactUrl(probe.url)

  logTaskProgress('AIConfig', 'probe-start', {
    serviceType: body.service_type,
    provider: body.provider,
    method: probe.method,
    url: probeUrl,
  })

  try {
    const resp = await withApiCallContext({ provider: body.provider.toLowerCase(), category: body.service_type, model }, () =>
      fetch(probe.url, {
        method: probe.method,
        headers: probe.headers,
        body: probe.body ? JSON.stringify(probe.body) : undefined,
      }),
    )
    const text = await resp.text()
    const reachable = [200, 204, 400, 401, 403].includes(resp.status)
    const isVideoListProbe = ['volcengine', 'aicost'].includes(body.provider.toLowerCase()) && body.service_type === 'video'
    const payload = {
      ok: resp.ok,
      reachable,
      status: resp.status,
      status_text: resp.statusText,
      method: probe.method,
      url: probeUrl,
      message: resp.ok
        ? (isVideoListProbe ? '连接与 API Key 验证通过（只读查询，未生成视频；模型生成权限尚未验证）' : '端点可访问，认证与路径基本正常')
        : resp.status === 401
          ? '认证失败，请检查 API Key；Agent Plan 需使用专属 API Key'
          : resp.status === 403
            ? '访问被拒绝，请检查 API Key 权限和套餐权限'
            : resp.status === 400
              ? '请求被拒绝，请查看接口返回的具体错误'
              : '测试未通过，请检查 Base URL、代理、额度或接口返回的错误',
      // 查询结果可能包含历史任务和媒体地址，连接成功时无需展示。
      response_preview: resp.ok && isVideoListProbe ? '' : text.slice(0, 240),
    }
    if (resp.ok) {
      logTaskSuccess('AIConfig', 'probe-done', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    } else {
      logTaskError('AIConfig', 'probe-unexpected', {
        provider: body.provider,
        status: resp.status,
        url: probeUrl,
      })
    }
    return success(c, payload)
  } catch (error: any) {
    logTaskError('AIConfig', 'probe-failed', {
      provider: body.provider,
      url: probeUrl,
      error: error.message,
    })
    return success(c, {
      ok: false,
      reachable: false,
      method: probe.method,
      url: probeUrl,
      message: error.message || '请求失败',
      response_preview: '',
    })
  }
})

// GET /ai-configs/:id
app.get('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!row) return notFound(c)
  return success(c, withParsedFields(row))
})

// PUT /ai-configs/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [existing] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, id))
  if (!existing) return notFound(c)

  const serviceType = 'service_type' in body ? body.service_type : existing.serviceType
  const provider = 'provider' in body ? body.provider : existing.provider
  if (!isOfficialProvider(serviceType, provider)) {
    return badRequest(c, '不支持的 service_type/provider')
  }

  const updates: Record<string, any> = { updatedAt: now() }

  if ('service_type' in body) updates.serviceType = body.service_type
  if ('provider' in body) updates.provider = body.provider
  if ('name' in body) updates.name = body.name
  if ('base_url' in body) updates.baseUrl = body.base_url
  if ('api_key' in body) updates.apiKey = body.api_key
  if ('model' in body) updates.model = JSON.stringify(body.model)
  const jimeng = String(provider).toLowerCase() === 'jimeng'
  if (jimeng || existing.provider === 'jimeng') {
    try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
  }
  if (jimeng) {
    const models = 'model' in body ? body.model : JSON.parse(existing.model || '[]')
    if (!isJimengModelList(models)) return badRequest(c, '请选择已支持的即梦 Seedance 模型')
    updates.provider = 'jimeng'
    updates.baseUrl = ''
    updates.apiKey = ''
  }
  const libtv = String(provider).toLowerCase() === 'libtv'
  if ((libtv || existing.provider === 'libtv') && !libtvPrivateAccess(c)) return denyLibTVAccess(c)
  if (libtv) {
    const models = 'model' in body ? body.model : JSON.parse(existing.model || '[]')
    if (!isLibTVModelList(models)) return badRequest(c, '请选择 LibTV 支持的 Seedance 2.5 模型')
    updates.provider = 'libtv'
    updates.baseUrl = ''
    updates.apiKey = ''
  }
  if ('priority' in body) updates.priority = body.priority
  if ('is_active' in body) updates.isActive = body.is_active
  if ('temperature' in body) {
    let temperature: number | null
    try {
      temperature = normalizeTemperature(body.temperature)
    } catch {
      return badRequest(c, 'temperature 须为 0 到 2 之间的数字')
    }
    // 与已有 settings 合并，清空的 temperature 从 JSON 中移除
    let settings: Record<string, any> = {}
    try { settings = existing.settings ? JSON.parse(existing.settings) : {} } catch { settings = {} }
    if (temperature === null) delete settings.temperature
    else settings.temperature = temperature
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }
  if ('comfyui' in body) {
    let settings: Record<string, any> = {}
    try { settings = JSON.parse(('settings' in updates ? updates.settings : existing.settings) || '{}') || {} } catch {}
    try {
      if (body.comfyui == null) delete settings.comfyui
      else settings.comfyui = validateComfySettings(body.comfyui)
    } catch (error: any) { return badRequest(c, error.message) }
    updates.settings = Object.keys(settings).length ? JSON.stringify(settings) : null
  }

  await db.update(schema.aiServiceConfigs).set(updates).where(eq(schema.aiServiceConfigs.id, id))
  return success(c)
})

function isJimengModelList(models: unknown) {
  return Array.isArray(models) && models.length > 0 && models.every(model => jimengVideoModels.includes(model))
}

// DELETE /ai-configs/:id
app.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const configs = schema.aiServiceConfigs
  const existing = db.select({ provider: configs.provider, serviceType: configs.serviceType }).from(configs).where(eq(configs.id, id)).get()
  if (!existing) return success(c)
  const { provider, serviceType } = existing
  if (provider === 'jimeng') {
    try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
  }
  if (provider === 'libtv' && !hasLoopbackAccess(c) && !trustedSiteLoginScope(c)) return denyLibTVAccess(c)
  if (serviceType === 'video' && (provider === 'jimeng' || provider === 'libtv')) {
    const other = db.select({ id: configs.id }).from(configs).where(and(
      eq(configs.provider, provider), eq(configs.serviceType, serviceType), ne(configs.id, id),
    )).get()
    if (!other) {
      const fetchSite = c.req.header('Sec-Fetch-Site')
      if (fetchSite && fetchSite !== 'same-origin') return c.json({ code: 403, message: '请在站内删除视频服务' }, 403)
      try {
        await (provider === 'libtv' ? disconnectLibTVAccount() : disconnectJimengAccount())
      } catch (error) {
        if (!(error instanceof JimengCliError || error instanceof LibTVCliError)) throw error
        const status = error.reason === 'account_busy' ? 409 : 502
        return c.json({ code: status, message: error.message }, status)
      }
    }
  }
  db.delete(configs).where(and(eq(configs.id, id), eq(configs.serviceType, serviceType),
    provider === null ? isNull(configs.provider) : eq(configs.provider, provider),
  )).run()
  return success(c)
})

// GET /ai-providers
export const aiProviders = new Hono()
aiProviders.get('/', async (c) => {
  const rows = await db.select().from(schema.aiServiceProviders)
  const parsed = rows.map(r => ({
    ...toSnakeCase(r),
    preset_models: r.presetModels ? JSON.parse(r.presetModels) : [],
  }))
  return success(c, parsed)
})

export default app
