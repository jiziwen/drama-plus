<template>
  <section class="cinematic-screening-bar" aria-label="真实素材放映">
    <div class="cinematic-screening-copy">
      <span class="cinematic-screening-mark" aria-hidden="true"><Clapperboard :size="23" /></span>
      <div><span class="cinematic-screening-eyebrow">YOUR STORY, ON SCREEN</span><strong>让这一幕，走进影院。</strong><p>{{ readinessLabel }}</p></div>
    </div>
    <div class="cinematic-screening-actions">
      <label v-if="completedMerges.length" class="cinematic-screening-source"><span class="sr-only">选择放映内容</span><select v-model="source"><option value="shots">分镜连映 · {{ readyShots.length }} 镜</option><option v-for="merge in completedMerges" :key="merge.id" :value="`merge:${merge.id}`">成片 · {{ mergeLabel(merge) }}</option></select></label>
      <button type="button" class="btn cinematic-screening-button" :disabled="busy || !canScreen" @click="open()"><Loader2 v-if="busy" :size="15" class="animate-spin" /><Play v-else :size="15" />{{ busy ? '正在准备放映…' : '进入私人放映室' }}<ArrowUpRight v-if="!busy" :size="15" /></button>
    </div>
    <p v-if="error" class="cinematic-screening-error" role="alert">{{ error }}</p>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { ArrowUpRight, Clapperboard, Loader2, Play } from 'lucide-vue-next'
import { posterOf, videoPosterSrc } from '~/composables/useMedia'

const props = defineProps({
  title: { type: String, default: '' }, episodeTitle: { type: String, default: '' }, episodeNumber: { type: Number, default: 1 },
  storyboards: { type: Array, default: () => [] }, characters: { type: Array, default: () => [] }, scenes: { type: Array, default: () => [] }, assets: { type: Array, default: () => [] },
  merges: { type: Array, default: () => [] }, selectedId: { type: [Number, String], default: null }, ratio: { type: String, default: '16:9' },
})
const emit = defineEmits(['opened', 'closed'])
const source = ref('shots'), busy = ref(false), error = ref('')
const blankPoster = '/studio/assets/empty-screen.svg'
// Keep these runtime imports: a literal public path is transformed into an asset URL module by Vite.
const cinemaModuleUrl = '/studio/cinema.js'
let cinema = null, snapshot = null, destroyed = false, request = 0
const pendingMetadata = new Set()

function localMedia(value) {
  if (!value || typeof window === 'undefined') return ''
  try {
    const raw = String(value), path = /^https?:\/\//i.test(raw) || raw.startsWith('/') ? raw : `/${raw}`
    const url = new URL(path, window.location.origin)
    return url.origin === window.location.origin && /^(https?:)$/.test(url.protocol) ? url.href : ''
  } catch { return '' }
}
function assetImage(asset) { return localMedia(asset?.image_url || asset?.imageUrl || asset?.local_path || asset?.localPath) }
function ids(value) {
  if (Array.isArray(value)) return value.map(Number)
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.map(Number) : [] } catch { return [] }
}
function shotPoster(shot, video) {
  const image = localMedia(shot.first_frame_image || shot.firstFrameImage || shot.composed_image || shot.composedImage || shot.image_url || shot.imageUrl)
  if (image) return image
  if (video) return localMedia(videoPosterSrc('storyboards', shot.id, video)) || blankPoster
  const scene = props.scenes.find(item => Number(item.id) === Number(shot.scene_id || shot.sceneId))
  const characters = ids(shot.character_ids || shot.characterIds)
  const assets = ids(shot.prop_ids || shot.propIds)
  return assetImage(scene) || assetImage(props.characters.find(item => characters.includes(Number(item.id)))) || assetImage(props.assets.find(item => assets.includes(Number(item.id))))
}
const readyShots = computed(() => props.storyboards.map((shot, index) => {
  const video = localMedia(shot.video_url || shot.videoUrl || shot.composed_video_url || shot.composedVideoUrl)
  const poster = shotPoster(shot, video)
  return {
    id: shot.id, title: String(shot.title || `镜头 ${index + 1}`), description: String(shot.description || ''), video, poster,
    duration: Math.max(.5, Number(shot.duration) || 5), camera: String(shot.movement || shot.camera_movement || shot.cameraMovement || 'fixed'), focus: '50% center',
    order: Number(shot.storyboard_number ?? shot.storyboardNumber ?? index + 1), still: !video,
  }
}).filter(shot => shot.video || shot.poster).sort((a, b) => a.order - b.order))
const completedMerges = computed(() => props.merges.filter(merge => merge.status === 'completed' && localMedia(merge.merged_url || merge.mergedUrl)))
const selectedMerge = computed(() => completedMerges.value.find(merge => `merge:${merge.id}` === source.value))
const canScreen = computed(() => source.value === 'shots' ? readyShots.value.length > 0 : Boolean(selectedMerge.value))
const readinessLabel = computed(() => {
  if (!props.storyboards.length && !completedMerges.value.length) return '还没有可放映的镜头。先完成分镜与媒体制作，再来看看你的故事。'
  if (!readyShots.value.length && !completedMerges.value.length) return '镜头尚无本地视频或已绑定的视觉素材。生成或上传后，即可在这里放映。'
  const videos = readyShots.value.filter(shot => shot.video).length, stills = readyShots.value.length - videos
  const missing = props.storyboards.length - readyShots.value.length
  return `${videos} 镜视频${stills ? ` · ${stills} 镜参考静帧` : ''}${missing ? ` · ${missing} 镜等待媒体` : ''}${completedMerges.value.length ? ` · ${completedMerges.value.length} 部成片` : ''}`
})
function mergeLabel(merge) {
  const date = merge.created_at || merge.createdAt
  return date ? new Date(date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : `版本 ${merge.id}`
}
function readDuration(videoUrl, fallback) {
  return new Promise(resolve => {
    const video = document.createElement('video')
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true; clearTimeout(timer); pendingMetadata.delete(cancel)
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number(fallback)
      const ratio = video.videoWidth > 0 && video.videoHeight > 0 ? `${video.videoWidth}:${video.videoHeight}` : ''
      video.removeEventListener('loadedmetadata', finish); video.removeEventListener('error', finish)
      video.removeAttribute('src'); video.load(); resolve({ duration: duration > 0 ? duration : null, ratio })
    }
    const cancel = () => finish()
    const timer = setTimeout(finish, 6000)
    pendingMetadata.add(cancel)
    video.preload = 'metadata'; video.muted = true; video.playsInline = true
    video.addEventListener('loadedmetadata', finish); video.addEventListener('error', finish)
    video.src = videoUrl; video.load()
  })
}
function announce(open) {
  emit(open ? 'opened' : 'closed')
  window.dispatchEvent(new CustomEvent('cinematic-screening-change', { detail: { open } }))
}
async function open({ merge = selectedMerge.value, fromStart = true } = {}) {
  if (busy.value || destroyed) return
  error.value = ''; busy.value = true
  const token = ++request
  try {
    let shots, ratio = props.ratio, title = props.title
    let episodeLabel = `第 ${props.episodeNumber} 集${props.episodeTitle ? ` · ${props.episodeTitle}` : ''}`
    if (merge) {
      const video = localMedia(merge.merged_url || merge.mergedUrl)
      if (!video) throw new Error('这部成片还没有可放映的视频。请先完成拼接或恢复下载。')
      const metadata = await readDuration(video, merge.duration)
      const duration = metadata.duration
      if (!duration) throw new Error('暂时无法读取成片时长。请确认视频已完成下载后重试，原播放器仍可使用。')
      if (ratio === 'adaptive' && metadata.ratio) ratio = metadata.ratio
      shots = [{ id: `merge:${merge.id}`, title: `${props.episodeTitle || `第 ${props.episodeNumber} 集`} · 成片`, description: mergeLabel(merge), video, poster: localMedia(posterOf(video)) || blankPoster, duration, camera: 'fixed', focus: '50% center' }]
    } else {
      shots = readyShots.value.map(shot => ({ ...shot }))
      const firstVideo = shots.find(shot => shot.video)
      if (ratio === 'adaptive' && firstVideo) ratio = (await readDuration(firstVideo.video, firstVideo.duration)).ratio || '16:9'
    }
    if (!shots.length) throw new Error('当前没有可放映的媒体。请先生成镜头视频，或为分镜绑定真实视觉素材。')
    if (destroyed || token !== request) return
    const module = await import(/* @vite-ignore */ cinemaModuleUrl)
    if (destroyed || token !== request) return
    snapshot = {
      title, episode: episodeLabel,
      shots, selectedId: props.selectedId, ratio, strictMedia: true, mediaAudio: true,
      look: { filter: 'none', glow: .08, accent: '#a6e7df', lightColor: '#d9edf1', lightX: 62, lightY: 32 },
    }
    if (!cinema) cinema = module.createCinema({ getSnapshot: () => snapshot, onClose: () => announce(false) })
    cinema.open({ fromStart }); announce(true)
  } catch (cause) { if (!destroyed) error.value = cause?.message || '放映室暂时无法打开，请稍后重试。' }
  finally { if (!destroyed && token === request) busy.value = false }
}
function openMerge(merge) { return open({ merge }) }
onBeforeUnmount(() => { destroyed = true; ++request; pendingMetadata.forEach(cancel => cancel()); pendingMetadata.clear(); cinema?.destroy(); cinema = null })
defineExpose({ open, openMerge, close: () => cinema?.close() })
</script>
