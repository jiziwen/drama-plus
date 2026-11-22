import { computed, onScopeDispose, ref, shallowRef, toRaw, watch } from 'vue'
import { updateScriptVideoReferenceChoice, validScriptVideoFrameTime } from '../../../backend/src/services/script-video-reference-settings'
import type { ScriptVideoFrameChoice, ScriptVideoReferenceFrameRow, ScriptVideoReferenceFrames, ScriptVideoReferenceSettings } from '../../../backend/src/services/script-video-reference-settings'

type Scope = { projectId: string; episodeId: string; card: { id: string; version?: number; referenceFrameSettings?: ScriptVideoReferenceSettings } }
type Request = (path: string, body: object, signal: AbortSignal) => Promise<ScriptVideoReferenceFrames>
export type FrameSelection = 'auto' | 'off' | 'manual'

export function useScriptVideoReferenceFrames(
  current: () => Scope | undefined, sourceRevision: () => string,
  save: (projectId: string) => Promise<void>, request: Request,
) {
  const frames = shallowRef<ScriptVideoReferenceFrames>()
  const loading = ref(false), changing = ref(false), error = ref('')
  let reader: AbortController | undefined, writer: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let sourceVersion = 0
  const path = computed(() => {
    const scope = current()
    return scope ? `/projects/${scope.projectId}/episodes/${scope.episodeId}/cards/${scope.card.id}/reference-frames` : ''
  })

  async function load(saveFirst: boolean, keepError = false) {
    clearTimeout(timer)
    reader?.abort()
    const scope = current(), endpoint = path.value
    if (!scope || changing.value) return
    const controller = reader = new AbortController()
    loading.value = true
    if (!keepError) error.value = ''
    try {
      if (saveFirst) await save(scope.projectId)
      if (controller.signal.aborted) return
      const result = await request(endpoint, {}, controller.signal)
      if (!controller.signal.aborted) frames.value = result
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '参考帧读取失败'
    } finally {
      if (reader === controller) loading.value = false
    }
  }
  const refresh = () => load(true)

  function invalidateRead() {
    clearTimeout(timer)
    reader?.abort()
    reader = undefined
    frames.value = undefined
    loading.value = false
  }
  function reset() {
    invalidateRead()
    writer?.abort()
    writer = undefined
    changing.value = false
    error.value = ''
  }
  watch(path, reset, { flush: 'sync' })
  watch(sourceRevision, () => {
    sourceVersion++
    invalidateRead()
  }, { flush: 'sync' })
  watch([path, sourceRevision, () => current()?.card.version, () => JSON.stringify(current()?.card.referenceFrameSettings)], ([next], [prior]) => {
    if (!next || changing.value) return
    if (next !== prior) { void refresh(); return }
    clearTimeout(timer)
    timer = setTimeout(refresh, 500)
  }, { immediate: true })
  onScopeDispose(reset)

  async function choose(row: ScriptVideoReferenceFrameRow, mode: FrameSelection, seconds?: number) {
    const scope = current(), endpoint = path.value, available = frames.value
    if (!scope || !available || changing.value || loading.value) return false
    const selectedRow = (state: ScriptVideoReferenceFrames) => row.kind === 'tail' ? state.tail : state.lighting.find(item => item.startShot === row.startShot)
    const selected = selectedRow(available)
    if (!selected || toRaw(selected) !== toRaw(row) || (row.kind === 'lighting' && !row.startShot)) return false
    if (mode === 'manual' && (!row.videoUrl || !validScriptVideoFrameTime(seconds))) return false
    const controller = writer = new AbortController()
    const version = sourceVersion
    const original = row.kind === 'tail' ? scope.card.referenceFrameSettings?.tail : scope.card.referenceFrameSettings?.lighting?.[String(row.startShot)]
    const originalChoice = JSON.stringify(original)
    changing.value = true
    error.value = ''
    let saved = false
    try {
      let choice: ScriptVideoFrameChoice | undefined = mode === 'off' ? { mode: 'off' } : undefined
      if (mode === 'manual') {
        const result = await request(endpoint, {
          kind: row.kind, ...(row.kind === 'lighting' && { startShot: row.startShot }), seconds, expectedVideoUrl: row.videoUrl,
        }, controller.signal)
        if (controller.signal.aborted) return false
        const frame = result.candidate
        if (!frame?.imageUrl || frame.videoUrl !== row.videoUrl || !validScriptVideoFrameTime(frame.seconds))
          throw new Error('来源成片已变化，请刷新后重新选帧。')
        if (sourceVersion !== version) {
          const rechecking = sourceVersion
          const latest = await request(endpoint, {}, controller.signal)
          if (controller.signal.aborted) return false
          if (sourceVersion !== rechecking || selectedRow(latest)?.videoUrl !== row.videoUrl)
            throw new Error('来源成片已变化，请重新选帧。')
        }
        choice = { mode, videoUrl: frame.videoUrl, seconds: frame.seconds }
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
      if (controller === writer) {
        changing.value = false
        writer = undefined
        if (saved || sourceVersion !== version) await load(false, !saved)
      }
    }
    return saved
  }
  return { frames, loading, changing, error, refresh, choose }
}
