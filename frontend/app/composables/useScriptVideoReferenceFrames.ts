import { computed, onScopeDispose, ref, shallowRef, toRaw, watch } from 'vue'
import { updateScriptVideoReferenceChoice, validScriptVideoFrameTime } from '../../../backend/src/services/script-video-reference-settings'
import type { ScriptVideoFrameChoice, ScriptVideoReferenceFrameRow, ScriptVideoReferenceFrames, ScriptVideoReferenceSettings } from '../../../backend/src/services/script-video-reference-settings'

type Scope = { projectId: string; episodeId: string; card: { id: string; version?: number; referenceFrameSettings?: ScriptVideoReferenceSettings } }
type Request = (path: string, body: object, signal: AbortSignal) => Promise<ScriptVideoReferenceFrames>
export type FrameSelection = 'auto' | 'off' | 'manual'
export type FrameSource = NonNullable<ScriptVideoReferenceFrames['projectSources']>[number]

export function useScriptVideoReferenceFrames(
  current: () => Scope | undefined, sourceRevision: () => string,
  save: (projectId: string) => Promise<void>, request: Request,
) {
  const frames = shallowRef<ScriptVideoReferenceFrames>()
  const loading = ref(false), changing = ref(false), error = ref('')
  let reader: AbortController | undefined, writer: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sourceVersion = 0
  let refreshQueued = false
  const path = computed(() => {
    const scope = current()
    return scope ? `/projects/${scope.projectId}/episodes/${scope.episodeId}/cards/${scope.card.id}/reference-frames` : ''
  })

  async function load(saveFirst: boolean, keepError = false) {
    const scope = current(), endpoint = path.value
    if (!scope) return
    cancelRead()
    refreshQueued = false
    const controller = reader = new AbortController()
    // Keep the current rows and player usable while newer results are fetched.
    const initial = !frames.value
    loading.value = initial
    if (!keepError) error.value = ''
    try {
      if (saveFirst) await save(scope.projectId)
      if (controller.signal.aborted) return
      const result = await request(endpoint, {}, controller.signal)
      if (!controller.signal.aborted) {
        if (initial) error.value = ''
        frames.value = result
      }
    } catch (cause) {
      if (!controller.signal.aborted && (!keepError || initial))
        error.value = cause instanceof Error ? cause.message : '参考帧读取失败'
    } finally {
      if (reader === controller) {
        reader = undefined
        loading.value = false
        if (refreshQueued) queueRefresh()
      }
    }
  }
  const refresh = async () => { if (!changing.value) await load(true) }

  function queueRefresh() {
    refreshQueued = true
    if (timer || reader || changing.value) return
    timer = setTimeout(() => { void load(true, true) }, 500)
  }
  function cancelRead() {
    clearTimeout(timer)
    timer = undefined
    reader?.abort()
    reader = undefined
    loading.value = false
  }
  function reset() {
    cancelRead()
    refreshQueued = false
    frames.value = undefined
    writer?.abort()
    writer = undefined
    changing.value = false
    error.value = ''
  }
  watch(path, reset, { flush: 'sync' })
  watch(sourceRevision, () => { sourceVersion++ }, { flush: 'sync' })
  watch([path, sourceRevision, () => current()?.card.version, () => JSON.stringify(current()?.card.referenceFrameSettings)], ([next], [prior]) => {
    if (!next) return
    if (next !== prior) { void refresh(); return }
    queueRefresh()
  }, { immediate: true })
  onScopeDispose(reset)

  function matchesSource(state: ScriptVideoReferenceFrames, row: ScriptVideoReferenceFrameRow | undefined, source: FrameSource) {
    return (row?.sourceCardId === source.cardId && row.videoUrl === source.videoUrl &&
        (!source.sourceEpisodeId || row.sourceEpisodeId === source.sourceEpisodeId)) ||
      (state.projectSources ?? state.previousEpisodeSources)?.some(item => item.cardId === source.cardId && item.videoUrl === source.videoUrl &&
        (!source.sourceEpisodeId || item.sourceEpisodeId === source.sourceEpisodeId))
  }

  async function choose(row: ScriptVideoReferenceFrameRow, mode: FrameSelection, seconds?: number, source?: FrameSource) {
    const scope = current(), endpoint = path.value, available = frames.value
    if (!scope || !available || changing.value || loading.value) return false
    const selectedRow = (state: ScriptVideoReferenceFrames) => row.kind === 'tail' ? state.tail : state.lighting.find(item => item.startShot === row.startShot)
    const selected = selectedRow(available)
    if (!selected || toRaw(selected) !== toRaw(row) || (row.kind === 'lighting' && !row.startShot)) return false
    const videoUrl = source?.videoUrl ?? row.videoUrl
    if (mode === 'manual' && (!videoUrl || !validScriptVideoFrameTime(seconds) || (source && !matchesSource(available, selected, source)))) return false
    const controller = writer = new AbortController()
    const version = sourceVersion
    const original = row.kind === 'tail' ? scope.card.referenceFrameSettings?.tail : scope.card.referenceFrameSettings?.lighting?.[String(row.startShot)]
    const originalChoice = JSON.stringify(original)
    changing.value = true
    if (reader || timer) refreshQueued = true
    cancelRead()
    error.value = ''
    let saved = false
    try {
      let choice: ScriptVideoFrameChoice | undefined = mode === 'off' ? { mode: 'off' } : undefined
      if (mode === 'manual') {
        const result = await request(endpoint, {
          kind: row.kind, ...(row.kind === 'lighting' && { startShot: row.startShot }), seconds, expectedVideoUrl: videoUrl,
          ...(source && { sourceCardId: source.cardId, ...(source.sourceEpisodeId && { sourceEpisodeId: source.sourceEpisodeId }) }),
        }, controller.signal)
        if (controller.signal.aborted) return false
        const frame = result.candidate
        if (!frame?.imageUrl || frame.videoUrl !== videoUrl || (source && frame.sourceCardId !== source.cardId) ||
            (source?.sourceEpisodeId && frame.sourceEpisodeId !== source.sourceEpisodeId) ||
            !validScriptVideoFrameTime(frame.seconds))
          throw new Error('来源成片已变化，请刷新后重新选帧。')
        if (sourceVersion !== version) {
          const latest = await request(endpoint, {}, controller.signal)
          if (controller.signal.aborted) return false
          const latestRow = selectedRow(latest)
          if (!latestRow || (source ? !matchesSource(latest, latestRow, source) : latestRow.videoUrl !== videoUrl))
            throw new Error('来源成片已变化，请重新选帧。')
        }
        choice = { mode, videoUrl: frame.videoUrl, seconds: frame.seconds, ...(frame.sourceCardId && { sourceCardId: frame.sourceCardId }),
          ...(frame.sourceEpisodeId && { sourceEpisodeId: frame.sourceEpisodeId }) }
      }
      const card = current()?.card
      if (!card || controller.signal.aborted) return false
      const prior = card.referenceFrameSettings
      const latest = row.kind === 'tail' ? prior?.tail : prior?.lighting?.[String(row.startShot)]
      if (JSON.stringify(latest) !== originalChoice) throw new Error('这张参考帧的设置已更新，请刷新后重试。')
      const settings = updateScriptVideoReferenceChoice(prior, row, choice)
      if (settings) card.referenceFrameSettings = settings
      else delete card.referenceFrameSettings
      await save(scope.projectId)
      saved = !controller.signal.aborted
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '参考帧设置失败'
    } finally {
      if (controller === writer && (saved || sourceVersion !== version)) await load(false, !saved)
      if (controller === writer) {
        changing.value = false
        writer = undefined
        if (refreshQueued) queueRefresh()
      }
    }
    return saved
  }
  return { frames, loading, changing, error, refresh, choose }
}
