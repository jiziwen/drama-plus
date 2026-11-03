import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { db, schema, getInsertId } from '../db/index.js'
import { eq, sql } from 'drizzle-orm'
import { redactUrl } from '../utils/task-logger.js'
import { requestFingerprint, requestParameters } from '../utils/api-call-request.js'

interface CallContext { provider?: string; category?: string; model?: string; taskId?: number; dramaId?: number }
const context = new AsyncLocalStorage<CallContext>()
const LIMIT = 1024 * 1024

export function withApiCallContext<T>(values: CallContext, job: () => T): T {
  return context.run({ ...context.getStore(), ...values }, job)
}

export function bindApiCallFetch(values: CallContext, inner: typeof fetch): typeof fetch {
  return (input, init) => withApiCallContext(values, () => inner(input, init))
}

export function sanitizeCallData(value: any, key = '', depth = 0): any {
  if (depth > 35) return '[内容层级过深]'
  const normalized = key.replace(/[-_]/g, '').toLowerCase()
  if (/apikey|authorization|cookie|secret|password|signature|credential/.test(normalized) || /^(token|accesstoken|refreshtoken)$/.test(normalized)) return '[已隐藏]'
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value) || /^(b64_json|base64|audiohex)$/i.test(key)) return `[二进制编码已省略，${value.length} 字符]`
    if (/^https?:\/\//i.test(value)) return redactUrl(value)
    const safe = value.replace(/https?:\/\/[^\s"'<>]+/gi, redactUrl).replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]').replace(/\bsk-[\w-]+/g, '[已隐藏]')
    return safe.length > LIMIT ? `${safe.slice(0, LIMIT)}\n[内容超过 1MB，已截断]` : safe
  }
  if (Array.isArray(value)) return value.map(v => sanitizeCallData(v, '', depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeCallData(v, k, depth + 1)]))
  return value
}

function serialize(value: unknown) {
  const safe = sanitizeCallData(value)
  const json = JSON.stringify(safe)
  return json.length <= LIMIT ? json : JSON.stringify({ truncated: true, preview: json.slice(0, LIMIT), message: '详情超过 1MB，已截断' })
}

function safeWrite(job: () => void) {
  try { job() } catch (error) { console.warn('[ApiCallLog] 记录写入失败', error instanceof Error ? error.name : 'UnknownError') }
}

function networkFailure(error: any, depth = 0): Record<string, unknown> {
  return {
    message: String(error?.message || error),
    ...(typeof error?.name === 'string' ? { name: error.name } : {}),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(error?.cause && depth < 3 ? { cause: networkFailure(error.cause, depth + 1) } : {}),
  }
}

async function bodySummary(body: BodyInit | null | undefined) {
  if (body == null) return null
  if (typeof body === 'string') {
    try { return JSON.parse(body) } catch { return body }
  }
  if (body instanceof FormData) {
    const entries: Record<string, unknown[]> = {}
    for (const [key, value] of body.entries()) {
      ;(entries[key] ||= []).push(typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size })
    }
    return { contentType: 'multipart/form-data', fields: entries }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body)
  return { binary: true, message: '文件或流内容已省略' }
}

async function requestBodyIdentity(body: BodyInit | null | undefined, summary: unknown) {
  if (body instanceof FormData) {
    const fields = []
    for (const [name, value] of body.entries()) {
      fields.push([name, typeof value === 'string' ? value : { name: value.name, type: value.type, size: value.size,
        content: value.size <= 30 * 1024 * 1024 ? createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex') : randomUUID() }])
    }
    return fields
  }
  if (body instanceof URLSearchParams) return body.toString()
  if (body != null && typeof body !== 'string') return { binary: true, id: randomUUID() }
  return summary
}

async function responseSummary(response: Response) {
  const contentType = response.headers.get('content-type') || ''
  if (!/json|text|xml|event-stream/i.test(contentType)) {
    void response.body?.cancel().catch(() => {})
    return { contentType, size: response.headers.get('content-length'), message: '二进制响应，仅记录文件元信息' }
  }
  const reader = response.body?.getReader()
  if (!reader) return null
  const decoder = new TextDecoder()
  let text = '', bytes = 0, truncated = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > LIMIT) { truncated = true; void reader.cancel().catch(() => {}); break }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  if (truncated) return { truncated: true, contentType, text, message: '响应超过 1MB，已截断' }
  if (contentType.includes('event-stream')) {
    const events = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => {
      const data = line.slice(5).trim()
      try { return JSON.parse(data) } catch { return data }
    })
    return { contentType, events }
  }
  try { return JSON.parse(text) } catch { return text }
}

export const recordedFetch: typeof globalThis.fetch = async (input, init) => {
  const started = Date.now()
  const rawUrl = input instanceof Request ? input.url : String(input)
  const method = init?.method || (input instanceof Request ? input.method : 'GET')
  const meta = context.getStore() || {}
  const comfy = /\/(prompt|history|object_info|system_stats|upload\/image|view)(?:[/?]|$)/.test(rawUrl)
  const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
  let body = await bodySummary(init?.body)
  if (body === null && input instanceof Request && input.body) {
    body = { message: 'Request 流请求体未复制' }
  }
  const provider = meta.provider || (comfy ? 'comfyui' : /minimax/i.test(rawUrl) ? 'minimax' : /volces|volcengine/i.test(rawUrl) ? 'volcengine' : /aliyun|dashscope/i.test(rawUrl) ? 'aliyun' : /googleapis|gemini/i.test(rawUrl) ? 'gemini' : 'openai')
  const category = meta.category || (comfy ? 'comfyui' : /image/i.test(rawUrl) ? 'image' : /video|generation\/tasks/i.test(rawUrl) ? 'video' : 'text')
  const model = meta.model || (body as any)?.model
  const requestKey = requestFingerprint({ provider, category, model, taskId: meta.taskId, dramaId: meta.dramaId,
    method, url: rawUrl, headers: Object.fromEntries(headers),
    body: input instanceof Request && input.body && init?.body == null ? { stream: randomUUID() } : await requestBodyIdentity(init?.body, body) })
  let id: number | undefined
  safeWrite(() => {
    id = getInsertId(db.insert(schema.apiCallLogs).values({
      provider, category, model, taskId: meta.taskId, dramaId: meta.dramaId, requestKey,
      method, url: redactUrl(rawUrl), status: 'pending', request: serialize({ ...requestParameters(method, redactUrl(rawUrl)), headers: Object.fromEntries(headers), body }), createdAt: new Date().toISOString(),
    }).run())
    if (id! % 100 === 0) db.run(sql`DELETE FROM api_call_logs WHERE id NOT IN (SELECT id FROM api_call_logs ORDER BY id DESC LIMIT 5000)`)
  })
  try {
    const response = await globalThis.fetch(input, init)
    if (id) {
      safeWrite(() => { db.update(schema.apiCallLogs).set({ statusCode: response.status }).where(eq(schema.apiCallLogs.id, id!)).run() })
      // Consume only a clone; the SDK retains the original streaming response.
      void responseSummary(response.clone()).then(summary => safeWrite(() => {
        db.update(schema.apiCallLogs).set({ status: response.ok ? 'success' : 'error', durationMs: Date.now() - started,
          response: serialize({ headers: Object.fromEntries(response.headers), body: summary }) }).where(eq(schema.apiCallLogs.id, id!)).run()
      })).catch(error => safeWrite(() => {
        db.update(schema.apiCallLogs).set({ status: 'error', durationMs: Date.now() - started, error: String(error.message) }).where(eq(schema.apiCallLogs.id, id!)).run()
      }))
    }
    return response
  } catch (error: any) {
    if (id) safeWrite(() => { db.update(schema.apiCallLogs).set({ status: 'error', durationMs: Date.now() - started, error: serialize(networkFailure(error)) }).where(eq(schema.apiCallLogs.id, id!)).run() })
    throw error
  }
}
