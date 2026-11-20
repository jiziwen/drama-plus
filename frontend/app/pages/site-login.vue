<template>
  <main class="site-login">
    <section class="site-login-panel" aria-labelledby="site-login-title">
      <span class="site-login-mark"><Clapperboard :size="23" aria-hidden="true" /></span>
      <h1 id="site-login-title">{{ t('siteSession.loginTitle') }}</h1>
      <form class="site-login-form" method="post" :aria-busy="busy" @submit.prevent="submit">
        <label for="site-username">{{ t('siteSession.username') }}</label>
        <input id="site-username" v-model="username" class="input" name="username" autocomplete="username"
          autocapitalize="none" spellcheck="false" maxlength="128" required autofocus :disabled="busy"
          :aria-invalid="badCredentials" :aria-describedby="badCredentials ? 'site-login-error' : undefined" />
        <label for="site-password">{{ t('siteSession.password') }}</label>
        <input id="site-password" ref="passwordInput" v-model="password" class="input" type="password" name="password"
          autocomplete="current-password" maxlength="512" required :disabled="busy"
          :aria-invalid="badCredentials" :aria-describedby="badCredentials ? 'site-login-error' : undefined" />
        <p v-if="error" id="site-login-error" role="alert">{{ error }}</p>
        <button type="submit" class="btn btn-primary" :disabled="busy">
          {{ t(busy ? 'siteSession.signingIn' : 'siteSession.login') }}
        </button>
      </form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { Clapperboard } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { loginToSite, safeSiteNext, SiteLoginError } from '~/utils/siteSession'

definePageMeta({ layout: false })
const { t } = useI18n()
const route = useRoute()
const username = ref('')
const password = ref('')
const passwordInput = ref<HTMLInputElement>()
const busy = ref(false)
const error = ref('')
const badCredentials = ref(false)
let disposed = false

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  badCredentials.value = false
  try {
    await loginToSite(username.value.trim(), password.value)
    if (!disposed) window.location.replace(safeSiteNext(route.query.next))
  } catch (caught) {
    badCredentials.value = caught instanceof SiteLoginError && caught.status === 401
    error.value = t(badCredentials.value ? 'siteSession.badCredentials' : 'siteSession.loginFailed')
  } finally {
    password.value = ''
    busy.value = false
    if (error.value && !disposed) await nextTick(() => passwordInput.value?.focus())
  }
}

onBeforeUnmount(() => { disposed = true; username.value = ''; password.value = '' })
</script>

<style scoped>
.site-login { min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
.site-login-panel {
  width: min(100%, 392px);
  padding: clamp(22px, 6vw, 34px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface-raised, var(--bg-1));
  box-shadow: var(--shadow-lg);
}
.site-login-mark {
  display: inline-grid;
  width: 44px;
  height: 44px;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--accent-text, var(--accent));
  background: var(--bg-2);
}
.site-login h1 { margin: 12px 0 22px; font-size: 24px; color: var(--text-0); }
.site-login-form { display: grid; gap: 8px; }
.site-login-form label { color: var(--text-1); font-size: 13px; }
.site-login-form label:not(:first-child) { margin-top: 7px; }
.site-login-form input { width: 100%; }
.site-login-form button { margin-top: 12px; }
.site-login-form [role="alert"] { color: var(--error); font-size: 13px; }
</style>
