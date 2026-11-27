<template>
  <div class="sv-final-prompt">
    <section v-if="references.length" class="sv-prompt-media" aria-label="生成参考素材">
      <div ref="gallery" class="sv-reference-strip">
        <button
          v-for="reference in references"
          :key="reference.id"
          type="button"
          class="sv-reference"
          :data-reference="reference.id"
          :aria-label="`${reference.displayTag} ${reference.name}`"
          :aria-pressed="reference.kind === 'audio' ? selectedAudio?.id === reference.id : undefined"
          @mouseenter="showPreview(reference, $event)"
          @mouseleave="leavePreview"
          @focus="showPreview(reference, $event)"
          @blur="closeImagePreview"
          @click="selectReference(reference, $event)"
        >
          <span class="sv-reference-thumb">
            <img
              v-if="reference.kind === 'image' && !brokenImages.has(reference.url)"
              :src="thumbOf(reference.url)"
              alt=""
              loading="lazy"
              decoding="async"
              @error="brokenImages.add(reference.url)"
            />
            <Headphones v-else-if="reference.kind === 'audio'" :size="19" aria-hidden="true" />
            <ImageIcon v-else :size="19" aria-hidden="true" />
            <span class="sv-reference-number">{{ reference.displayTag }}</span>
          </span>
          <span class="sv-reference-name" :title="reference.name">{{ reference.name }}</span>
        </button>
      </div>
      <audio
        v-if="selectedAudio"
        :key="selectedAudio.id"
        :src="selectedAudio.url"
        :aria-label="`试听 ${selectedAudio.name}`"
        controls
        preload="none"
        @play="activateScriptVideoAudio"
        @pause="deactivateScriptVideoAudio"
        @ended="deactivateScriptVideoAudio"
      />
    </section>

    <ScriptVideoPromptStyle v-if="styleSection" :key="styleSection.name" :preset="styleSection" />
    <div v-if="promptBody" class="sv-prompt-text" tabindex="0" role="region" aria-label="最终视频提示词">
      <template v-for="(part, index) in promptParts" :key="index">
        <button
          v-if="part.reference"
          type="button"
          class="sv-prompt-mention"
          :aria-label="`${part.reference.displayTag} ${part.reference.name}`"
          @mouseenter="showPreview(part.reference, $event, true)"
          @mouseleave="leavePreview"
          @focus="showPreview(part.reference, $event)"
          @blur="closeImagePreview"
          @click="jumpToReference(part.reference)"
        >{{ part.reference.displayTag }}</button>
        <template v-else>{{ part.text }}</template>
      </template>
    </div>

    <Teleport to="body">
      <div
        v-if="preview"
        class="sv-reference-preview"
        :class="{ 'sv-reference-preview-audio': preview.reference.kind === 'audio' }"
        :style="preview.position"
        :aria-hidden="preview.reference.kind === 'image' || undefined"
        @mouseenter="keepPreviewOpen"
        @mouseleave="leavePreview"
      >
        <img v-if="preview.reference.kind === 'image'" :src="thumbOf(preview.reference.url)" alt="" loading="lazy" decoding="async" @error="previewImageFailed" />
        <span>{{ preview.reference.displayTag }} · {{ preview.reference.name }}</span>
        <audio
          v-if="preview.reference.kind === 'audio'"
          ref="hoverAudioEl"
          :key="preview.reference.id"
          :src="preview.reference.url"
          :aria-label="`试听 ${preview.reference.name}`"
          controls
          preload="none"
          @play="activateScriptVideoAudio"
          @pause="deactivateScriptVideoAudio"
          @ended="deactivateScriptVideoAudio"
        />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Headphones, Image as ImageIcon } from 'lucide-vue-next'
import { thumbOf } from '~/composables/useMedia'
import { activateScriptVideoAudio, deactivateScriptVideoAudio, useScriptVideoAudioPreview } from '~/composables/useScriptVideoAudioPreview'

type Media = { name: string; url: string }
type NumberedMedia = Media & { index: number; tag?: string }
type Reference = Media & { id: string; tag: string; displayTag: string; kind: 'image' | 'audio' }

const props = defineProps<{
  prompt: string
  styleSection?: { name: string; text: string; bodyStart: number }
  images: readonly NumberedMedia[]
  audios: readonly NumberedMedia[]
  firstFrame?: Media
}>()

const gallery = ref<HTMLElement>()
const audioId = ref<string>()
const brokenImages = reactive(new Set<string>())
const preview = ref<{ reference: Reference; position: { left: string; top: string; width: string } } | null>(null)
const { player: hoverAudioEl, scheduleAudioPreview, cancelAudioStart, stopAudioPreview } = useScriptVideoAudioPreview()
let previewDismissal: ReturnType<typeof setTimeout> | undefined

const numberedReferences = computed<Reference[]>(() => [
  ...props.images.map(asset => {
    const tag = asset.tag || `@图片${asset.index}`
    return { ...asset, id: `image-${asset.index}`, tag, displayTag: tag, kind: 'image' as const }
  }),
  ...props.audios.map(asset => {
    const displayTag = `@音频${asset.index}`
    return { ...asset, id: `audio-${asset.index}`, tag: asset.tag || displayTag, displayTag, kind: 'audio' as const }
  }),
])
const references = computed<Reference[]>(() => props.firstFrame ? [
  { ...props.firstFrame, id: 'first-frame', tag: '首帧', displayTag: '首帧', kind: 'image' },
  ...numberedReferences.value,
] : numberedReferences.value)
const selectedAudio = computed(() => numberedReferences.value.find(reference => reference.id === audioId.value))
const promptBody = computed(() => props.prompt.slice(props.styleSection?.bodyStart ?? 0))
const promptParts = computed(() => {
  const prompt = promptBody.value
  const byTag = new Map(numberedReferences.value.map(reference => [reference.tag, reference]))
  if (!byTag.size) return [{ text: prompt, reference: undefined }]
  const tags = [...byTag.keys()].sort((a, b) => b.length - a.length)
    .map(tag => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const tokens = new RegExp(`(${tags.join('|')})(?!\\d)`, 'g')
  return prompt.split(tokens).filter(Boolean).map(text => ({ text, reference: byTag.get(text) }))
})

function showPreview(reference: Reference, event: Event, inline = false) {
  if (reference.kind === 'audio' && !inline) return
  if (!reference.url || reference.kind === 'image' && brokenImages.has(reference.url)) {
    closePreview()
    return
  }
  keepPreviewOpen()
  if (preview.value?.reference.id !== reference.id) {
    if (reference.kind === 'audio') scheduleAudioPreview()
    else stopAudioPreview()
  }
  const target = event.currentTarget as HTMLElement
  const { left, top, bottom } = target.getBoundingClientRect()
  const margin = 8
  const width = Math.min(reference.kind === 'audio' ? 280 : 216, window.innerWidth - margin * 2)
  const height = reference.kind === 'audio' ? 72 : 176
  preview.value = {
    reference,
    position: {
      left: `${Math.min(Math.max(left, margin), window.innerWidth - width - margin)}px`,
      top: `${bottom + height + margin <= window.innerHeight ? bottom + margin : Math.max(margin, top - height - margin)}px`,
      width: `${width}px`,
    },
  }
}

function selectReference(reference: Reference, event: Event) {
  if (reference.kind === 'audio') {
    closePreview()
    audioId.value = audioId.value === reference.id ? undefined : reference.id
  } else {
    showPreview(reference, event)
  }
}

function jumpToReference(reference: Reference) {
  if (reference.kind === 'audio') {
    closePreview()
    audioId.value = reference.id
  }
  const button = gallery.value?.querySelector<HTMLButtonElement>(`[data-reference="${reference.id}"]`)
  button?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  button?.focus({ preventScroll: true })
}

function keepPreviewOpen() {
  clearTimeout(previewDismissal)
  previewDismissal = undefined
}

function leavePreview() {
  if (preview.value?.reference.kind !== 'audio') closePreview()
  else {
    cancelAudioStart()
    if (previewDismissal === undefined) previewDismissal = setTimeout(closePreview, 180)
  }
}

function closePreview() {
  keepPreviewOpen()
  stopAudioPreview()
  preview.value = null
}

function closeImagePreview() {
  if (preview.value?.reference.kind === 'image') closePreview()
}

function previewImageFailed() {
  if (preview.value) brokenImages.add(preview.value.reference.url)
  closePreview()
}

onMounted(() => {
  window.addEventListener('scroll', closePreview, true)
  window.addEventListener('resize', closePreview)
})
onBeforeUnmount(() => {
  keepPreviewOpen()
  window.removeEventListener('scroll', closePreview, true)
  window.removeEventListener('resize', closePreview)
  stopAudioPreview()
})
</script>

<style scoped>
.sv-final-prompt, .sv-prompt-media {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.sv-reference-strip {
  display: flex;
  gap: 7px;
  overflow-x: auto;
  padding: 3px 3px 7px;
  overscroll-behavior-inline: contain;
}
.sv-reference {
  display: grid;
  flex: 0 0 91px;
  gap: 3px;
  min-width: 0;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-input, var(--bg-2));
  color: var(--text-1);
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.sv-reference:hover, .sv-reference:focus, .sv-reference[aria-pressed='true'] { border-color: var(--accent); }
.sv-reference-thumb {
  position: relative;
  display: grid;
  place-items: center;
  height: 50px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--bg-2);
  color: var(--accent-text);
}
.sv-reference-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.sv-reference-number {
  position: absolute;
  inset: auto auto 2px 2px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--surface-raised);
  color: var(--accent-text);
  font-size: 10px;
  line-height: 15px;
}
.sv-reference-name {
  overflow: hidden;
  color: var(--text-1);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 17px;
}
.sv-prompt-media audio { width: min(100%, 360px); height: 32px; }
.sv-prompt-text {
  max-height: min(46dvh, 440px);
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-input, var(--bg-2));
  color: var(--text-0);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  scrollbar-gutter: stable;
  font-size: 13px;
  line-height: 1.85;
}
.sv-prompt-mention {
  display: inline;
  padding: 0 2px;
  border: 0;
  border-radius: 4px;
  background: var(--accent-bg);
  color: var(--accent-text);
  font: inherit;
  cursor: pointer;
  user-select: text;
  white-space: nowrap;
}
.sv-prompt-mention:hover { text-decoration: underline; }
.sv-reference:focus-visible, .sv-prompt-mention:focus-visible, .sv-prompt-text:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}
.sv-reference-preview {
  position: fixed;
  z-index: var(--z-tooltip, 1200);
  box-sizing: border-box;
  display: grid;
  gap: 6px;
  padding: 7px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--text-1);
  box-shadow: var(--shadow-lg);
  pointer-events: none;
}
.sv-reference-preview img {
  display: block;
  width: 100%;
  height: 136px;
  border-radius: 5px;
  background: var(--bg-2);
  object-fit: contain;
}
.sv-reference-preview-audio { pointer-events: auto; }
.sv-reference-preview-audio audio { display: block; width: 100%; height: 32px; }
.sv-reference-preview span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 18px;
}
</style>
