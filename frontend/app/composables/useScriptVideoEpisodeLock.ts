import { onBeforeUnmount, onMounted, readonly, shallowRef } from 'vue'
import { scriptVideoRequest } from '../utils/scriptVideoClient'

type Occupation = { expiresAt: number; count?: number }
type Episode = { projectId: string; episodeId: string }
type Roster = Record<string, Occupation>
const HEARTBEAT_MS = 8_000
const ROSTER_MS = 10_000
const TIMEOUT_MS = 4_500

// Presence is advisory. The selected episode belongs to this page even while
// its heartbeat is delayed, the browser is offline, or the server restarts.
export function useScriptVideoEpisodeLock() {
  const active = shallowRef<Episode | null>(null)
  const occupied = shallowRef<Roster>({})
  let project = ''
  let closed = false
  let suspended = false
  let rosterVersion = 0
  let rosterAt = -Infinity
  let fetchingRoster: Promise<void> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval>
  let rosterTimer: ReturnType<typeof setInterval>
  let presenceWrite = Promise.resolve()

  function owns(projectId: string, episodeId: string) {
    return active.value?.projectId === projectId && active.value.episodeId === episodeId
  }
  function write(episode: Episode, method: 'POST' | 'DELETE', keepalive = false) {
    presenceWrite = presenceWrite.then(async () => {
      if (method === 'POST' && (closed || suspended || !owns(episode.projectId, episode.episodeId))) return
      if (method === 'DELETE' && !keepalive && owns(episode.projectId, episode.episodeId)) return
      const path = `/projects/${encodeURIComponent(episode.projectId)}/episodes/${encodeURIComponent(episode.episodeId)}/lock`
      await scriptVideoRequest(path, method, undefined, AbortSignal.timeout(TIMEOUT_MS), { keepalive })
    }).catch(() => {})
  }
  function heartbeat() {
    if (active.value && !suspended && !closed && !document.hidden) write(active.value, 'POST')
  }
  function refresh(force = false): Promise<void> {
    if (!project || closed || suspended || document.hidden) return Promise.resolve()
    if (fetchingRoster) return fetchingRoster
    if (!force && Date.now() - rosterAt < 1000) return Promise.resolve()
    rosterAt = Date.now()
    const version = rosterVersion
    const pending = scriptVideoRequest<Roster>(`/projects/${encodeURIComponent(project)}/episode-locks`, 'GET', undefined, AbortSignal.timeout(TIMEOUT_MS))
      .then(roster => { if (!closed && version === rosterVersion) occupied.value = roster })
      .catch(() => {}).finally(() => { if (fetchingRoster === pending) fetchingRoster = undefined })
    fetchingRoster = pending
    return pending
  }
  function watchProject(projectId: string) {
    if (project === projectId) return
    project = projectId
    rosterVersion++
    fetchingRoster = undefined
    occupied.value = {}
    void refresh(true)
  }
  function enter(projectId: string, episodeId: string) {
    if (owns(projectId, episodeId)) return
    const previous = active.value
    active.value = { projectId, episodeId }
    if (previous) write(previous, 'DELETE')
    heartbeat()
  }
  function leave() {
    const previous = active.value
    active.value = null
    if (previous) write(previous, 'DELETE')
  }
  function resume() {
    suspended = false
    heartbeat()
    void refresh(true)
  }
  function hide() {
    suspended = true
    if (active.value) write(active.value, 'DELETE', true)
  }
  function visibility() { if (!document.hidden) resume() }
  onMounted(() => {
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS)
    rosterTimer = setInterval(() => { void refresh() }, ROSTER_MS)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', visibility)
  })
  onBeforeUnmount(() => {
    closed = true
    clearInterval(heartbeatTimer)
    clearInterval(rosterTimer)
    window.removeEventListener('pagehide', hide)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', visibility)
    leave()
  })
  return { active: readonly(active), occupied: readonly(occupied), owns, enter, leave, watchProject, refresh }
}
