<template>
  <img
    v-if="asset.image"
    class="preview-uploaded"
    :src="asset.image"
    :alt="asset.name"
    loading="lazy"
    decoding="async"
  />
  <span v-else-if="asset.kind === 'audio'" class="preview-initial"><Headphones :size="22" aria-hidden="true" /></span>
  <span v-else class="preview-initial">{{ asset.name.slice(0, 1) }}</span>
</template>
<script setup lang="ts">
import { Headphones } from 'lucide-vue-next'
import type { PreviewAsset } from '~/utils/scriptVideoPreview'
defineProps<{ asset: PreviewAsset }>()
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
</style>
