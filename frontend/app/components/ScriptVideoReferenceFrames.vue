<template>
  <section class="sv-frame-list" aria-label="成片参考帧">
    <p v-if="loading" class="sv-frame-status" role="status">正在准备参考帧…</p>
    <p v-if="error" class="sv-frame-error" role="alert">{{ error }}
      <button type="button" class="btn btn-sm btn-ghost" :disabled="busy" @click="$emit('retry')">重新读取</button>
    </p>
    <div v-for="row in rows" :key="keyOf(row)" class="sv-frame-row">
      <img v-if="row.imageUrl" :src="row.imageUrl" :alt="label(row)" class="sv-frame-thumb" loading="lazy" />
      <div v-else class="sv-frame-thumb sv-frame-placeholder" aria-hidden="true" />
      <div class="sv-frame-details">
        <strong>{{ label(row) }}</strong>
        <span>{{ frameStatus(row) }}<template v-if="row.sourceLabel"> · 来源 {{ row.sourceLabel }}</template><template v-if="row.state === 'ready' && row.seconds !== undefined"> · {{ row.seconds.toFixed(2) }} 秒</template></span>
      </div>
      <div class="sv-frame-actions">
        <button type="button" class="btn btn-sm btn-ghost" :aria-label="`为${label(row)}选帧`" :disabled="busy || !row.videoUrl" @click="openPicker(row)">选帧</button>
        <button v-if="row.mode !== 'off' && (row.state !== 'missing' || row.mode === 'manual')" type="button" class="btn btn-sm btn-ghost" :aria-label="`移除${label(row)}`" :disabled="busy" @click="change(row, 'off')">移除</button>
        <button v-if="row.mode !== 'auto'" type="button" class="btn btn-sm btn-ghost" :aria-label="`恢复${label(row)}自动选帧`" :disabled="busy" @click="change(row, 'auto')">恢复自动</button>
      </div>
      <div v-if="pickedKey === keyOf(row) && row.videoUrl" class="sv-frame-picker">
        <video ref="videos" :key="row.videoUrl" :src="row.videoUrl" controls playsinline preload="metadata"
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
import type { ScriptVideoReferenceFrameRow as Row, ScriptVideoReferenceFrames } from '../../../backend/src/services/script-video-reference-settings'
import type { FrameSelection } from '~/composables/useScriptVideoReferenceFrames'

const props = defineProps<{
  frames?: ScriptVideoReferenceFrames
  loading: boolean
  changing: boolean
  error: string
  choose: (row: Row, mode: FrameSelection, seconds?: number) => Promise<boolean>
}>()
defineEmits<{ retry: [] }>()
const emptyTail: Row = { kind: 'tail', mode: 'auto', state: 'missing' }
const emptyStyle: Row = { kind: 'lighting', mode: 'auto', state: 'missing' }
const rows = computed(() => [props.frames?.tail ?? emptyTail, ...(props.frames?.lighting.length ? props.frames.lighting : [emptyStyle])])
const busy = computed(() => props.loading || props.changing)
const pickedKey = ref(''), pickedSource = ref(''), ready = ref(false), seconds = ref<number>(), playbackError = ref('')
const videos = ref<HTMLVideoElement[]>([])
const keyOf = (row: Row) => row.kind === 'tail' ? 'tail' : 'lighting-' + row.startShot
function label(row: Row) {
  if (row.kind === 'tail') return '上一段尾帧'
  const span = row.endShot && row.endShot !== row.startShot ? `${row.startShot}–${row.endShot}` : row.startShot
  return ['风格参考', row.sceneName, row.endShot && span && `镜头 ${span}`].filter(Boolean).join(' · ')
}
function frameStatus(row: Row) {
  if (row.state === 'off') return '已移除'
  if (row.state === 'pending') return '等待来源成片'
  if (row.state === 'missing') return row.videoUrl ? '未选帧' : '暂无可选成片'
  return row.mode === 'manual' ? '手动选帧' : '自动选帧'
}
const source = computed(() => rows.value.find(row => keyOf(row) === pickedKey.value)?.videoUrl)
watch(source, next => { if (pickedKey.value && pickedSource.value !== next) pickedKey.value = '' })
function openPicker(row: Row) {
  if (pickedKey.value === keyOf(row)) return
  ready.value = false
  seconds.value = undefined
  playbackError.value = ''
  pickedSource.value = row.videoUrl || ''
  pickedKey.value = keyOf(row)
}
function metadata(event: Event, row: Row) {
  const video = event.currentTarget as HTMLVideoElement
  if (!row.videoUrl || video.currentSrc !== new URL(row.videoUrl, video.baseURI).href) return
  if (row.seconds !== undefined) video.currentTime = Math.min(row.seconds, video.duration || row.seconds)
  readTime(event)
  ready.value = true
}
function readTime(event: Event) { seconds.value = (event.currentTarget as HTMLVideoElement).currentTime }
async function change(row: Row, mode: FrameSelection, time?: number) {
  if (await props.choose(row, mode, time)) pickedKey.value = ''
}
function useFrame(row: Row) {
  const video = videos.value[0]
  if (!video || !ready.value || !row.videoUrl || row.videoUrl !== pickedSource.value ||
      video.currentSrc !== new URL(row.videoUrl, video.baseURI).href) return
  video.pause()
  const time = Number.isFinite(video.duration) && video.currentTime >= video.duration
    ? Math.max(0, video.duration - 0.001) : video.currentTime
  void change(row, 'manual', time)
}
</script>

<style scoped>
.sv-frame-list { display: grid; gap: 8px; margin-top: 10px; }
.sv-frame-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 8px; }
.sv-frame-thumb { width: 76px; height: 46px; border-radius: 4px; object-fit: contain; background: var(--surface-input); }
.sv-frame-placeholder { border: 1px dashed var(--border); }
.sv-frame-details { display: grid; gap: 3px; margin-right: auto; font-size: 13px; }
.sv-frame-details span, .sv-frame-status, .sv-frame-picker span { color: var(--text-3); font-size: 12px; }
.sv-frame-status, .sv-frame-error { margin: 0; }
.sv-frame-error { color: var(--warning); }
.sv-frame-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sv-frame-picker { flex-basis: 100%; display: grid; justify-items: start; gap: 7px; }
.sv-frame-picker video { width: min(100%, 520px); max-height: 36vh; background: black; border-radius: 6px; }
</style>
