<template>
  <section v-if="asset.kind === 'character'" class="sv-character-voice" :aria-label="asset.name + '的角色声音'">
    <template v-if="voiceProfile">
      <small>{{ voiceProfileLabel }}</small>
      <small v-if="episodeSources.length">剧本来源：{{ episodeSources.join('、') }}</small>
      <small v-if="asset.voiceDescription?.text && !showGenerate" class="sv-voice-summary">声音描述：{{ asset.voiceDescription.text }}</small>
      <details v-if="voiceProfile.conflicts.length" class="sv-voice-conflicts">
        <summary>查看有出入的声音线索</summary>
        <ul>
          <li v-for="(clue, index) in voiceProfile.conflicts" :key="index">
            {{ voiceFacetLabels[clue.facet] || clue.facet }}：{{ clue.value }}
            <ul v-if="clue.evidence.length">
              <li v-for="(evidence, evidenceIndex) in clue.evidence" :key="evidenceIndex">
                {{ episodeSource(evidence) }}{{ evidence.quote ? `「${evidence.quote}」` : '' }}
              </li>
            </ul>
          </li>
        </ul>
      </details>
      <div v-if="ageChoices.length" class="sv-voice-age">
        <small v-if="asset.voiceAudio?.url">此造型已有声音，请先移除，再确认所属年龄阶段。</small>
        <small v-else>剧本出现了不同的年龄阶段，请确认当前造型所属阶段。</small>
        <details v-if="voiceProfile.ageEvidence?.length" class="sv-voice-conflicts">
          <summary>查看年龄依据</summary>
          <ul>
            <li v-for="(evidence, index) in voiceProfile.ageEvidence" :key="index">
              {{ voiceAgeLabels[evidence.stage] }} · {{ episodeSource(evidence) }}{{ evidence.quote ? `「${evidence.quote}」` : '' }}
            </li>
          </ul>
        </details>
        <div class="sv-voice-age-actions">
          <label>造型所属年龄
            <select v-model="selectedAge" :disabled="disabled || uploading || generating || !!asset.voiceAudio?.url">
              <option value="" disabled>选择年龄阶段</option>
              <option v-for="age in ageChoices" :key="age" :value="age">{{ voiceAgeLabels[age] }}</option>
            </select>
          </label>
          <button type="button" :disabled="!canConfirmAge" @click="confirmAge">{{ confirmingAge ? '正在确认…' : '确认年龄阶段' }}</button>
        </div>
      </div>
      <small v-if="voiceProfile.audioConflict" role="status">这些造型已有不同的声音。请移除不再使用的声音，保留要共用的声音。</small>
      <small v-else-if="alreadyGenerated && !asset.voiceAudio?.url && !sharedVoicePresent">这个年龄阶段已生成过声音，可上传新的参考音频。</small>
    </template>
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
      <small v-if="sharedVoicePresent && !voiceProfile?.audioConflict">同一年龄阶段的角色造型共用这段声音。</small>
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
      <button v-if="canOfferVoiceGeneration" type="button" :disabled="disabled || uploading || generating" @click="showGenerate = !showGenerate">
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
    <div v-if="showGenerate && canOfferVoiceGeneration" class="sv-voice-generate">
      <label>Seedance 2.0 Mini 视频服务
        <select v-model="selectedModel" :disabled="disabled || generating || generationLoading || !generationOptions?.length">
          <option value="" disabled>{{ generationLoading ? '正在检查可用服务…' : generationOptions?.length ? '选择视频服务' : '暂无可用的视频服务' }}</option>
          <option v-for="option in generationOptions || []" :key="option.key" :value="option.key">{{ option.label }} · {{ option.resolution }}</option>
        </select>
      </label>
      <small v-if="generationMessage" role="status">{{ generationMessage }}</small>
      <small v-else-if="!generationOptions?.length && !generationLoading">请在模型设置中检查即梦积分或 LibTV 账号与模型可用性。</small>
      <label>声音描述
        <textarea
          v-model.trim="voiceDescription"
          rows="3"
          maxlength="500"
          :disabled="disabled || generating"
          placeholder="青年年龄感｜清朗青年男声，中低音区、略带松弛感｜清冷克制，措辞端正，句尾收稳｜中等音量｜正常语速｜中文普通话"
        />
      </label>
      <small v-if="asset.voiceDescription?.sourceLabel && voiceDescription === savedDescription">描述来源：{{ asset.voiceDescription.sourceLabel }}</small>
      <label v-if="needsConflictConfirmation" class="sv-voice-confirm">
        <input v-model="conflictConfirmed" type="checkbox" :disabled="disabled || generating" />
        我已核对有出入的线索，并确认使用以上声音描述
      </label>
      <label>试音台词
        <textarea v-model.trim="sampleText" rows="2" maxlength="80" :disabled="disabled || generating" placeholder="输入角色要说的一句话，最多 80 字" />
      </label>
      <div class="sv-voice-generate-actions">
        <button type="button" :disabled="!canSubmitVoiceGeneration" @click="generateVoice">
          {{ generating ? '正在生成…' : generationError ? '重新生成' : '开始生成' }}
        </button>
        <button type="button" :disabled="generating" @click="showGenerate = false">取消</button>
      </div>
    </div>
    <div v-if="generationError && !generating" class="sv-voice-generation-error" role="alert">
      <strong>角色声音生成失败</strong>
      <span>{{ generationError }}</span>
    </div>
    <small v-if="showGenerate && canOfferVoiceGeneration" class="sv-voice-generation-note">生成 5 秒{{ selectedOption ? `、${selectedOption.resolution}` : '' }}的有声视频，可能消耗视频额度。提取的音频会保存为角色声音。</small>
    <span class="sv-voice-description">已设置的角色声音优先使用。关闭后，有对白或心声时需要参考音频。</span>
    <small>MP3 / WAV，建议用 5–10 秒的清晰人声，最大 15 MB</small>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { PreviewAsset, PreviewVoiceAgeStage, PreviewVoiceGenerationRequest } from '~/utils/scriptVideoPreview'

const props = defineProps<{
  asset: PreviewAsset
  disabled?: boolean
  uploading?: boolean
  generating?: boolean
  videoUrl?: string
  generationError?: string
  generationMessage?: string
  generationLoading?: boolean
  generationOptions?: { key: string; label: string; configId: number; model: string; resolution: '480p' | '720p' }[]
  sharedVoicePresent?: boolean
  alreadyGenerated?: boolean
  confirmingAge?: boolean
}>()
const emit = defineEmits<{
  upload: [file: File]; remove: []; 'model-voice': [enabled: boolean]
  'confirm-age': [ageStage: PreviewVoiceAgeStage]; generate: [request: PreviewVoiceGenerationRequest]
}>()
const fileInput = ref<HTMLInputElement>()
const showGenerate = ref(false)
const showVideo = ref(false)
const videoId = `voice-video-${useId()}`
watch(() => props.videoUrl, () => { showVideo.value = false })
const voiceProfile = computed(() => props.asset.voiceProfile)
const voiceAgeLabels = { child: '儿童', teen: '青少年', adult: '成年', older_adult: '老年', unknown: '年龄阶段待定' }
const voiceDisguiseLabels = { male_as_female: '男扮女装', female_as_male: '女扮男装' }
const voiceFacetLabels = { register: '音域', timbre: '音色', pace: '语速', articulation: '吐字', accent: '口音', delivery: '说话方式', volume: '音量' }
function episodeSource(evidence: { title: string; episodeNumber?: number }) {
  return evidence.episodeNumber ? `第 ${evidence.episodeNumber} 集` : evidence.title
}
const episodeSources = computed(() => {
  const profile = voiceProfile.value
  if (!profile) return []
  const evidence = [
    ...(profile.ageEvidence ?? []),
    ...[...profile.clues, ...profile.conflicts, ...(profile.observations ?? [])].flatMap(clue => clue.evidence),
  ]
  evidence.sort((left, right) => (left.episodeNumber ?? Infinity) - (right.episodeNumber ?? Infinity))
  return [...new Set(evidence.map(episodeSource).filter(Boolean))]
})
const ageChoices = computed(() => voiceProfile.value?.ageConflict ?? [])
const voiceProfileLabel = computed(() => {
  const profile = voiceProfile.value
  if (!profile) return ''
  const age = profile.ageStage === 'unknown' && !ageChoices.value.length ? '' : voiceAgeLabels[profile.ageStage]
  const disguise = profile.disguise ? voiceDisguiseLabels[profile.disguise] : ''
  const details = [age, disguise].filter(Boolean).join(' · ')
  return `${profile.character} · ${details || '常态音色'}`
})
const selectedAge = ref<PreviewVoiceAgeStage | ''>('')
watch(ageChoices, choices => { if (selectedAge.value && !choices.includes(selectedAge.value)) selectedAge.value = '' })
const canConfirmAge = computed(() => !props.disabled && !props.uploading && !props.generating && !props.confirmingAge && !props.asset.voiceAudio?.url &&
  !!selectedAge.value && ageChoices.value.includes(selectedAge.value))
function confirmAge() {
  if (canConfirmAge.value && selectedAge.value) emit('confirm-age', selectedAge.value)
}
const savedDescription = computed(() => props.asset.voiceDescription?.text || '')
const voiceDescription = ref(savedDescription.value)
watch(savedDescription, (description, previous) => {
  if (voiceDescription.value === previous) voiceDescription.value = description
})
const conflictConfirmed = ref(false)
const needsConflictConfirmation = computed(() => !!voiceProfile.value?.conflicts.length)
watch(() => JSON.stringify(voiceProfile.value?.conflicts), () => { conflictConfirmed.value = false })
const canOfferVoiceGeneration = computed(() => !voiceProfile.value || (
  !ageChoices.value.length && !voiceProfile.value.audioConflict && !props.asset.voiceAudio?.url && !props.sharedVoicePresent && !props.alreadyGenerated
))
watch(canOfferVoiceGeneration, allowed => { if (!allowed) showGenerate.value = false })
const sampleText = ref('这也不会那也不会，你到底是怎么修炼到现在的。')
const selectedModel = ref('')
const selectedOption = computed(() => props.generationOptions?.find(item => item.key === selectedModel.value))
watch(() => props.generationOptions, options => {
  if (!options?.some(option => option.key === selectedModel.value)) selectedModel.value = options?.[0]?.key || ''
}, { immediate: true })
const canSubmitVoiceGeneration = computed(() => {
  const description = voiceDescription.value.trim(), dialogue = sampleText.value.trim()
  return canOfferVoiceGeneration.value && !props.disabled && !props.uploading && !props.generating && !props.generationLoading &&
    !!selectedOption.value && !!description && description.length <= 500 && !!dialogue && dialogue.length <= 80 &&
    (!needsConflictConfirmation.value || conflictConfirmed.value)
})
function generateVoice() {
  const option = selectedOption.value
  if (!canSubmitVoiceGeneration.value || !option) return
  emit('generate', {
    configId: option.configId,
    model: option.model,
    description: voiceDescription.value.trim(),
    dialogue: sampleText.value.trim(),
    ...(needsConflictConfirmation.value ? { confirmVoiceConflict: true } : {}),
  })
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
.sv-voice-controls button, .sv-voice-age-actions button {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-input, var(--bg-2));
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.sv-voice-controls button:hover:not(:disabled), .sv-voice-age-actions button:hover:not(:disabled) { border-color: var(--accent); }
.sv-voice-controls button:focus-visible, .sv-voice-age-actions button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sv-voice-controls button:disabled, .sv-voice-age-actions button:disabled { opacity: .55; cursor: default; }
.sv-voice-model { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
.sv-voice-model input { margin: 0; accent-color: var(--accent); }
.sv-voice-controls .sv-voice-remove { padding-inline: 0; border-color: transparent; background: transparent; color: var(--text-2); }
.sv-voice-generate { display: grid; gap: 7px; max-width: 360px; }
.sv-voice-generate label { display: grid; gap: 4px; font-size: 12px; }
.sv-voice-generate .sv-voice-confirm { grid-template-columns: auto 1fr; align-items: start; }
.sv-voice-confirm input { accent-color: var(--accent); }
.sv-voice-conflicts { max-width: 540px; font-size: 12px; overflow-wrap: anywhere; }
.sv-voice-conflicts summary { cursor: pointer; }
.sv-voice-conflicts ul { margin: 4px 0; padding-inline-start: 18px; }
.sv-voice-age { display: grid; gap: 5px; }
.sv-voice-age-actions { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; font-size: 12px; }
.sv-voice-age-actions label { display: grid; gap: 4px; }
.sv-voice-summary { max-width: 540px; overflow-wrap: anywhere; }
.sv-voice-generate textarea, .sv-voice-generate select, .sv-voice-age-actions select { width: 100%; resize: vertical; border: 1px solid var(--border); border-radius: 5px; padding: 6px; background: var(--surface-input, var(--bg-2)); color: var(--text-1); font: inherit; }
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
