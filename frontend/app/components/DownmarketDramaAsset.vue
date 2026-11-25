<template>
  <article class="drama-asset">
    <button v-if="asset.image" type="button" class="drama-asset-image drama-asset-preview"
      :aria-label="`查看${asset.name}大图`" aria-haspopup="dialog" title="点击查看大图" @click="openPreview">
      <img :src="asset.image" :alt="asset.name" loading="lazy">
    </button>
    <div v-else class="drama-asset-image">
      <span><Image :size="22" aria-hidden="true" />{{ asset.imageStatus === 'running' ? '正在生成' : '待出图' }}</span>
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
    <Teleport to="body">
      <dialog ref="previewDialog" class="drama-image-dialog" :aria-label="`${asset.name}大图`" @click="closeOnBackdrop">
        <div class="drama-image-head">
          <h2>{{ asset.name }}</h2>
          <button type="button" class="btn btn-icon" aria-label="关闭大图" @click="previewDialog?.close()"><X :size="18" /></button>
        </div>
        <div class="drama-image-body"><img v-if="asset.image" :src="asset.image" :alt="asset.name"></div>
      </dialog>
    </Teleport>
  </article>
</template>

<script setup lang="ts">
import { Image, X } from 'lucide-vue-next'
import { uploadAPI } from '~/composables/useApi'
import type { DramaAsset, DramaCommand } from '../../../backend/src/services/downmarket-drama-types'

const props = defineProps<{ asset: DramaAsset; disabled: boolean }>()
const emit = defineEmits<{ generate: [command: Extract<DramaCommand, { action: 'image' }>] }>()
const prompt = ref(props.asset.prompt)
const reference = ref<{ url: string; name: string }>()
const error = ref('')
const uploading = ref(false)
const previewDialog = ref<HTMLDialogElement | null>(null)
const kindLabel = computed(() => ({ character: '人物', scene: '场景', prop: '物品' })[props.asset.kind])
const downloadName = computed(() => kindLabel.value + '-' + props.asset.name.replace(/[\\/:*?"<>|]/gu, '_') + (props.asset.image?.match(/\.[a-z0-9]+$/iu)?.[0] || '.png'))
watch(() => props.asset.prompt, (next, previous) => { if (prompt.value === previous) prompt.value = next })
watch(() => props.asset.image, image => { if (!image) previewDialog.value?.close() })

function openPreview() {
  if (props.asset.image && previewDialog.value && !previewDialog.value.open) previewDialog.value.showModal()
}

function closeOnBackdrop(event: MouseEvent) {
  const dialog = previewDialog.value
  if (!dialog || event.target !== dialog) return
  const rect = dialog.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close()
}

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
.drama-asset-preview { width: 100%; padding: 0; border: 0; cursor: zoom-in; }
.drama-asset-preview:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.drama-asset-image img { width: 100%; height: 100%; object-fit: contain; min-height: 0; }
.drama-asset-image span { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; }
.drama-asset header { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.drama-asset header span, .reference-file { color: var(--text-2); }
.drama-asset h3 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
.drama-inline span { font-size: 12px; overflow-wrap: anywhere; }
.asset-error { margin: 0; color: var(--danger, #ad4042); }
.drama-image-dialog { width: min(1200px, 94vw); max-width: 94vw; max-height: 92dvh; margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--surface-outline-strong); border-radius: 14px; background: var(--surface-raised); color: var(--text-1); }
.drama-image-dialog::backdrop { background: rgb(0 0 0 / 75%); }
.drama-image-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--surface-outline); }
.drama-image-head h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 15px; color: var(--text-0); }
.drama-image-head button { flex-shrink: 0; }
.drama-image-body { display: grid; place-items: center; padding: 12px; overflow: auto; max-height: calc(92dvh - 58px); }
.drama-image-body img { display: block; max-width: 100%; max-height: calc(92dvh - 82px); object-fit: contain; }
</style>
