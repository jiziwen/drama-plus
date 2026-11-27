<template>
  <dialog
    ref="dialog"
    class="sample-dialog"
    :aria-labelledby="titleId"
    @click.self="dialog?.close()"
    @close="onDialogClosed"
  >
    <div class="sample-layout">
      <header class="sample-header">
        <div>
          <h2 :id="titleId">本集样片</h2>
          <p>{{ episodeLabel }}</p>
        </div>
        <button type="button" class="btn btn-icon" aria-label="关闭本集样片" autofocus @click="dialog?.close()">
          <X :size="17" aria-hidden="true" />
        </button>
      </header>
      <div v-if="activeClip" class="sample-body">
        <section class="sample-player" aria-label="样片播放器">
          <video
            ref="video"
            controls
            playsinline
            preload="metadata"
            :aria-label="`第 ${activeClip.number} 段 ${activeClip.title}`"
            @play="onPlaybackStarted"
            @ended="onVideoEnded"
            @error="onVideoError"
          />
          <div class="sample-player-footer">
            <p aria-live="polite">第 {{ activeClip.number }} 段 · {{ activeClip.title }}</p>
            <button type="button" class="btn btn-primary" @click="selectClip(0, true)">
              <Play :size="14" aria-hidden="true" />从头播放
            </button>
          </div>
          <p v-if="playbackBlocked" class="sample-feedback" role="status">点击播放器内的播放键继续。</p>
          <p v-else-if="failedClips.has(activeClip.number)" class="sample-feedback" role="status">本段视频加载失败，可切换片段或重新播放。</p>
        </section>
        <section class="sample-queue" aria-label="样片播放列表">
          <h3>播放列表 · {{ playlist.length }} 段</h3>
          <ol>
            <li v-for="(clip, index) in playlist" :key="clip.number">
              <button
                type="button"
                class="sample-clip"
                :aria-current="activeIndex === index ? 'true' : undefined"
                @click="selectClip(index, true)"
              >
                <span class="sample-number">{{ String(clip.number).padStart(2, '0') }}</span>
                <span>{{ clip.title }}</span>
                <small v-if="failedClips.has(clip.number)">加载失败</small>
                <small v-else-if="clip.previous">上一版</small>
              </button>
            </li>
          </ol>
        </section>
      </div>
      <p v-else class="sample-empty">本集暂无已生成的视频。</p>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId } from 'vue'
import { Play, X } from 'lucide-vue-next'

type SampleClip = { number: number; title: string; url: string; previous: boolean }

const props = defineProps<{
  episodeLabel: string
  clips: readonly SampleClip[]
}>()

const titleId = useId()
const dialog = ref<HTMLDialogElement>()
const video = ref<HTMLVideoElement>()
const playlist = shallowRef<readonly SampleClip[]>([])
const activeIndex = ref(0)
const activeClip = computed(() => playlist.value[activeIndex.value])
const failedClips = ref(new Set<number>())
const playbackBlocked = ref(false)
let autoAdvance = false
let playbackRequest = 0

async function open() {
  if (dialog.value?.open) return
  clearPlayback()
  playlist.value = [...props.clips]
  await nextTick()
  if (!dialog.value || dialog.value.open) return
  dialog.value.showModal()
  selectClip(0, false)
}

function selectClip(index: number, play: boolean) {
  const player = video.value
  const clip = playlist.value[index]
  if (!player || !clip) return
  const request = ++playbackRequest
  activeIndex.value = index
  autoAdvance = play
  playbackBlocked.value = false
  failedClips.value.delete(clip.number)
  // Keep one media element so permission to play carries across clips.
  player.src = clip.url
  if (play) {
    void player.play().catch(error => {
      if (request === playbackRequest && error.name !== 'AbortError' && !player.error) {
        playbackBlocked.value = true
      }
    })
  }
}

function onPlaybackStarted() {
  autoAdvance = true
  playbackBlocked.value = false
}

function advance() {
  if (activeIndex.value < playlist.value.length - 1) selectClip(activeIndex.value + 1, true)
}

function onVideoEnded() {
  if (video.value?.ended) advance()
}

function onVideoError() {
  const clip = activeClip.value
  if (!clip || !video.value?.error) return
  failedClips.value.add(clip.number)
  if (autoAdvance) advance()
}

function onDialogClosed() {
  if (!dialog.value?.open) clearPlayback()
}

function clearPlayback() {
  playbackRequest++
  autoAdvance = false
  playbackBlocked.value = false
  failedClips.value.clear()
  video.value?.pause()
  video.value?.removeAttribute('src')
  video.value?.load()
  activeIndex.value = 0
  playlist.value = []
}

onBeforeUnmount(clearPlayback)
defineExpose({ open })
</script>

<style scoped>
.sample-dialog {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(990px, calc(100% - 32px));
  max-height: 88dvh;
  padding: 0;
  overflow: auto;
  color: var(--text-0);
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  box-shadow: var(--shadow-elevated);
}
.sample-dialog::backdrop {
  background: var(--scrim);
  backdrop-filter: blur(7px);
}
.sample-header,
.sample-player-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.sample-header {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.sample-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}
.sample-header p,
.sample-feedback,
.sample-empty {
  margin: 4px 0 0;
  color: var(--text-3);
  font-size: 13px;
}
.sample-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(175px, 225px);
  gap: 16px;
  padding: 16px 20px 20px;
}
.sample-player video {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  max-height: 59dvh;
  background: #050a0e;
  border-radius: 10px;
  object-fit: contain;
}
.sample-player-footer {
  margin-top: 10px;
}
.sample-player-footer p {
  margin: 0;
  min-width: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.sample-player-footer button {
  flex-shrink: 0;
}
.sample-queue {
  display: flex;
  flex-direction: column;
  max-height: 59dvh;
  min-height: 0;
}
.sample-queue h3 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
.sample-queue ol {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0 3px 0 0;
  overflow: auto;
  list-style: none;
}
.sample-clip {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 8px;
  text-align: left;
  font: inherit;
  font-size: 12px;
  overflow-wrap: anywhere;
  color: var(--text-1);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
}
.sample-clip:focus-visible,
.sample-clip[aria-current] {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
}
.sample-clip:hover,
.sample-clip[aria-current] {
  background: var(--surface-soft);
}
.sample-number {
  color: var(--accent-text);
  font-variant-numeric: tabular-nums;
}
.sample-clip small {
  margin-left: auto;
  white-space: nowrap;
  color: var(--text-3);
}
.sample-empty {
  padding: 36px 20px;
  text-align: center;
}
@media (max-width: 650px) {
  .sample-dialog {
    width: calc(100% - 16px);
    max-height: calc(100dvh - 16px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
    overscroll-behavior: contain;
  }
  .sample-header {
    padding: 10px 12px;
  }
  .sample-header h2 {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .sample-body {
    grid-template-columns: minmax(0, 1fr);
    padding: 12px;
  }
  .sample-player-footer {
    flex-wrap: wrap;
  }
  .sample-queue {
    max-height: none;
  }
  .sample-queue ol {
    overflow: visible;
  }
  .sample-clip,
  .sample-header button,
  .sample-player-footer button {
    min-height: 40px;
  }
}
</style>
