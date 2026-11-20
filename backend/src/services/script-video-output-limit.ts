import { createHash } from 'node:crypto'

type ModelEndpoint = { provider: string; baseURL: string; model: string; apiKey: string }
const cache = new Map<string, { expires: number; value: Promise<number | undefined> }>()
const cacheLifetimeMs = 15 * 60_000
const maxMetadataBytes = 4 * 1024 * 1024

// The synchronous (non-batch) limit published for these exact model IDs.
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
// https://openrouter.ai/anthropic/claude-haiku-5.5
// https://api-docs.deepseek.com/api/list-models/
// https://nuxt.302.ai/product/detail/deepseek-v4.1-flash
const publishedLimits = new Map([
  ['claude-haiku-5-5', 128000],
  ['anthropic.claude-haiku-5-5', 128000],
  ['anthropic/claude-haiku-5.5', 128000],
  ['deepseek-flash', 393216],
  ['deepseek-v4-pro', 393216],
  ['deepseek-v4.1-flash', 393216],
])

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function modelLimit(value: unknown, model: string, gemini: boolean, direct: boolean) {
  const response = asRecord(value)
  const rows = response.data ?? response.models ?? value
  const list = Array.isArray(rows) ? rows : [rows]
  const wanted = gemini && !model.includes('/') ? 'models/' + model : model
  for (const item of list) {
    const row = asRecord(item)
    const id = gemini ? row.name ?? row.id : row.id ?? row.model
    // A model-specific GET can omit the ID. A catalog entry must identify itself.
    if (id !== wanted && !(direct && !Array.isArray(rows) && id === undefined)) continue
    const max = [row.outputTokenLimit, row.max_output_tokens, row.maxOutputTokens,
      row.max_completion_tokens, asRecord(row.top_provider).max_completion_tokens]
      .filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
    if (max.length) return Math.min(...max)
  }
}

async function readModelMetadata(response: Response): Promise<unknown> {
  if (!response.body) return undefined
  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxMetadataBytes) {
        await reader.cancel()
        return undefined
      }
      chunks.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
  } finally {
    reader.releaseLock()
  }
}

async function lookup(config: ModelEndpoint, transport: typeof fetch): Promise<number | undefined> {
  const gemini = config.provider.toLowerCase() === 'gemini'
  const url = new URL(config.baseURL)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
  const basePath = url.pathname.replace(/\/+$/, '')
  const segments = config.model.split('/')
  if (segments.some(s => !s || s === '.' || s === '..')) return
  const modelPath = gemini && segments.length > 1
    ? segments.map(encodeURIComponent).join('/')
    : 'models/' + encodeURIComponent(config.model)
  const catalogFirst = !gemini && ['openrouter.ai', 'eu.openrouter.ai', 'api.deepseek.com'].includes(url.hostname)
  const signal = AbortSignal.timeout(2_000)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (config.apiKey) {
    if (gemini) headers['x-goog-api-key'] = config.apiKey
    else headers.Authorization = 'Bearer ' + config.apiKey
  }
  const paths = catalogFirst ? ['models'] : [modelPath, 'models']
  for (const path of paths) {
    url.pathname = basePath + '/' + path
    const response = await transport(url, { method: 'GET', headers, redirect: 'error', signal })
    if (response.ok) {
      const limit = modelLimit(await readModelMetadata(response), config.model, gemini, path !== 'models')
      if (limit !== undefined) return limit
      continue
    }
    await response.body?.cancel()
    if (response.status !== 404 && response.status !== 405) break
  }
}

/** The metadata GET is optional. Cache successful, unavailable and pending
 * lookups per provider account so outlines, tools and repairs share them. */
export function resolveScriptVideoOutputLimit(config: ModelEndpoint, transport: typeof fetch = fetch) {
  const key = createHash('sha256').update(JSON.stringify([config.provider, config.baseURL, config.model, config.apiKey])).digest('hex')
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.value
  cache.delete(key)
  if (cache.size >= 128) cache.delete(cache.keys().next().value!)
  const value = lookup(config, transport).catch(() => undefined)
    .then(limit => limit ?? publishedLimits.get(config.model))
  cache.set(key, { expires: now + cacheLifetimeMs, value })
  return value
}
