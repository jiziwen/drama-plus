<template>
  <Teleport to="body">
    <dialog ref="dialog" class="asset-image-dialog" :aria-labelledby="titleId" @click.self="closeOnBackdrop" @close="onClose">
      <header class="asset-image-head">
        <h2 :id="titleId">{{ asset?.name }}</h2>
        <button type="button" class="btn btn-icon" aria-label="关闭大图" autofocus @click="dialog?.close()"><X :size="18" /></button>
      </header>
      <div class="asset-image-body">
        <img v-if="asset && !imageUnavailable" :src="asset.image" :alt="asset.name" @error="imageUnavailable = true" />
        <p v-else-if="imageUnavailable" role="status">图片暂不可用</p>
      </div>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { X } from 'lucide-vue-next'

const titleId = useId()
const dialog = ref<HTMLDialogElement>()
const asset = shallowRef<{ image: string; name: string }>()
const imageUnavailable = ref(false)
let trigger: HTMLElement | undefined

async function open(image: string, name: string, source: EventTarget | null) {
  const viewer = dialog.value
  if (!image || !viewer || viewer.open || asset.value) return
  asset.value = { image, name }
  trigger = source instanceof HTMLElement ? source : undefined
  await nextTick()
  if (viewer.isConnected) viewer.showModal()
}

function closeOnBackdrop(event: MouseEvent) {
  const viewer = dialog.value
  if (!viewer) return
  const rect = viewer.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) viewer.close()
}

function onClose() {
  asset.value = undefined
  imageUnavailable.value = false
  trigger?.focus({ preventScroll: true })
  trigger = undefined
}

defineExpose({ open })
</script>

<style scoped>
.asset-image-dialog { width: min(1200px, 94vw); max-width: 94vw; max-height: 92dvh; margin: auto; padding: 0; overflow: hidden; border: 1px solid var(--surface-outline-strong); border-radius: 14px; background: var(--surface-raised); color: var(--text-1); }
.asset-image-dialog::backdrop { background: rgb(0 0 0 / 75%); }
.asset-image-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--surface-outline); }
.asset-image-head h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 15px; color: var(--text-0); }
.asset-image-head button { flex-shrink: 0; }
.asset-image-body { display: grid; place-items: center; padding: 12px; overflow: auto; max-height: calc(92dvh - 58px); }
.asset-image-body img { display: block; max-width: 100%; max-height: calc(92dvh - 82px); object-fit: contain; }
</style>
