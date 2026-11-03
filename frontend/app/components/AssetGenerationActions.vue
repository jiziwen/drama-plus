<template>
  <div class="asset-generation-actions" @click.stop @keydown.stop>
    <button type="button" class="btn btn-sm" @click="$emit('detail')">{{ t('assetGeneration.detail') }}</button>
    <div class="asset-generation-split">
      <button type="button" class="btn btn-sm" :disabled="busy" @click="$emit('text')">
        <Loader2 v-if="busy" :size="12" class="animate-spin" />
        {{ t(hasImage ? 'assetGeneration.textRedraw' : 'assetGeneration.textGenerate') }}
      </button>
      <AppMenu v-model:open="menuOpen" :min-width="180">
        <template #trigger>
          <button type="button" class="btn btn-sm asset-generation-more" :disabled="busy" :aria-label="t('assetGeneration.referenceRedraw')">
            <ChevronDown :size="13" />
          </button>
        </template>
        <AppMenuItem @click="openReference">{{ t('assetGeneration.referenceRedraw') }}</AppMenuItem>
      </AppMenu>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Loader2 } from 'lucide-vue-next'
defineProps({ busy: Boolean, hasImage: Boolean })
const emit = defineEmits(['detail', 'text', 'reference'])
const { t } = useI18n()
const menuOpen = ref(false)
function openReference() { menuOpen.value = false; emit('reference') }
</script>

<style scoped>
.asset-generation-actions, .asset-generation-split { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; flex-shrink: 0; }
.asset-generation-actions .btn { white-space: nowrap; flex-shrink: 0; }
.asset-generation-split { gap: 0; flex-wrap: nowrap; }
.asset-generation-split > .btn { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.asset-generation-more { border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: -1px; min-width: 30px; }
</style>
