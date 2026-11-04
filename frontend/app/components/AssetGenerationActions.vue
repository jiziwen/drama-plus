<template>
  <div class="asset-generation-actions" @click.stop @keydown.stop>
    <button type="button" class="btn btn-sm" @click="$emit('detail')">{{ t('assetGeneration.detail') }}</button>
    <button type="button" class="btn btn-sm" :disabled="busy" @click="$emit('redraw')">
      <Loader2 v-if="busy" :size="12" class="animate-spin" />
      {{ t('assetGeneration.redraw') }}
    </button>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
defineProps({ busy: Boolean })
defineEmits(['detail', 'redraw'])
const { t } = useI18n()
</script>

<style scoped>
.asset-generation-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.asset-generation-actions .btn { white-space: nowrap; flex-shrink: 0; }
</style>
