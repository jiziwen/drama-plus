import { onBeforeUnmount, onMounted, readonly, shallowRef } from 'vue'
import { canReconnectScriptVideoSession, ScriptVideoRequestError, scriptVideoRequest } from '../utils/scriptVideoClient'

type LockExpiration = { expiresAt: number }
type EpisodeLocks = Record<string, LockExpiration>
type EpisodeLease = LockExpiration & { projectId: string; episodeId: string }

const LEASE_MS = 30_000
const RENEW_MS = 8_000
const REFRESH_MS = 10_000
const MIN_REFRESH_MS = 1_000
const REQUEST_TIMEOUT_MS = 4_500
const LOST_MESSAGE = '分集编辑权限已失效，请重新进入'

function lockPath(projectId: string, episodeId: string) {
  return `/projects/${encodeURIComponent(projectId)}/episodes/${encodeURIComponent(episodeId)}/lock`
}

function release(lease: EpisodeLease, keepalive = false) {
  return scriptVideoRequest(
    lockPath(lease.projectId, lease.episodeId), 'DELETE', undefined, AbortSignal.timeout(REQUEST_TIMEOUT_MS), { keepalive },
  ).catch(() => {})
}

export function useScriptVideoEpisodeLock(options: {
  onLost: (lease: EpisodeLease, message: string) => void
  canReleaseOnPageHide?: (lease: EpisodeLease) => boolean
}) {
  const active = shallowRef<EpisodeLease | null>(null)
  const occupied = shallowRef<EpisodeLocks>({})
  let watchedProject = ''
  let rosterVersion = 0
  let rosterRequest: { version: number; result: Promise<void> } | undefined
  let rosterRequestedAt = -Infinity
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let renewTimer: ReturnType<typeof setTimeout> | undefined
  let expirationTimer: ReturnType<typeof setTimeout> | undefined
  let validUntil = 0
  let queue = Promise.resolve()
  let pending = 0
  let closed = false
  let hidden = false
  let preserveOnPageHide = false

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    pending++
    const result = queue.then(work).finally(() => { pending-- })
    queue = result.then(() => {}, () => {})
    return result
  }

  function clearLease() {
    clearTimeout(renewTimer)
    clearTimeout(expirationTimer)
    validUntil = 0
    active.value = null
  }

  function owns(projectId: string, episodeId: string) {
    return !hidden && Date.now() < validUntil &&
      active.value?.projectId === projectId && active.value.episodeId === episodeId
  }

  function canRefreshRoster() {
    return !!watchedProject && !closed && !hidden && !document.hidden
  }

  function refreshRoster(force = false): Promise<void> {
    if (!canRefreshRoster()) return Promise.resolve()
    if (rosterRequest?.version === rosterVersion) return rosterRequest.result
    const now = Date.now()
    if (!force && now - rosterRequestedAt < MIN_REFRESH_MS) return Promise.resolve()
    rosterRequestedAt = now
    const projectId = watchedProject
    const version = rosterVersion
    const result = scriptVideoRequest<EpisodeLocks>(
      `/projects/${encodeURIComponent(projectId)}/episode-locks`, 'GET', undefined, AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ).then((locks) => {
      if (version === rosterVersion && canRefreshRoster()) occupied.value = locks
    }).catch(() => {}).finally(() => {
      if (rosterRequest?.result === result) rosterRequest = undefined
    })
    rosterRequest = { version, result }
    return result
  }

  function refresh() {
    return refreshRoster()
  }

  function refreshAfterLockChange() {
    // Ignore lists fetched before the mutation, even when they arrive late.
    rosterVersion++
    void refreshRoster(true)
  }

  function updateRosterPolling(force = false) {
    clearInterval(refreshTimer)
    if (!canRefreshRoster()) return
    void refreshRoster(force)
    refreshTimer = setInterval(() => { void refresh() }, REFRESH_MS)
  }

  function watchProject(projectId: string) {
    if (closed || projectId === watchedProject) return
    watchedProject = projectId
    rosterVersion++
    occupied.value = {}
    updateRosterPolling(true)
  }

  function invalidate(projectId: string, episodeId: string, message = LOST_MESSAGE) {
    const lease = active.value
    if (!lease || lease.projectId !== projectId || lease.episodeId !== episodeId) return
    clearLease()
    if (!closed) {
      options.onLost(lease, message)
      refreshAfterLockChange()
    }
  }

  function armLease(lease: EpisodeLease, startedAt: number) {
    clearTimeout(renewTimer)
    clearTimeout(expirationTimer)
    // Use a local deadline from before the request so browser clock skew never
    // makes a lease appear valid longer than the server granted it.
    validUntil = startedAt + LEASE_MS
    active.value = lease
    expirationTimer = setTimeout(() => {
      if (!hidden && active.value === lease && !owns(lease.projectId, lease.episodeId))
        invalidate(lease.projectId, lease.episodeId)
    }, Math.max(0, validUntil - Date.now()))
    scheduleRenew(lease)
  }

  function scheduleRenew(lease: EpisodeLease, delay = RENEW_MS) {
    clearTimeout(renewTimer)
    renewTimer = setTimeout(() => { void renew(lease) }, delay)
  }

  function renew(lease: EpisodeLease) {
    return serialize(async () => {
      if (closed || hidden || active.value !== lease) return
      if (!owns(lease.projectId, lease.episodeId)) {
        invalidate(lease.projectId, lease.episodeId)
        return
      }
      try {
        const startedAt = Date.now()
        const { expiresAt } = await scriptVideoRequest<LockExpiration>(
          lockPath(lease.projectId, lease.episodeId), 'POST', { renew: true }, AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        )
        if (!closed && !hidden && active.value === lease) armLease({ ...lease, expiresAt }, startedAt)
      } catch (error) {
        if (closed || hidden || active.value !== lease) return
        if (error instanceof ScriptVideoRequestError && (error.status === 423 || error.status === 404)) {
          invalidate(lease.projectId, lease.episodeId, error.message)
        } else {
          // Keep current ownership through a brief connection failure and try
          // again sooner. The deadline still applies without a response.
          scheduleRenew(lease, 2_000)
        }
      }
    })
  }

  function enter(projectId: string, episodeId: string): Promise<EpisodeLease> {
    return serialize(async () => {
      if (closed || hidden) throw new Error(LOST_MESSAGE)
      if (owns(projectId, episodeId)) return active.value!
      const startedAt = Date.now()
      let created: LockExpiration
      try {
        created = await scriptVideoRequest<LockExpiration>(
          lockPath(projectId, episodeId), 'POST', undefined, AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        )
      } catch (error) {
        if (error instanceof ScriptVideoRequestError && error.status === 423) refreshAfterLockChange()
        else void refresh()
        throw error
      }
      const lease = { projectId, episodeId, expiresAt: created.expiresAt }
      if (closed || hidden) {
        if (!preserveOnPageHide) await release(lease)
        throw new Error(LOST_MESSAGE)
      }
      const previous = active.value
      armLease(lease, startedAt)
      if (watchedProject === projectId) {
        rosterVersion++
        const next = { ...occupied.value }
        delete next[episodeId]
        occupied.value = next
      }
      if (previous && (previous.projectId !== projectId || previous.episodeId !== episodeId)) await release(previous)
      if (watchedProject === projectId || watchedProject === previous?.projectId) refreshAfterLockChange()
      return lease
    })
  }

  function leave() {
    return serialize(async () => {
      const lease = active.value
      clearLease()
      if (lease) {
        await release(lease)
        refreshAfterLockChange()
      }
    })
  }

  function resume() {
    hidden = false
    preserveOnPageHide = false
    const lease = active.value
    if (lease) {
      if (owns(lease.projectId, lease.episodeId)) void renew(lease)
      else invalidate(lease.projectId, lease.episodeId)
    }
    updateRosterPolling()
  }

  function onVisibilityChange() {
    if (!document.hidden && !hidden) {
      const lease = active.value
      const remaining = validUntil - Date.now()
      if (lease && remaining <= 0) invalidate(lease.projectId, lease.episodeId)
      else if (lease && remaining <= LEASE_MS - RENEW_MS) void renew(lease)
    }
    updateRosterPolling()
  }

  function onFocus() {
    void refresh()
  }

  function pagehide(event: PageTransitionEvent) {
    hidden = true
    // The outgoing document cannot tell reload from close. Keep the short
    // lease so a reload can renew it without racing an old keepalive DELETE.
    preserveOnPageHide = !event.persisted && canReconnectScriptVideoSession()
    rosterVersion++
    clearInterval(refreshTimer)
    const lease = active.value
    if (!preserveOnPageHide && lease && pending === 0 && options.canReleaseOnPageHide?.(lease)) {
      validUntil = 0
      clearTimeout(renewTimer)
      clearTimeout(expirationTimer)
      void serialize(() => release(lease, true))
    }
  }

  onMounted(() => {
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('pageshow', resume)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
  })
  onBeforeUnmount(() => {
    closed = true
    clearInterval(refreshTimer)
    window.removeEventListener('pagehide', pagehide)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    const lease = active.value
    const canRelease = lease && !hidden && (!options.canReleaseOnPageHide || options.canReleaseOnPageHide(lease))
    clearLease()
    if (canRelease) void serialize(() => release(lease))
  })

  return { active: readonly(active), occupied: readonly(occupied), watchProject, refresh, enter, leave, owns, invalidate }
}
