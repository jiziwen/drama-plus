<template>
  <img
    v-if="imageSrc"
    :key="imageSrc"
    class="preview-uploaded"
    :src="imageSrc"
    :alt="asset.name"
    loading="lazy"
    decoding="async"
    @error="onImageError"
  />
  <span v-else-if="asset.image" class="preview-initial preview-unavailable" role="img" :aria-label="`${asset.name} 图片暂不可用`">图片暂不可用</span>
  <span v-else-if="asset.kind === 'audio'" class="preview-initial"><Headphones :size="22" aria-hidden="true" /></span>
  <span v-else class="preview-initial">{{ asset.name.slice(0, 1) }}</span>
</template>
<script setup lang="ts">
import { Headphones } from 'lucide-vue-next'
import { thumbOf } from '~/composables/useMedia'
import type { PreviewAsset } from '~/utils/scriptVideoPreview'

const props = defineProps<{ asset: PreviewAsset }>()
const failedSrc = ref<string>()

watch(() => props.asset.image, () => { failedSrc.value = undefined }, { flush: 'sync' })

const imageSrc = computed(() => {
  const original = props.asset.image
  if (!original || failedSrc.value === original) return ''
  const thumbnail = thumbOf(original)
  return failedSrc.value === thumbnail ? original : thumbnail
})

function onImageError(event: Event) {
  const source = (event.currentTarget as HTMLImageElement | null)?.getAttribute('src')
  if (source && source === imageSrc.value) failedSrc.value = source
}
</script>
<style scoped>
.preview-uploaded,
.preview-initial {
  display: block;
  width: 100%;
  height: 100%;
}
.preview-uploaded {
  object-fit: cover;
}
.preview-initial {
  display: grid;
  place-items: center;
  background: var(--accent-bg);
  color: var(--accent-text);
  font-size: 22px;
}
.preview-unavailable {
  padding: 4px;
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
}
</style>
