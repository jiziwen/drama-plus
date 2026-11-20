<template>
  <section v-if="asset.kind === 'character'" class="sv-character-voice" :aria-label="asset.name + '的角色声音'">
    <input
      ref="fileInput"
      type="file"
      accept=".mp3,.wav"
      hidden
      :disabled="disabled || uploading"
      @change="selectFile"
    />
    <template v-if="asset.voiceAudio?.url">
      <span class="sv-voice-name">{{ asset.voiceAudio.name }}</span>
      <audio
        :src="asset.voiceAudio.url"
        :aria-label="'试听' + asset.name + '的角色声音'"
        controls
        preload="metadata"
      />
    </template>
    <div class="sv-voice-controls">
      <button type="button" :disabled="disabled || uploading" @click="fileInput?.click()">
        {{ uploading ? '正在上传…' : asset.voiceAudio?.url ? '替换角色声音' : '上传角色声音' }}
      </button>
      <button
        v-if="asset.voiceAudio?.url"
        type="button"
        class="sv-voice-remove"
        :disabled="disabled || uploading"
        @click="$emit('remove')"
      >移除角色声音</button>
      <label class="sv-voice-model">
        <input
          type="checkbox"
          :checked="asset.voiceMode === 'model'"
          :disabled="disabled || uploading"
          @change="setModelVoice"
        />
        无参考音频时允许模型配音
      </label>
    </div>
    <span class="sv-voice-description">已上传的角色声音优先使用。关闭后，有对白或心声时需要参考音频。</span>
    <small>MP3 / WAV，建议用 5–10 秒的清晰人声，最大 15 MB</small>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PreviewAsset } from '~/utils/scriptVideoPreview'

const props = defineProps<{
  asset: PreviewAsset
  disabled?: boolean
  uploading?: boolean
}>()
const emit = defineEmits<{ upload: [file: File]; remove: []; 'model-voice': [enabled: boolean] }>()
const fileInput = ref<HTMLInputElement>()
function setModelVoice(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const enabled = input.checked
  input.checked = props.asset.voiceMode === 'model'
  if (!props.disabled && !props.uploading && props.asset.kind === 'character') {
    emit('model-voice', enabled)
  }
}
function selectFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file && !props.disabled && !props.uploading && props.asset.kind === 'character') {
    emit('upload', file)
  }
}
</script>

<style scoped>
.sv-character-voice {
  display: grid;
  gap: 5px;
  min-width: 0;
  grid-column: 2 / -1;
  color: var(--text-1);
}
.sv-voice-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.sv-character-voice audio {
  display: block;
  width: 100%;
  max-width: 360px;
  height: 32px;
}
.sv-voice-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
.sv-voice-controls button {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-input, var(--bg-2));
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sv-voice-controls button:hover:not(:disabled) { border-color: var(--accent); }
.sv-voice-controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sv-voice-controls button:disabled { opacity: .55; cursor: default; }
.sv-voice-model { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.sv-voice-model input { margin: 0; accent-color: var(--accent); }
.sv-voice-controls .sv-voice-remove { padding-inline: 0; border-color: transparent; background: transparent; color: var(--text-2); }
.sv-voice-description, .sv-character-voice small { color: var(--text-3); font-size: 11px; }
</style>
