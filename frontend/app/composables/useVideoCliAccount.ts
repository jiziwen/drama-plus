import { computed, ref, watch, type Ref } from 'vue'
import { api, libtvPhoneAPI } from './useApi'

export type VideoCliProvider = 'jimeng' | 'libtv'

interface AccountState {
  available: boolean
  authenticated?: boolean
  username?: string
  membership?: string
  plan?: string
  credits?: number
  models?: string[]
  message?: string
  status?: string
  pending?: boolean
  verification_url?: string
  expires_at?: number
  can_authorize?: boolean
  can_authorize_phone?: boolean
  can_prepare_canvas?: boolean
  canvas_ready?: boolean
  canvas_preparing?: boolean
  canvas_name?: string
}

const authorizationOrigins: Record<VideoCliProvider, readonly string[]> = {
  jimeng: ['https://jimeng.jianying.com'],
  libtv: ['https://www.liblib.tv'],
}
const verificationLifetime = 5 * 60_000
const pollInterval = 2500

function verifiedUrl(provider: VideoCliProvider, url: string | undefined) {
  if (!url) return
  try {
    const link = new URL(url)
    if (authorizationOrigins[provider].includes(link.origin) && !link.username && !link.password) return link.href
  } catch { /* A provider must return an absolute HTTPS authorization URL. */ }
}

function isPending(state: AccountState) {
  return state.status === 'pending' || state.pending === true
}

function isAuthenticated(provider: VideoCliProvider, state: AccountState) {
  return state.authenticated === true || provider === 'jimeng' && state.status === 'authorized'
}

function authorizationFailed(state: AccountState) {
  return state.status === 'expired' || state.status === 'failed' || state.status === 'unavailable'
}

function expiresAt(state: AccountState) {
  return typeof state.expires_at === 'number' && Number.isFinite(state.expires_at)
    ? state.expires_at : Date.now() + verificationLifetime
}

export function useVideoCliAccount(provider: Ref<VideoCliProvider | undefined>, translate: (key: string) => string) {
  const account = ref<AccountState | null>(null)
  const busy = ref(false)
  const disconnecting = ref(false)
  const pending = ref(false)
  const error = ref('')
  const verificationUrl = ref('')
  const phoneOpen = ref(false)
  const phoneNumber = ref('')
  const phoneCode = ref('')
  const phoneChallenge = ref<{ challenge_id: string; expires_at: number }>()
  const phoneExpired = ref(false)
  const phoneBusy = ref(false)
  const phoneError = ref('')
  const maskedPhone = computed(() => phoneChallenge.value
    ? phoneNumber.value.slice(0, 3) + '****' + phoneNumber.value.slice(-4) : '')
  const canDisconnect = computed(() => !!(account.value?.authenticated || pending.value && !account.value?.canvas_preparing))
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  let phoneTimer: ReturnType<typeof setTimeout> | undefined
  let version = 0
  let phoneVersion = 0
  let openingTab: Window | null = null

  function message(name: VideoCliProvider, key: string) {
    return translate(`settings.${name}.${key}`)
  }

  function closeOpeningTab() {
    openingTab?.close()
    openingTab = null
  }

  function remember(state: AccountState) {
    account.value = { ...account.value, ...state, available: state.available ?? account.value?.available ?? true }
  }

  async function refresh() {
    const name = provider.value
    if (!name || busy.value) return
    const current = version
    busy.value = true
    error.value = ''
    try {
      const state = await api.get<AccountState>(`/${name}/account`)
      if (current !== version) return
      account.value = state
      if (name === 'jimeng') {
        const wasPending = pending.value
        const authenticated = isAuthenticated(name, state)
        pending.value = state.available && !authenticated && isPending(state)
        if (pending.value) {
          // The normal account read omits the challenge URL while authorization is pending.
          verificationUrl.value = verifiedUrl(name, state.verification_url) || verificationUrl.value
        } else {
          verificationUrl.value = ''
          if (authenticated) {
            if (!state.authenticated) account.value = { ...state, authenticated: true }
          } else if (state.message || wasPending || authorizationFailed(state)) {
            error.value = state.message || message(name, state.available ? 'expired' : 'unavailable')
          }
        }
        return
      }
      if (phoneOpen.value && (state.authenticated || !state.can_authorize_phone)) closePhone()
      if (isPending(state) && !pending.value) {
        pending.value = true
        verificationUrl.value = verifiedUrl(name, state.verification_url) || ''
        waitForAuthorization(name, current, expiresAt(state))
      } else if (state.authenticated && !isPending(state)) {
        clearTimeout(pollTimer)
        pending.value = false
        verificationUrl.value = ''
      }
    } catch (caught) {
      if (current === version) error.value = caught instanceof Error ? caught.message : message(name, 'unavailable')
    } finally {
      if (current === version) busy.value = false
    }
  }

  function waitForAuthorization(name: 'libtv', current: number, expiresAt: number) {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(async () => {
      if (current !== version || !pending.value) return
      if (busy.value) {
        if (Date.now() < expiresAt) waitForAuthorization(name, current, expiresAt)
        else {
          pending.value = false
          verificationUrl.value = ''
          error.value = message(name, 'expired')
        }
        return
      }
      busy.value = true
      try {
        const state = await api.get<AccountState>(`/${name}/auth/status`)
        if (current !== version || !pending.value) return
        remember(state)
        if (isPending(state) && Date.now() < expiresAt) {
          if (state.authenticated || state.canvas_preparing) verificationUrl.value = ''
          waitForAuthorization(name, current, expiresAt)
        } else if (!isPending(state) && !authorizationFailed(state) && isAuthenticated(name, state)) {
          account.value!.authenticated = true
          pending.value = false
          verificationUrl.value = ''
          busy.value = false
          await refresh()
        } else {
          pending.value = false
          verificationUrl.value = ''
          error.value = state.message || message(name, 'expired')
        }
      } catch (caught) {
        if (current !== version || !pending.value) return
        pending.value = false
        verificationUrl.value = ''
        error.value = caught instanceof Error ? caught.message : message(name, 'unavailable')
      } finally {
        if (current === version) busy.value = false
      }
    }, pollInterval)
  }

  async function start(prepareCanvas: boolean) {
    const name = provider.value
    if (!name || busy.value || (pending.value && (name !== 'jimeng' || !!verificationUrl.value))) return
    const allowed = prepareCanvas && name === 'libtv'
      ? account.value?.can_prepare_canvas ?? account.value?.can_authorize
      : account.value?.can_authorize
    if (allowed === false) return
    const current = version
    clearTimeout(pollTimer)
    busy.value = true
    error.value = ''
    if (name === 'libtv' && !prepareCanvas) {
      // Open from the click gesture so a slow response still works with popup blocking enabled.
      try {
        openingTab = window.open('about:blank', '_blank')
        if (openingTab) openingTab.opener = null
      } catch { closeOpeningTab() }
    }
    try {
      const state = await api.post<AccountState>(`/${name}/auth/start`, {})
      if (current !== version) return
      remember(state)
      if (authorizationFailed(state)) throw new Error(state.message || message(name, state.status === 'expired' ? 'expired' : 'unavailable'))
      if (!isPending(state) && isAuthenticated(name, state)) {
        closeOpeningTab()
        pending.value = false
        verificationUrl.value = ''
        if (name === 'libtv') {
          busy.value = false
          await refresh()
        } else account.value!.authenticated = true
        return
      }
      const link = verifiedUrl(name, state.verification_url)
      if (!link && !(name === 'libtv' && (state.authenticated || state.canvas_preparing) && isPending(state))) {
        throw new Error(state.message || message(name, 'invalidAuthorizationUrl'))
      }
      verificationUrl.value = link || ''
      pending.value = true
      if (openingTab && link) {
        try { openingTab.location.replace(link) } catch { closeOpeningTab() }
        openingTab = null
      } else closeOpeningTab()
      if (name === 'libtv') waitForAuthorization(name, current, expiresAt(state))
    } catch (caught) {
      if (current !== version) return
      closeOpeningTab()
      pending.value = false
      verificationUrl.value = ''
      error.value = caught instanceof Error ? caught.message : message(name, 'unavailable')
    } finally {
      if (current === version) busy.value = false
    }
  }

  async function disconnect() {
    const name = provider.value
    if (!name || busy.value || phoneBusy.value || !canDisconnect.value) return false
    const current = version
    clearTimeout(pollTimer)
    busy.value = true
    disconnecting.value = true
    error.value = ''
    try {
      const state = await api.post<AccountState>(`/${name}/auth/disconnect`, {})
      if (current !== version || provider.value !== name) return false
      if (isAuthenticated(name, state) || isPending(state)) throw new Error(message(name, 'disconnectFailed'))
      account.value = state
      pending.value = false
      verificationUrl.value = ''
      closeOpeningTab()
      closePhone()
      return true
    } catch (caught) {
      if (current === version && provider.value === name) {
        error.value = caught instanceof Error ? caught.message : message(name, 'disconnectFailed')
        if (name === 'libtv' && pending.value && account.value) {
          waitForAuthorization(name, current, expiresAt(account.value))
        }
      }
      return false
    } finally {
      if (current === version) {
        disconnecting.value = false
        busy.value = false
      }
    }
  }

  function closePhone() {
    phoneVersion++
    clearTimeout(phoneTimer)
    phoneOpen.value = false
    phoneNumber.value = ''
    phoneCode.value = ''
    phoneChallenge.value = undefined
    phoneExpired.value = false
    phoneBusy.value = false
    phoneError.value = ''
  }

  function openPhone() {
    if (provider.value !== 'libtv' || !account.value?.can_authorize_phone || account.value.authenticated || busy.value || pending.value) return
    phoneOpen.value = true
  }

  function changePhone() {
    closePhone()
    openPhone()
  }

  function expirePhoneCode() {
    phoneExpired.value = true
    phoneCode.value = ''
  }

  function canSubmitPhone() {
    return provider.value === 'libtv' && phoneOpen.value && account.value?.can_authorize_phone &&
      !account.value.authenticated && !phoneBusy.value && !pending.value && !disconnecting.value
  }

  async function sendPhone() {
    if (!canSubmitPhone()) return
    const phone = phoneNumber.value.trim()
    if (!/^1\d{10}$/u.test(phone)) {
      phoneError.value = message('libtv', 'phoneInvalid')
      return
    }
    const current = phoneVersion
    phoneBusy.value = true
    phoneError.value = ''
    try {
      const challenge = await libtvPhoneAPI.send(phone)
      if (current !== phoneVersion) return
      if (typeof challenge?.challenge_id !== 'string' || !challenge.challenge_id ||
          !Number.isFinite(challenge.expires_at) || challenge.expires_at <= Date.now()) {
        throw new Error(message('libtv', 'phoneSendFailed'))
      }
      clearTimeout(phoneTimer)
      phoneNumber.value = phone
      phoneCode.value = ''
      phoneChallenge.value = challenge
      phoneExpired.value = false
      phoneTimer = setTimeout(expirePhoneCode, challenge.expires_at - Date.now())
    } catch (caught) {
      if (current === phoneVersion) phoneError.value = caught instanceof Error ? caught.message : message('libtv', 'phoneSendFailed')
    } finally {
      if (current === phoneVersion) phoneBusy.value = false
    }
  }

  async function verifyPhone() {
    const challenge = phoneChallenge.value
    if (!canSubmitPhone() || !challenge) return
    if (Date.now() >= challenge.expires_at || phoneExpired.value) {
      expirePhoneCode()
      return
    }
    const code = phoneCode.value.trim()
    if (!/^\d{6}$/u.test(code)) {
      phoneError.value = message('libtv', 'phoneCodeInvalid')
      return
    }
    const current = phoneVersion
    phoneBusy.value = true
    phoneError.value = ''
    try {
      const state = await libtvPhoneAPI.verify<AccountState>(challenge.challenge_id, code)
      if (current !== phoneVersion) return
      if (!isPending(state) && !isAuthenticated('libtv', state)) {
        throw new Error(state.message || message('libtv', 'phoneVerifyFailed'))
      }
      remember(state)
      closePhone()
      if (isPending(state)) {
        pending.value = true
        waitForAuthorization('libtv', version, expiresAt(state))
      } else await refresh()
    } catch (caught) {
      if (current !== phoneVersion) return
      phoneCode.value = ''
      if ((caught as { status?: number })?.status === 410) expirePhoneCode()
      phoneError.value = caught instanceof Error ? caught.message : message('libtv', 'phoneVerifyFailed')
    } finally {
      if (current === phoneVersion) phoneBusy.value = false
    }
  }

  watch(provider, (name, _previous, onCleanup) => {
    if (!name) return
    void refresh()
    onCleanup(() => {
      version++
      clearTimeout(pollTimer)
      closeOpeningTab()
      account.value = null
      busy.value = false
      disconnecting.value = false
      pending.value = false
      error.value = ''
      verificationUrl.value = ''
      closePhone()
    })
  }, { immediate: true })

  const phone = { open: phoneOpen, number: phoneNumber, code: phoneCode, challenge: phoneChallenge, expired: phoneExpired,
    busy: phoneBusy, error: phoneError, masked: maskedPhone, start: openPhone, close: closePhone, change: changePhone,
    send: sendPhone, verify: verifyPhone }
  return { account, busy, pending, error, verificationUrl, phone, refresh, canDisconnect, disconnecting, disconnect,
    authorize: () => start(false), prepare: () => start(true) }
}
