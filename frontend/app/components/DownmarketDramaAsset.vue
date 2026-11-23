<template>
  <article class="drama-asset">
    <div class="drama-asset-image">
      <img v-if="asset.image" :src="asset.image" :alt="asset.name" loading="lazy">
      <span v-else><Image :size="22" aria-hidden="true" />{{ asset.imageStatus === 'running' ? '正在生成' : '待出图' }}</span>
    </div>
    <header>
      <h3>{{ asset.name }}</h3>
      <span>{{ kindLabel }}</span>
    </header>
    <label class="drama-field">
      生图提示词
      <textarea v-model="prompt" rows="3" maxlength="3200" :disabled="disabled" />
    </label>
    <div class="drama-inline">
      <label class="btn btn-sm drama-upload reference-file">
        {{ reference ? '更换参考图' : '添加参考图（可选）' }}
        <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="disabled || uploading" @change="attach">
      </label>
    </div>
    <div v-if="reference" class="drama-inline">
      <span>{{ reference.name }}</span>
      <button class="btn btn-sm" type="button" :disabled="disabled" @click="reference = undefined">移除参考图</button>
    </div>
    <p v-if="error || asset.imageError" class="asset-error" role="alert">{{ error || asset.imageError }}</p>
    <div class="drama-inline">
      <button class="btn" type="button" :disabled="disabled || uploading || asset.imageStatus === 'running' || !prompt.trim()" @click="generate">
        {{ uploading ? '上传参考图中…' : asset.imageStatus === 'running' ? '正在生成…' : asset.image ? '重新出图' : '生成单张图片' }}
      </button>
      <a v-if="asset.image" class="btn btn-ghost" :href="asset.image" :download="downloadName">下载图片</a>
    </div>
  </article>
</template>

<script setup lang="ts">
import { Image } from 'lucide-vue-next'
import { uploadAPI } from '~/composables/useApi'
import type { DramaAsset, DramaCommand } from '../../../backend/src/services/downmarket-drama-types'

const props = defineProps<{ asset: DramaAsset; disabled: boolean }>()
const emit = defineEmits<{ generate: [command: Extract<DramaCommand, { action: 'image' }>] }>()
const prompt = ref(props.asset.prompt)
const reference = ref<{ url: string; name: string }>()
const error = ref('')
const uploading = ref(false)
const kindLabel = computed(() => ({ character: '人物', scene: '场景', prop: '物品' })[props.asset.kind])
const downloadName = computed(() => kindLabel.value + '-' + props.asset.name.replace(/[\\/:*?"<>|]/gu, '_') + (props.asset.image?.match(/\.[a-z0-9]+$/iu)?.[0] || '.png'))
watch(() => props.asset.prompt, (next, previous) => { if (prompt.value === previous) prompt.value = next })

async function attach(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 12_000_000) {
    error.value = '请选择 12 MB 以内的 PNG、JPEG 或 WebP。'
    return
  }
  error.value = ''
  uploading.value = true
  try { reference.value = { ...(await uploadAPI.image(file)), name: file.name } }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '参考图上传失败。' }
  finally { uploading.value = false }
}

function generate() {
  error.value = ''
  emit('generate', { action: 'image', assetId: props.asset.id, prompt: prompt.value, reference: reference.value?.url })
}
</script>

<style scoped>
.drama-asset { min-width: 0; display: grid; align-content: start; gap: 10px; padding: 12px; border-radius: 14px; border: 1px solid var(--surface-outline); background: var(--surface-muted); }
.drama-asset-image { display: grid; place-items: center; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 9px; background: var(--surface-input); }
.drama-asset-image img { width: 100%; height: 100%; object-fit: contain; min-height: 0; }
.drama-asset-image span { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; }
.drama-asset header { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.drama-asset header span, .reference-file { color: var(--text-2); }
.drama-asset h3 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
.drama-inline span { font-size: 12px; overflow-wrap: anywhere; }
.asset-error { margin: 0; color: var(--danger, #ad4042); }
</style>
