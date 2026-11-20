<template>
  <details v-if="account" ref="menu" class="site-account-menu" @keydown.esc.stop="close(true)">
    <summary ref="trigger" :aria-label="t('siteSession.current', { username: account.username })">
      <CircleUserRound :size="16" aria-hidden="true" />
      <span :title="account.username">{{ account.username }}</span>
      <ChevronDown :size="12" aria-hidden="true" />
    </summary>
    <div class="site-account-actions">
      <small class="site-account-role">{{ t(account.administrator ? 'siteSession.administrator' : 'siteSession.member') }}</small>
      <button type="button" :disabled="busy" @click="endSession(true)">{{ t('siteSession.switch') }}</button>
      <button type="button" :disabled="busy" @click="endSession(false)">{{ t('siteSession.logout') }}</button>
      <p v-if="error" class="site-account-error" role="alert">{{ error }}</p>
    </div>
  </details>
</template>

<script setup lang="ts">
import { ChevronDown, CircleUserRound } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useSiteSession } from '~/composables/useSiteSession'

const { t } = useI18n()
const route = useRoute()
const { account, refresh, leave } = useSiteSession()
const menu = ref<HTMLDetailsElement>()
const trigger = ref<HTMLElement>()
const busy = ref(false)
const error = ref('')

function close(restoreFocus = false) {
  if (!menu.value?.open) return
  menu.value.open = false
  if (restoreFocus) trigger.value?.focus()
}

function closeOnOutsidePress(event: PointerEvent) {
  if (event.target instanceof Node && !menu.value?.contains(event.target)) close()
}

async function endSession(switchAccount: boolean) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await leave(switchAccount ? route.fullPath : undefined) }
  catch { error.value = t('siteSession.logoutFailed') }
  finally { busy.value = false }
}

onMounted(() => {
  void refresh()
  document.addEventListener('pointerdown', closeOnOutsidePress)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnOutsidePress))
</script>

<style scoped>
.site-account-menu { position: relative; min-width: 0; }
.site-account-menu summary {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-1);
  font-size: 12px;
  list-style: none;
  cursor: pointer;
}
.site-account-menu summary::-webkit-details-marker { display: none; }
.site-account-menu summary span { max-width: 105px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-account-menu summary svg { flex: none; }
.site-account-actions {
  position: absolute;
  z-index: var(--z-menu, 100);
  right: 0;
  top: calc(100% + 6px);
  display: grid;
  min-width: 144px;
  gap: 3px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-raised, var(--bg-1));
  box-shadow: var(--shadow-lg);
}
.site-account-menu:not([open]) .site-account-actions { display: none; }
.site-account-role { padding: 4px 7px; color: var(--text-3); }
.site-account-actions button {
  padding: 7px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-1);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.site-account-actions button:not(:disabled):hover { background: var(--bg-hover); }
.site-account-error { padding: 4px 7px; color: var(--error); font-size: 12px; }
@media (max-width: 550px) {
  .site-account-menu summary span { max-width: 56px; }
}
</style>
