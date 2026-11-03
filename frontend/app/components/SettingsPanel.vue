<template>
  <Teleport to="body">
    <div v-if="isOpen" class="settings-panel-backdrop" @keydown.esc.stop="onEscape">
      <section ref="panel" class="settings-panel" role="dialog" aria-modal="true" :aria-label="t('layout.nav.settings')" tabindex="-1" @keydown.tab="trapFocus">
        <header class="settings-panel-header"><strong>{{ t('layout.nav.settings') }}</strong><button class="btn" @click="close">{{ t('common.close') }} ×</button></header>
        <div class="settings-panel-body"><SettingsContent :initial-tab="initialTab" :config-id="configId" embedded /></div>
      </section>
    </div>
  </Teleport>
</template>
<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()
const { isOpen, initialTab, configId, close } = useSettingsPanel()
const panel = ref<HTMLElement>()
let previousFocus: HTMLElement | null = null
watch(isOpen, async (open) => {
  if (open) { previousFocus = document.activeElement as HTMLElement; await nextTick(); panel.value?.focus() }
  else previousFocus?.focus()
})
function onEscape(event: KeyboardEvent) {
  if (!(event.target as HTMLElement).closest('.overlay')) close()
}
function trapFocus(event: KeyboardEvent) {
  const items = Array.from(panel.value?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex="0"]') || []).filter(el => !el.hasAttribute('disabled') && el.getClientRects().length)
  const first = items[0], last = items[items.length - 1]
  if (!first) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) { event.preventDefault(); first.focus() }
}
</script>
<style scoped>
.settings-panel-backdrop { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--scrim, rgba(0,0,0,.5)); }
.settings-panel { width: min(1400px, 100%); height: min(900px, 94vh); display: flex; flex-direction: column; min-height: 0; background: var(--bg-base); border: 1px solid var(--border); border-radius: 16px; box-shadow: 0 24px 80px rgba(0,0,0,.3); outline: none; overflow: hidden; }
.settings-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 12px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.settings-panel-body { flex: 1; min-height: 0; }
@media (max-width: 700px) { .settings-panel-backdrop { padding: 0; } .settings-panel { height: 100dvh; border-radius: 0; } }
</style>
