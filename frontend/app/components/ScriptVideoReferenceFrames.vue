<template>
  <section class="sv-frame-list" aria-label="成片参考帧">
    <p v-if="loading" class="sv-frame-status" role="status">正在准备参考帧…</p>
    <p v-if="error" class="sv-frame-error" role="alert">{{ error }}
      <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="$emit('retry')">重新读取</button>
    </p>
    <div v-for="row in rows" :key="keyOf(row)" class="sv-frame-row">
      <button v-if="row.imageUrl" type="button" class="sv-frame-preview" :aria-label="`查看${label(row)}图片`"
        aria-haspopup="dialog" title="点击查看大图" @click="previewFrame(row)">
        <img :src="thumbOf(row.imageUrl)" :alt="label(row)" class="sv-frame-thumb" loading="lazy" decoding="async" />
      </button>
      <div v-else class="sv-frame-thumb sv-frame-placeholder" aria-hidden="true" />
      <div class="sv-frame-details">
        <strong>{{ label(row) }}</strong>
        <span>{{ frameStatus(row) }}<template v-if="row.sourceLabel"> · 来源 {{ row.sourceLabel }}</template><template v-if="row.state === 'ready' && row.seconds !== undefined"> · {{ row.seconds.toFixed(2) }} 秒</template></span>
      </div>
      <div class="sv-frame-actions">
        <button type="button" class="btn btn-sm btn-ghost" :aria-label="`为${label(row)}选帧`" :disabled="busy || !canPick(row)" @click="openPicker(row)">选帧</button>
        <button v-if="row.mode !== 'off' && (row.state !== 'missing' || row.mode === 'manual')" type="button" class="btn btn-sm btn-ghost" :aria-label="`移除${label(row)}`" :disabled="busy" @click="change(row, 'off')">移除</button>
        <button v-if="row.mode !== 'auto'" type="button" class="btn btn-sm btn-ghost" :aria-label="`恢复${label(row)}自动选帧`" :disabled="busy" @click="change(row, 'auto')">恢复自动</button>
      </div>
      <div v-if="pickedKey === keyOf(row)" class="sv-frame-picker">
        <div v-if="sourceOptions.length" class="sv-frame-source">
          <span>来源成片（全部分集）</span>
          <BaseSelect aria-label="选帧来源成片" :model-value="sourceKey(pickedSource, pickedSourceCardId, pickedSourceEpisodeId)" :options="sourceOptions"
            :open-highlight-value="previousSourceKey" placeholder="选择来源成片" searchable :disabled="busy" @update:model-value="changeSource" />
        </div>
        <video v-if="pickedSource" ref="videos" :key="sourceKey(pickedSource, pickedSourceCardId, pickedSourceEpisodeId)" :src="pickedSource" controls playsinline preload="metadata"
          :aria-label="`${label(row)}来源成片`" @loadedmetadata="metadata($event, row)"
          @timeupdate="readTime" @seeked="readTime" @error="playbackError = '来源成片暂时无法播放。'" />
        <span v-if="playbackError" role="alert">{{ playbackError }}</span>
        <div class="sv-frame-actions">
          <span v-if="seconds !== undefined">当前 {{ seconds.toFixed(2) }} 秒</span>
          <button type="button" class="btn btn-sm btn-primary" :disabled="busy || !ready || !!playbackError" @click="useFrame(row)">使用当前帧</button>
          <button type="button" class="btn btn-sm btn-ghost" :disabled="changing" @click="pickedKey = ''">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { thumbOf } from '~/composables/useMedia'
import type { ScriptVideoReferenceFrameRow as Row, ScriptVideoReferenceFrames } from '../../../backend/src/services/script-video-reference-settings'
import type { FrameSelection, FrameSource } from '~/composables/useScriptVideoReferenceFrames'

const props = defineProps<{
  frames?: ScriptVideoReferenceFrames
  loading: boolean
  changing: boolean
  error: string
  choose: (row: Row, mode: FrameSelection, seconds?: number, source?: FrameSource) => Promise<boolean>
}>()
const emit = defineEmits<{ retry: []; preview: [name: string, url: string] }>()
const emptyTail: Row = { kind: 'tail', mode: 'auto', state: 'missing' }
const emptyStyle: Row = { kind: 'lighting', mode: 'auto', state: 'missing' }
const rows = computed(() => [props.frames?.tail ?? emptyTail, ...(props.frames?.lighting.length ? props.frames.lighting : [emptyStyle])])
const busy = computed(() => props.loading || props.changing)
const pickedKey = ref(''), pickedSource = ref(''), ready = ref(false), seconds = ref<number>(), playbackError = ref('')
const pickedSourceCardId = ref<string>()
const pickedSourceEpisodeId = ref<string>()
const videos = ref<HTMLVideoElement[]>([])
const keyOf = (row: Row) => row.kind === 'tail' ? 'tail' : 'lighting-' + row.startShot
const manualSources = computed(() => props.frames?.projectSources ?? props.frames?.previousEpisodeSources ?? [])
const pickerRow = computed(() => rows.value.find(row => keyOf(row) === pickedKey.value))
const sourceKey = (videoUrl: string, cardId?: string, sourceEpisodeId?: string) =>
  JSON.stringify(sourceEpisodeId ? [sourceEpisodeId, cardId, videoUrl] : [cardId, videoUrl])
const previousSourceKey = computed(() => {
  const source = props.frames?.previousPlayableSource
  return source ? sourceKey(source.videoUrl, source.cardId, source.sourceEpisodeId) : props.frames?.projectSources && ''
})
function sourceChoices(row: Row) {
  const choices = manualSources.value
  if (!choices.length || !row.videoUrl || !row.sourceCardId ||
      choices.some(source => source.cardId === row.sourceCardId && source.videoUrl === row.videoUrl &&
        (!row.sourceEpisodeId || source.sourceEpisodeId === row.sourceEpisodeId))) return choices
  return [{ cardId: row.sourceCardId, videoUrl: row.videoUrl,
    ...(row.sourceEpisodeId && { sourceEpisodeId: row.sourceEpisodeId }), sourceLabel: (row.sourceLabel || '当前参考帧') + '（已选版本）' }, ...choices]
}
const pickerSources = computed(() => pickerRow.value ? sourceChoices(pickerRow.value) : [])
const sourceOptions = computed(() => pickerSources.value.map(source => ({
  value: sourceKey(source.videoUrl, source.cardId, source.sourceEpisodeId), label: source.sourceLabel,
})))
const selectedSource = computed(() => pickerSources.value.find(source =>
  source.cardId === pickedSourceCardId.value && source.videoUrl === pickedSource.value &&
  source.sourceEpisodeId === pickedSourceEpisodeId.value))
function canPick(row: Row) {
  return !!row.videoUrl || (row.kind === 'tail' || row.startShot !== undefined) && manualSources.value.length > 0
}
function label(row: Row) {
  if (row.kind === 'tail') return props.frames?.previousEpisodeSources?.length ? '续接参考帧' : '上一段尾帧'
  const span = row.endShot && row.endShot !== row.startShot ? `${row.startShot}–${row.endShot}` : row.startShot
  return ['风格参考', row.sceneName, row.endShot && span && `镜头 ${span}`].filter(Boolean).join(' · ')
}
function previewFrame(row: Row) {
  if (row.imageUrl) emit('preview', label(row), row.imageUrl)
}
function frameStatus(row: Row) {
  if (row.state === 'off') return '已移除'
  if (row.state === 'pending') return props.frames?.previousEpisodeSources?.length ? '等待自动来源成片' : '等待来源成片'
  if (row.state === 'missing') return canPick(row) ? '未选帧' : '暂无可选成片'
  return row.mode === 'manual' ? '手动选帧' : '自动选帧'
}
const sourceAvailable = computed(() => pickedSourceCardId.value ? !!selectedSource.value :
  !!pickedSource.value && pickerRow.value?.videoUrl === pickedSource.value)
watch(sourceAvailable, available => { if (pickedKey.value && pickedSource.value && !available) pickedKey.value = '' })
function showSource(videoUrl: string, cardId?: string, sourceEpisodeId?: string) {
  ready.value = false
  seconds.value = undefined
  playbackError.value = ''
  pickedSource.value = videoUrl
  pickedSourceCardId.value = cardId
  pickedSourceEpisodeId.value = sourceEpisodeId
}
function openPicker(row: Row) {
  if (pickedKey.value === keyOf(row)) return
  if (props.frames?.projectSources) {
    const source = props.frames.previousPlayableSource
    showSource(source?.videoUrl ?? '', source?.cardId, source?.sourceEpisodeId)
    pickedKey.value = keyOf(row)
    return
  }
  const choices = sourceChoices(row)
  const saved = choices.find(source => source.videoUrl === row.videoUrl && (!row.sourceCardId || source.cardId === row.sourceCardId) &&
    (!row.sourceEpisodeId || source.sourceEpisodeId === row.sourceEpisodeId))
  const preferred = saved ?? (!row.videoUrl ? choices.at(-1) : undefined)
  showSource(preferred?.videoUrl ?? row.videoUrl ?? '', preferred?.cardId ?? row.sourceCardId, preferred?.sourceEpisodeId ?? row.sourceEpisodeId)
  pickedKey.value = keyOf(row)
}
function changeSource(key: string) {
  if (busy.value) return
  const source = pickerSources.value.find(item => sourceKey(item.videoUrl, item.cardId, item.sourceEpisodeId) === key)
  if (!source || (pickedSource.value === source.videoUrl && pickedSourceCardId.value === source.cardId &&
      pickedSourceEpisodeId.value === source.sourceEpisodeId)) return
  showSource(source.videoUrl, source.cardId, source.sourceEpisodeId)
}
function metadata(event: Event, row: Row) {
  const video = event.currentTarget as HTMLVideoElement
  if (video !== videos.value[0] || !pickedSource.value || video.currentSrc !== new URL(pickedSource.value, video.baseURI).href) return
  if (row.seconds !== undefined && row.videoUrl === pickedSource.value &&
      (!row.sourceCardId || row.sourceCardId === pickedSourceCardId.value) &&
      (!row.sourceEpisodeId || row.sourceEpisodeId === pickedSourceEpisodeId.value))
    video.currentTime = Math.min(row.seconds, video.duration || row.seconds)
  readTime(event)
  ready.value = true
}
function readTime(event: Event) {
  const video = event.currentTarget as HTMLVideoElement
  if (video === videos.value[0]) seconds.value = video.currentTime
}
async function change(row: Row, mode: FrameSelection, time?: number, source?: FrameSource) {
  const saved = source ? await props.choose(row, mode, time, source) : await props.choose(row, mode, time)
  if (saved) pickedKey.value = ''
}
function useFrame(row: Row) {
  const video = videos.value[0]
  if (!video || !ready.value || !sourceAvailable.value ||
      video.currentSrc !== new URL(pickedSource.value, video.baseURI).href) return
  video.pause()
  const time = Number.isFinite(video.duration) ? Math.min(video.currentTime, video.duration) : video.currentTime
  void change(row, 'manual', time, selectedSource.value)
}
</script>

<style scoped>
.sv-frame-list { display: grid; gap: 8px; margin-top: 10px; }
.sv-frame-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; }
.sv-frame-preview { display: block; flex-shrink: 0; padding: 0; border: 0; border-radius: 4px; background: transparent; cursor: zoom-in; }
.sv-frame-preview:is(:hover, :focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.sv-frame-thumb { display: block; width: 76px; height: 46px; border-radius: 4px; object-fit: contain; background: var(--surface-input); }
.sv-frame-placeholder { border: 1px dashed var(--border); }
.sv-frame-details { display: grid; gap: 3px; margin-right: auto; font-size: 13px; }
.sv-frame-details span, .sv-frame-status, .sv-frame-picker span { color: var(--text-3); font-size: 12px; }
.sv-frame-status, .sv-frame-error { margin: 0; }
.sv-frame-error { color: var(--warning); }
.sv-frame-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sv-frame-picker { flex-basis: 100%; display: grid; justify-items: start; gap: 7px; }
.sv-frame-source { width: min(100%, 520px); display: grid; gap: 4px; }
.sv-frame-picker video { width: min(100%, 520px); max-height: 36vh; background: black; border-radius: 6px; }
</style>
