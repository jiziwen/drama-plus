<template>
  <div class="reference-editor" :aria-busy="uploading">
    <div class="reference-actions">
      <label class="btn btn-sm reference-upload" :class="{ disabled: busy || modelValue.length >= 4 }">
        {{ uploading ? t('assetGeneration.uploading') : t('assetGeneration.upload') }}
        <input type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="busy || modelValue.length >= 4" @change="upload" />
      </label>
      <button class="btn btn-sm" type="button" :disabled="busy || !currentImage || modelValue.length >= 4" @click="add(currentImage)">{{ t('assetGeneration.useCurrent') }}</button>
      <button class="btn btn-sm" type="button" :disabled="busy || !history.length" @click="showHistory = !showHistory">{{ t('assetGeneration.history') }}</button>
      <small>{{ modelValue.length }} / 4</small>
    </div>
    <p class="reference-hint">{{ t('assetGeneration.referenceHint') }}</p>
    <div v-if="modelValue.length" class="reference-grid">
      <div v-for="(source, index) in modelValue" :key="source" class="reference-card">
        <img :src="assetReferenceSrc(source)" :alt="t('assetGeneration.referenceN', { n: index + 1 })" />
        <span v-if="index === 0" class="tag tag-accent">{{ t('assetGeneration.main') }}</span>
        <div class="reference-card-actions">
          <button v-if="index" type="button" class="btn btn-sm" :disabled="busy" @click="makeMain(index)">{{ t('assetGeneration.makeMain') }}</button>
          <button type="button" class="btn btn-sm" :disabled="busy" @click="emit('update:modelValue', modelValue.filter((_, i) => i !== index))">{{ t('assetGeneration.remove') }}</button>
        </div>
      </div>
    </div>
    <div v-else class="reference-empty">{{ t('assetGeneration.referenceRequired') }}</div>
    <div v-if="showHistory" class="reference-history" :aria-label="t('assetGeneration.history')">
      <button v-for="source in uniqueAssetReferences(history)" :key="source" type="button" :disabled="busy || modelValue.length >= 4 || hasReference(source)" @click="add(source)">
        <img :src="assetReferenceSrc(source)" :alt="t('assetGeneration.chooseHistory')" loading="lazy" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { uploadAPI } from '~/composables/useApi'
import { assetReferenceSrc, canonicalAssetReference, uniqueAssetReferences } from '~/composables/useAssetGeneration'
const props = withDefaults(defineProps<{ modelValue: string[]; currentImage?: string; history?: string[]; disabled?: boolean }>(), { currentImage: '', history: () => [], disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string[]]; error: [message: string]; uploading: [value: boolean] }>()
const { t } = useI18n()
const uploading = ref(false)
const showHistory = ref(false)
const busy = computed(() => props.disabled || uploading.value)
let alive = true
onBeforeUnmount(() => { alive = false })
function hasReference(source: string) { return props.modelValue.some(value => canonicalAssetReference(value) === canonicalAssetReference(source)) }
function add(source: string) {
  if (busy.value || !source || hasReference(source)) return
  if (props.modelValue.length >= 4) { emit('error', t('assetGeneration.maxReferences')); return }
  emit('update:modelValue', uniqueAssetReferences([...props.modelValue, source]))
}
function makeMain(index: number) { emit('update:modelValue', [props.modelValue[index], ...props.modelValue.filter((_, i) => i !== index)]) }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files || [])]
  input.value = ''
  if (busy.value || !files.length) return
  if (files.length + props.modelValue.length > 4) { emit('error', t('assetGeneration.maxReferences')); return }
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 30 * 1024 * 1024)) { emit('error', t('assetGeneration.invalidFile')); return }
  uploading.value = true; emit('uploading', true)
  let refs = uniqueAssetReferences(props.modelValue)
  try {
    for (const file of files) {
      const result = await uploadAPI.image(file)
      if (!alive) return
      refs = uniqueAssetReferences([...refs, result.path])
      emit('update:modelValue', [...refs])
    }
  } catch (error: any) { if (alive) emit('error', error.message || t('assetGeneration.uploadFailed')) }
  finally { uploading.value = false; if (alive) emit('uploading', false) }
}
</script>

<style scoped>
.reference-actions, .reference-card-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.reference-actions small, .reference-hint { color: var(--text-3); font-size: 12px; }
.reference-hint { margin: 10px 0; line-height: 1.5; }
.reference-upload { position: relative; overflow: hidden; cursor: pointer; }
.reference-upload input { position: absolute; inset: 0; width: 100%; opacity: 0; cursor: pointer; }
.reference-upload:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.reference-upload.disabled { opacity: .5; cursor: default; }
.reference-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; }
.reference-card { padding: 8px; border: 1px solid var(--border); border-radius: 10px; min-width: 0; }
.reference-card img { width: 100%; height: 130px; object-fit: contain; background: var(--bg-input); border-radius: 6px; }
.reference-card .tag { display: inline-block; margin: 6px 0; }
.reference-card-actions { margin-top: 6px; }
.reference-empty { border: 1px dashed var(--border-strong); padding: 24px; border-radius: 10px; text-align: center; color: var(--text-3); }
.reference-history { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
.reference-history button { background: var(--bg-input); border: 1px solid var(--border); padding: 4px; border-radius: 8px; cursor: pointer; }
.reference-history button:focus-visible { outline: 2px solid var(--accent); }
.reference-history img { width: 90px; height: 90px; object-fit: contain; }
</style>
