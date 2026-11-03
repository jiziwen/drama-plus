import { createHash } from 'node:crypto'

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function requestFingerprint(value: {
  provider: string; category: string; model?: string | null; taskId?: number | null; dramaId?: number | null
  method: string; url: string; headers?: Record<string, string>; body?: unknown
}) {
  let url = value.url
  try { const parsed = new URL(url); parsed.searchParams.sort(); url = parsed.toString() } catch {}
  const headers = Object.fromEntries(Object.entries(value.headers || {}).map(([key, v]) => [key.toLowerCase(), v]))
  return createHash('sha256').update(JSON.stringify(canonical({ provider: value.provider, category: value.category, method: value.method.toUpperCase(), url, headers,
    model: value.model || null, taskId: value.taskId ?? null, dramaId: value.dramaId ?? null, body: value.body ?? null }))).digest('hex')
}

export function requestParameters(method: string, rawUrl: string) {
  let path = rawUrl
  const query: Record<string, string | string[]> = {}
  const pathParams: Record<string, string> = {}
  try {
    const url = new URL(rawUrl)
    path = url.pathname
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key)
      query[key] = values.length === 1 ? values[0] : values
    }
    const history = path.match(/\/history\/([^/]+)\/?$/)
    const task = path.match(/\/(?:tasks|query|images\/task)\/([^/]+)\/?$/)
    if (history) pathParams.prompt_id = decodeURIComponent(history[1])
    else if (task) pathParams.task_id = decodeURIComponent(task[1])
  } catch {}
  return { method: method.toUpperCase(), path, pathParams, query }
}

export function parseLoggedJson(raw: string | null | undefined): any {
  try { return raw ? JSON.parse(raw) : null } catch { return raw }
}

export function describeLoggedRequest(row: { method: string; url: string; request: string | null }) {
  const original = parseLoggedJson(row.request)
  const params = requestParameters(row.method, row.url)
  if (original?.truncated) return { ...params, ...original }
  return { ...params, headers: original?.headers || {}, body: original?.body ?? null }
}
