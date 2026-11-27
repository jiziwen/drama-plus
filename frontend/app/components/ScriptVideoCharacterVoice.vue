<template>
  <section v-if="asset.kind === 'character'" class="sv-character-voice" :aria-label="asset.name + '的角色声音'">
    <input
      ref="fileInput"
      type="file"
      accept=".mp3,.wav"
      hidden
      :disabled="disabled || uploading || generating"
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
      <button type="button" :disabled="disabled || uploading || generating" @click="fileInput?.click()">
        {{ uploading ? '正在上传…' : asset.voiceAudio?.url ? '替换角色声音' : '上传角色声音' }}
      </button>
      <button type="button" :disabled="disabled || uploading || generating" @click="toggleGenerate">
        {{ generating ? '正在生成声音…' : '生成角色声音' }}
      </button>
      <button v-if="videoUrl" type="button" :aria-expanded="showVideo" :aria-controls="videoId" @click="showVideo = !showVideo">
        {{ showVideo ? '收起生成视频' : '查看生成视频' }}
      </button>
      <button
        v-if="asset.voiceAudio?.url"
        type="button"
        class="sv-voice-remove"
        :disabled="disabled || uploading || generating"
        @click="$emit('remove')"
      >移除角色声音</button>
      <label class="sv-voice-model">
        <input
          type="checkbox"
          :checked="asset.voiceMode === 'model'"
          :disabled="disabled || uploading || generating"
          @change="setModelVoice"
        />
        无参考音频时允许模型配音
      </label>
    </div>
    <video v-if="showVideo && videoUrl" :id="videoId" class="sv-voice-video" :src="videoUrl" :aria-label="'查看' + asset.name + '的生成视频'" controls preload="metadata" />
    <div v-if="showGenerate" class="sv-voice-generate">
      <label>Seedance 2.0 Mini 视频服务
        <select v-model="selectedModel" :disabled="disabled || generating || generationLoading || !generationOptions?.length">
          <option value="" disabled>{{ generationLoading ? '正在检查可用服务…' : generationOptions?.length ? '选择视频服务' : '暂无可用的视频服务' }}</option>
          <option v-for="option in generationOptions || []" :key="option.key" :value="option.key">{{ option.label }} · {{ option.resolution }}</option>
        </select>
      </label>
      <small v-if="generationMessage" role="status">{{ generationMessage }}</small>
      <small v-else-if="!generationOptions?.length && !generationLoading">请在模型设置中检查即梦积分或 LibTV 账号与模型可用性。</small>
      <label>声音描述
        <textarea v-model.trim="voiceDescription" rows="2" maxlength="500" :disabled="disabled || generating" placeholder="例如：沉稳温暖的成年女性声音，语速自然" @input="descriptionEdited = true" />
      </label>
      <small v-if="descriptionLoading" role="status">正在从剧本提取声音描述…</small>
      <small v-else-if="descriptionError" role="alert">{{ descriptionError }} <button type="button" :disabled="disabled" @click="$emit('open-description')">重试</button></small>
      <small v-else-if="descriptionSource && !descriptionEdited">来源：{{ descriptionSource }}</small>
      <small v-else-if="descriptionSuggestion && !descriptionSuggestion.text && !descriptionEdited" role="status">剧本里的声音线索不足，请手动填写。</small>
      <label>试音台词
        <textarea v-model.trim="sampleText" rows="2" maxlength="80" :disabled="disabled || generating" placeholder="输入角色要说的一句话，最多 80 字" />
      </label>
      <div class="sv-voice-generate-actions">
        <button type="button" :disabled="disabled || uploading || generating || generationLoading || !selectedModel || !voiceDescription.trim() || !sampleText.trim()" @click="generateVoice">
          {{ generating ? '正在生成…' : generationError ? '重新生成' : '开始生成' }}
        </button>
        <button type="button" :disabled="generating" @click="showGenerate = false">取消</button>
      </div>
    </div>
    <div v-if="generationError && !generating" class="sv-voice-generation-error" role="alert">
      <strong>角色声音生成失败</strong>
      <span>{{ generationError }}</span>
    </div>
    <small v-if="showGenerate" class="sv-voice-generation-note">生成 5 秒{{ selectedOption ? `、${selectedOption.resolution}` : '' }}的有声视频，可能消耗视频额度。提取的音频会保存为角色声音。</small>
    <span class="sv-voice-description">已设置的角色声音优先使用。关闭后，有对白或心声时需要参考音频。</span>
    <small>MP3 / WAV，建议用 5–10 秒的清晰人声，最大 15 MB</small>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { PreviewAsset } from '~/utils/scriptVideoPreview'

const props = defineProps<{
  asset: PreviewAsset
  disabled?: boolean
  uploading?: boolean
  generating?: boolean
  videoUrl?: string
  generationError?: string
  generationMessage?: string
  generationLoading?: boolean
  descriptionSuggestion?: { text: string; sourceLabel?: string }
  descriptionLoading?: boolean
  descriptionError?: string
  generationOptions?: { key: string; label: string; configId: number; model: string; resolution: '480p' | '720p' }[]
}>()
const emit = defineEmits<{ upload: [file: File]; remove: []; 'model-voice': [enabled: boolean]; 'open-description': []; generate: [request: { configId: number; model: string; description: string; dialogue: string }] }>()
const fileInput = ref<HTMLInputElement>()
const showGenerate = ref(false)
const showVideo = ref(false)
const videoId = `voice-video-${useId()}`
watch(() => props.videoUrl, () => { showVideo.value = false })
const voiceDescription = ref('')
const descriptionEdited = ref(false)
const descriptionSource = ref('')
const sampleText = ref('这也不会那也不会，你到底是怎么修炼到现在的。')
watch(() => props.descriptionSuggestion, value => {
  if (!descriptionEdited.value && value) {
    voiceDescription.value = value.text
    descriptionSource.value = value.sourceLabel || ''
  }
}, { immediate: true })
function toggleGenerate() {
  showGenerate.value = !showGenerate.value
  if (showGenerate.value) emit('open-description')
}
const selectedModel = ref('')
const selectedOption = computed(() => props.generationOptions?.find(item => item.key === selectedModel.value))
watch(() => props.generationOptions, options => {
  if (!options?.some(option => option.key === selectedModel.value)) selectedModel.value = options?.[0]?.key || ''
}, { immediate: true })
function generateVoice() {
  const option = selectedOption.value
  const description = voiceDescription.value.trim(), dialogue = sampleText.value.trim()
  if (props.disabled || props.uploading || props.generating || props.generationLoading || !option || !description || description.length > 500 || !dialogue || dialogue.length > 80) return
  emit('generate', { configId: option.configId, model: option.model, description, dialogue })
}
function setModelVoice(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  if (!props.disabled && !props.uploading && !props.generating && props.asset.kind === 'character') {
    emit('model-voice', input.checked)
  }
}
function selectFile(event: Event) {
  const input = event.currentTarget as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file && !props.disabled && !props.uploading && !props.generating && props.asset.kind === 'character') {
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
.sv-voice-video { display: block; width: 100%; max-width: 360px; max-height: 240px; background: #000; border-radius: 5px; }
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
.sv-voice-generate { display: grid; gap: 7px; max-width: 360px; }
.sv-voice-generate label { display: grid; gap: 4px; font-size: 12px; }
.sv-voice-generate textarea, .sv-voice-generate select { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: 5px; padding: 6px; background: var(--surface-input, var(--bg-2)); color: var(--text-1); font: inherit; }
.sv-voice-generate-actions { display: flex; gap: 8px; }
.sv-voice-generate-actions button { padding: 4px 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-input, var(--bg-2)); color: var(--text-1); font: inherit; cursor: pointer; }
.sv-voice-generate-actions button:disabled { opacity: .55; cursor: default; }
.sv-voice-generation-error, .sv-voice-generation-note { max-width: 360px; }
.sv-voice-generation-error {
  display: grid;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--error, #efa7ae) 40%, transparent);
  border-radius: 6px;
  background: var(--error-bg, #efa7ae14);
  color: var(--error, #efa7ae);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.sv-voice-description, .sv-character-voice small { color: var(--text-3); font-size: 11px; }
</style>
