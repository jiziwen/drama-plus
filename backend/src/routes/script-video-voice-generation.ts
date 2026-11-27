import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, max } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { checkFfmpegSuite } from '../utils/ffmpeg.js'
import { created, success } from '../utils/response.js'
import { generateVideo } from '../services/generation.js'
import { getJimengVideoModels, withJimengAccount } from '../services/jimeng-cli.js'
import { JIMENG_SEEDANCE_20_MINI_MODEL } from '../services/jimeng-video-models.js'
import { libtvHasSeedance20Mini, withLibTVAccount } from '../services/libtv-cli.js'
import { LIBTV_SEEDANCE_20_MINI_MODEL } from '../services/libtv-video-models.js'
import { ScriptVideoStoreError, type ScriptVideoStore } from '../services/script-video-store.js'
import { extractScriptVideoVoiceDescription } from '../services/script-video-voice-description.js'
import type { ScriptVideoVoiceDescription } from '../services/script-video-types.js'
import { generatedVoiceAudio, generatedVoiceVideoUrl, isScriptVideoVoiceModel, scriptVideoVoiceParam, scriptVideoVoicePrompt, scriptVideoVoiceRequest } from '../services/script-video-voice-generation.js'
import { safeTaskError } from '../services/video-download.js'
import { resolveVideoCliAccountId } from '../services/video-cli-accounts.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess } from '../utils/private-access.js'

const voiceDuration = 5
const descriptionRequestSchema = z.object({ episodeId: z.string().trim().min(1).max(100).optional() })
const voiceGenerationSchema = z.object({
  configId: z.number().int().positive(),
  model: z.enum([JIMENG_SEEDANCE_20_MINI_MODEL, LIBTV_SEEDANCE_20_MINI_MODEL]),
  description: z.string().trim().min(1).max(500),
  dialogue: z.string().trim().min(1).max(80),
})

const configs = schema.aiServiceConfigs
const enabledVideoCli = and(eq(configs.serviceType, 'video'), eq(configs.isActive, true), inArray(configs.provider, ['jimeng', 'libtv']))
const configFields = { id: configs.id, provider: configs.provider, name: configs.name, accountId: configs.videoCliAccountId }
type VoiceConfig = Pick<typeof configs.$inferSelect, 'id' | 'provider' | 'name'> & { accountId: string | null }

function requireVoiceGenerationAccess(c: Context) {
  if (!hasLoopbackAccess(c) && !hasPrivateGatewayAccess(c))
    throw new ScriptVideoStoreError('角色声音生成需通过本机或已配置的 HTTPS 私有网关使用', 403, 'FORBIDDEN')
}

async function voiceGenerationOption(config: VoiceConfig) {
  const jimeng = config.provider === 'jimeng'
  const provider = jimeng ? 'jimeng' : 'libtv'
  const providerName = jimeng ? '即梦积分' : 'LibTV'
  const resolution = jimeng ? '720p' : '480p'
  const accountId = resolveVideoCliAccountId(provider, config.accountId ?? undefined)
  const model = jimeng ? JIMENG_SEEDANCE_20_MINI_MODEL : LIBTV_SEEDANCE_20_MINI_MODEL
  const available = jimeng
    ? await withJimengAccount(accountId, async () => (await getJimengVideoModels()).some(item => item.id === model))
    : await withLibTVAccount(accountId, () => libtvHasSeedance20Mini(voiceDuration, resolution))
  if (!available) return
  return { configId: config.id, model, label: config.name && config.name !== providerName ? `${providerName} · ${config.name}` : providerName, accountId, resolution }
}

export function registerScriptVideoVoiceGenerationRoutes(
  routes: Hono, store: ScriptVideoStore, respondError: (c: Context, error: unknown) => Response,
) {
  const descriptionRequests = new Map<string, Promise<ScriptVideoVoiceDescription>>()

  routes.post('/projects/:id/assets/:assetId/voice-description', async c => {
    try {
      requireVoiceGenerationAccess(c)
      const parsed = descriptionRequestSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new ScriptVideoStoreError('角色声音描述请求无效')
      const projectId = c.req.param('id')
      const assetId = c.req.param('assetId')
      const project = await store.summary(projectId)
      const asset = project.assets.find(item => item.id === assetId && item.kind === 'character')
      if (!asset) throw new ScriptVideoStoreError('角色资产不存在', 404, 'NOT_FOUND')
      if (asset.voiceDescription) return success(c, asset.voiceDescription)

      const key = `${projectId}/${assetId}`
      let pending = descriptionRequests.get(key)
      if (!pending) {
        pending = (async () => {
          const source = await store.get(projectId)
          const current = source.assets.find(item => item.id === assetId && item.kind === 'character')
          if (!current) throw new ScriptVideoStoreError('角色资产不存在', 404, 'NOT_FOUND')
          if (current.voiceDescription) return current.voiceDescription
          const description = await extractScriptVideoVoiceDescription(source, current, parsed.data.episodeId)
          return store.saveCharacterVoiceDescription(projectId, assetId, description, true)
        })().finally(() => { descriptionRequests.delete(key) })
        descriptionRequests.set(key, pending)
      }
      return success(c, await pending)
    } catch (error) { return respondError(c, error) }
  })

  routes.get('/projects/:id/assets/voice-generation-models', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      requireVoiceGenerationAccess(c)
      await store.summary(c.req.param('id'))
      const rows = db.select(configFields).from(configs).where(enabledVideoCli)
        .orderBy(desc(eq(configs.provider, 'jimeng')), desc(configs.priority), configs.id).all()
      const checks = await Promise.allSettled(rows.map(voiceGenerationOption))
      const options = checks.flatMap(check => {
        if (check.status !== 'fulfilled' || !check.value) return []
        const { configId, model, label, resolution } = check.value
        return [{ configId, model, label, resolution }]
      })
      const message = !rows.length ? '请在模型设置中启用即梦积分或 LibTV 视频服务。' :
        checks.some(check => check.status === 'rejected') ? '部分账号的模型目录暂时无法读取，请在模型设置中检查授权后刷新。' :
          options.length ? undefined : '当前账号的模型目录未提供 Seedance 2.0 Mini。'
      return success(c, { options, message })
    } catch (error) { return respondError(c, error) }
  })

  routes.post('/projects/:id/assets/:assetId/voice-generation', async c => {
    try {
      requireVoiceGenerationAccess(c)
      const parsed = voiceGenerationSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        throw new ScriptVideoStoreError('请选择 Seedance 2.0 Mini，并填写声音描述（最多 500 字）和试音台词（最多 80 字）')
      const projectId = c.req.param('id')
      const assetId = c.req.param('assetId')
      const project = await store.summary(projectId)
      const asset = project.assets.find(item => item.id === assetId && item.kind === 'character')
      if (!asset) throw new ScriptVideoStoreError('角色资产不存在', 404, 'NOT_FOUND')
      const { configId, model, description, dialogue } = parsed.data
      const config = db.select(configFields).from(configs).where(and(eq(configs.id, configId), enabledVideoCli)).get()
      if (!config || !isScriptVideoVoiceModel(config.provider ?? '', model))
        throw new ScriptVideoStoreError('请选择已启用的即梦积分或 LibTV Seedance 2.0 Mini 服务')
      if (!(await checkFfmpegSuite()).ffmpeg)
        throw new ScriptVideoStoreError('服务端 FFmpeg 不可用，无法提取角色声音', 503, 'FFMPEG_UNAVAILABLE')
      const option = await voiceGenerationOption(config).catch(error => {
        throw new ScriptVideoStoreError(safeTaskError(error), 502, 'VOICE_MODEL_LOOKUP_FAILED')
      })
      if (!option) throw new ScriptVideoStoreError('所选账号当前未提供 Seedance 2.0 Mini')
      await store.saveCharacterVoiceDescription(projectId, assetId, { text: description, sourceLabel: '手动编辑' })
      const id = await generateVideo({
        configId, model, prompt: scriptVideoVoicePrompt(description, dialogue), referenceMode: 'text',
        duration: voiceDuration, aspectRatio: '16:9', resolution: option.resolution, generateAudio: true,
        videoCliAccountId: option.accountId, allowJimeng: config.provider === 'jimeng', allowLibTV: config.provider === 'libtv',
        scriptVideoVoice: {
          projectId, assetId, outputId: randomUUID(),
          name: `${Array.from(asset.name).slice(0, 100).join('')}试音.mp3`,
          expectedUrl: asset.voiceAudio?.url ?? null,
        },
      }).catch(error => {
        if (error instanceof ScriptVideoStoreError) throw error
        throw new ScriptVideoStoreError(safeTaskError(error))
      })
      return created(c, { id, assetId, status: 'processing' })
    } catch (error) { return respondError(c, error) }
  })

  routes.get('/projects/:id/assets/voice-generations', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      const project = await store.summary(c.req.param('id'))
      const task = schema.sysTask
      const assetIds = new Set(project.assets.filter(asset => asset.kind === 'character').map(asset => asset.id))
      const latest = db.select({ id: max(task.id) }).from(task)
        .where(and(eq(task.type, 'video'), eq(scriptVideoVoiceParam('projectId'), project.id)))
        .groupBy(scriptVideoVoiceParam('assetId'))
      const records = db.select({ id: task.id, status: task.status, params: task.params, localPath: task.localPath, error: task.errorMsg })
        .from(task).where(inArray(task.id, latest)).orderBy(desc(task.id)).all()
      return success(c, records.flatMap(record => {
        const owner = scriptVideoVoiceRequest(record.params)
        if (!owner || !assetIds.has(owner.assetId)) return []
        const job = { id: record.id, assetId: owner.assetId, videoUrl: generatedVoiceVideoUrl(record.localPath) }
        if (record.status === 'completed') return [{ ...job, status: 'completed', voiceAudio: generatedVoiceAudio(owner) }]
        if (record.status === 'processing') return [{ ...job, status: 'processing' }]
        return [{ ...job, status: 'failed', error: record.error || '角色声音生成失败' }]
      }))
    } catch (error) { return respondError(c, error) }
  })
}
