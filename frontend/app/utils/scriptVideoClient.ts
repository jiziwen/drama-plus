import type { PreviewCard } from './scriptVideoPreview'

export class ScriptVideoRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message)
  }
}
const SESSION_STORAGE_KEY = 'script-video-tab-session'
const SESSION_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
const SESSION_CLAIM_MS = 300
const RELOAD_READY = 'released:'
const LAN_SESSION_ACTIVE = 'active:'

type Session = { id: string; release?: () => void; reloadMarker?: boolean }
type BrowserSession = { active?: Session; pending?: Promise<string>; hidden: boolean }
const browserSessions = new WeakMap<Window, BrowserSession>()

function newSessionId(browser: typeof window) {
  // getRandomValues is also available when using the service over LAN HTTP.
  const bytes = browser.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function claimSession(browser: typeof window, id: string, reusing: boolean): Promise<Session | undefined> {
  const name = `${SESSION_STORAGE_KEY}:${id}`
  const locks = browser.navigator?.locks
  if (locks) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), SESSION_CLAIM_MS)
    try {
      return await new Promise<Session>((resolve, reject) => {
        void locks.request(name, { signal: controller.signal }, () => new Promise<void>(release => {
          clearTimeout(timeout)
          resolve({ id, release })
        })).catch(reject)
      })
    } catch {
      if (controller.signal.aborted) return undefined
    } finally {
      clearTimeout(timeout)
    }
  }

  // Web Locks requires a secure context. Coordinate reloads over LAN HTTP with a channel.
  if (!browser.BroadcastChannel) return undefined
  try {
    const channel = new browser.BroadcastChannel(name)
    const session = { id, release: () => channel.close(), reloadMarker: true }
    return await new Promise<Session | undefined>(resolve => {
      let claiming = reusing
      const timer = reusing ? setTimeout(() => {
        claiming = false
        resolve(session)
      }, SESSION_CLAIM_MS) : undefined
      channel.onmessage = ({ data }) => {
        if (data === 'probe') channel.postMessage('claimed')
        if (claiming && (data === 'probe' || data === 'claimed')) {
          clearTimeout(timer)
          session.release()
          resolve(undefined)
        }
      }
      if (reusing) channel.postMessage('probe')
      else resolve(session)
    })
  } catch {
    return undefined
  }
}

async function openBrowserSession(browser: typeof window, previous?: Session): Promise<Session> {
  let storage: Storage | undefined
  let savedId = previous?.id
  try {
    storage = browser.sessionStorage
    const navigation = browser.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined
    if (navigation?.type === 'reload' && !savedId) {
      const stored = storage.getItem(SESSION_STORAGE_KEY)
      // LAN tabs can be suspended and miss the probe. A cloned live tab's
      // snapshot has no release marker from the original document.
      if (stored?.startsWith(RELOAD_READY)) savedId = stored.slice(RELOAD_READY.length)
      else if (browser.navigator?.locks) savedId = stored || undefined
    }
  } catch {
    // Storage can be disabled, in which case every document gets a distinct session.
    storage = undefined
  }
  if (storage) {
    const saved = savedId && SESSION_ID_PATTERN.test(savedId) ? await claimSession(browser, savedId, true) : undefined
    const id = saved?.id ?? newSessionId(browser)
    const session = saved ?? await claimSession(browser, id, false)
    if (session) {
      try {
        storage.setItem(SESSION_STORAGE_KEY, session.reloadMarker ? LAN_SESSION_ACTIVE + id : id)
        return session
      } catch {
        session.release?.()
      }
    }
    return { id }
  }
  return { id: newSessionId(browser) }
}

export function scriptVideoSession(): string | Promise<string> | undefined {
  if (typeof window === 'undefined') return undefined
  const browser = window
  let context = browserSessions.get(browser)
  if (!context) {
    const state: BrowserSession = { hidden: false }
    browserSessions.set(browser, state)
    browser.addEventListener('pagehide', () => {
      state.hidden = true
      if (state.active?.reloadMarker) {
        try { browser.sessionStorage.setItem(SESSION_STORAGE_KEY, RELOAD_READY + state.active.id) }
        catch { /* A blocked storage write still allows the tab to close. */ }
      }
      state.active?.release?.()
    }, true)
    browser.addEventListener('pageshow', () => {
      if (!state.hidden) return
      state.hidden = false
      if (state.active?.release) state.pending = undefined
    }, true)
    context = state
  }
  if (context.active && (context.hidden || context.pending)) return context.active.id
  const state = context
  if (!state.pending) {
    const previous = state.active
    state.active = undefined
    state.pending = openBrowserSession(browser, previous).then(session => {
      state.active = session
      if (state.hidden) session.release?.()
      return session.id
    })
  }
  return state.pending
}

export function canReconnectScriptVideoSession() {
  return typeof window !== 'undefined' && !!browserSessions.get(window)?.active?.release
}

export async function scriptVideoRequest<T = any>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
  options?: { keepalive?: boolean },
): Promise<T> {
  const identity = scriptVideoSession()
  const session = typeof identity === 'string' ? identity : await identity
  const response = await fetch(`/api/v1/script-video${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { 'X-Script-Video-Session': session } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal,
    keepalive: options?.keepalive,
  })
  const json = await response
    .json()
    .catch(() => ({ message: '服务返回了无法识别的结果' }))
  if (!response.ok || Number(json.code) >= 400)
    throw new ScriptVideoRequestError(
      json.message || '请求失败',
      response.status,
      json.errorCode || json.data?.code,
    )
  return json.data ?? json
}
export type ScriptVideoJobProgress = {
  phase: 'generating' | 'validating' | 'repairing'
  completed: number
  total: number
  currentCardId?: string
  repairAttempts?: number
  segmentRepairAttempts?: number
  batchSize?: number
}
export type ScriptVideoClientJob = {
  id: string
  action?: 'outline' | 'storyboard' | 'revisions' | 'review' | 'video'
  cardId?: string
  updatedAt?: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  progress?: ScriptVideoJobProgress
  result?: any
  error?: string
  code?: string
  issues?: { code: string; message: string }[]
}
export type ScriptVideoRevisionCandidate = { card: PreviewCard; summary: string; baseCardVersion?: number }
export function scriptVideoJobError(job: ScriptVideoClientJob): string {
  const summary = job.error?.trim() || 'AI 任务未完成，原版本已保留'
  const details = (job.issues || []).map(issue => issue.message.trim())
    .filter(message => message && !summary.includes(message))
  return [summary, ...new Set(details)].join('\n')
}
export async function waitScriptVideoJob(
  projectId: string,
  jobId: string,
  signal?: AbortSignal,
  onProgress?: (progress: ScriptVideoJobProgress, status: ScriptVideoClientJob['status'], job: ScriptVideoClientJob) => void,
): Promise<ScriptVideoClientJob> {
  while (!signal?.aborted) {
    const job = await scriptVideoRequest<ScriptVideoClientJob>(
      `/projects/${projectId}/jobs/${jobId}`,
      'GET',
      undefined,
      signal,
    )
    signal?.throwIfAborted()
    if (job.progress) onProgress?.(job.progress, job.status, job)
    if (job.status === 'canceled') throw new DOMException(job.error || '生成已取消', 'AbortError')
    if (job.status === 'failed') throw new Error(scriptVideoJobError(job))
    if (job.status === 'completed') return job
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, 1000)
      function abort() {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  throw new DOMException('Aborted', 'AbortError')
}
