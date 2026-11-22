import { computed, ref, watch, type Ref } from 'vue'
import { api, libtvPhoneAPI } from './useApi'

export type VideoCliProvider = 'jimeng' | 'libtv'

export interface VideoCliSavedAccount {
  id: string
  name: string
}

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
  login_method?: 'local_helper' | 'browser'
  assistant_download_url?: string
  expires_at?: number
  can_authorize?: boolean
  can_authorize_phone?: boolean
  can_prepare_canvas?: boolean
  canvas_ready?: boolean
  canvas_preparing?: boolean
  canvas_name?: string
  profileId?: string
}

const authorizationOrigins: Record<VideoCliProvider, readonly string[]> = {
  jimeng: ['https://jimeng.jianying.com'],
  libtv: ['https://www.liblib.tv'],
}

function verifiedUrl(provider: VideoCliProvider, url: string | undefined) {
  if (!url) return
  try {
    const link = new URL(url)
    if (authorizationOrigins[provider].includes(link.origin) && !link.username && !link.password) return link.href
  } catch { /* A provider must return an absolute HTTPS authorization URL. */ }
}

function verifiedAssistantUrl(url: string | undefined) {
  if (!url) return
  try {
    const link = new URL(url, window.location.href)
    if (link.origin === window.location.origin && !link.username && !link.password &&
        link.pathname === '/api/v1/libtv/auth/assistant' && link.protocol === 'https:') return link.href
  } catch { /* Only the application's HTTPS download endpoint may provide the helper. */ }
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

export function useVideoCliAccount(
  provider: Ref<VideoCliProvider | undefined>,
  translate: (key: string) => string,
  scope?: { accountId: Readonly<Ref<string | undefined>> },
) {
  const account = ref<AccountState | null>(null)
  const accounts = ref<VideoCliSavedAccount[]>([])
  const activeAccountId = ref('')
  const selectedAccountId = ref('')
  const busy = ref(false)
  const disconnecting = ref(false)
  const pending = ref(false)
  const error = ref('')
  const verificationUrl = ref('')
  const assistantDownload = ref('')
  const assistantDownloadUrl = computed(() => pending.value ? assistantDownload.value : '')
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
  let phoneTimer: ReturnType<typeof setTimeout> | undefined
  let authorizationTimer: ReturnType<typeof setTimeout> | undefined
  let version = 0
  let phoneVersion = 0
  let openingTab: Window | null = null

  function clearAuthorizationTimer() {
    clearTimeout(authorizationTimer)
    authorizationTimer = undefined
  }

  function authorizationState(name: VideoCliProvider, state: AccountState): AccountState {
    if (isPending(state) && !isAuthenticated(name, state) && !state.canvas_preparing &&
        Number.isFinite(state.expires_at) && state.expires_at! <= Date.now()) {
      return { ...state, status: 'expired', pending: false, verification_url: undefined,
        assistant_download_url: undefined, message: message(name, 'expired') }
    }
    return state
  }

  function scheduleAuthorizationExpiry(name: VideoCliProvider, state: AccountState) {
    clearAuthorizationTimer()
    if (!isPending(state) || isAuthenticated(name, state) || state.canvas_preparing ||
        !Number.isFinite(state.expires_at) || state.expires_at! <= Date.now()) return
    const current = version
    authorizationTimer = setTimeout(() => {
      if (current !== version || !pending.value) return
      pending.value = false
      verificationUrl.value = ''
      assistantDownload.value = ''
      if (account.value) account.value = authorizationState(name, account.value)
      error.value = message(name, 'expired')
    }, state.expires_at! - Date.now())
  }

  function accountPath(name: VideoCliProvider, path: string, id = selectedAccountId.value) {
    return `/${name}/${path}${id ? `?accountId=${encodeURIComponent(id)}` : ''}`
  }

  async function readAccounts(name: VideoCliProvider, current: number) {
    const result = await api.get<{ accounts: VideoCliSavedAccount[]; activeAccountId: string }>(`/${name}/accounts`)
    if (current !== version) return
    // Older servers can continue serving the single account during an application update.
    if (!Array.isArray(result.accounts)) return
    if (scope) {
      accounts.value = result.accounts.filter(entry => entry.id === selectedAccountId.value)
      activeAccountId.value = result.activeAccountId
      return true
    }
    accounts.value = result.accounts
    const selected = result.accounts.some(entry => entry.id === result.activeAccountId) ? result.activeAccountId : result.accounts[0]?.id || ''
    activeAccountId.value = selected
    if (selected !== selectedAccountId.value) {
      clearAuthorizationTimer()
      pending.value = false
      verificationUrl.value = ''
      assistantDownload.value = ''
      closePhone()
      selectedAccountId.value = selected
    }
    return true
  }

  function message(name: VideoCliProvider, key: string) {
    return translate(`settings.${name}.${key}`)
  }

  function closeOpeningTab() {
    openingTab?.close()
    openingTab = null
  }

  function openAuthorizationTab() {
    try {
      const tab = window.open('about:blank', '_blank')
      if (tab) tab.opener = null
      return tab
    } catch { return null }
  }

  function remember(state: AccountState) {
    account.value = { ...account.value, ...state, available: state.available ?? account.value?.available ?? true }
  }

  async function refresh() {
    const name = provider.value
    if (!name || (scope && !selectedAccountId.value) || busy.value) return
    const current = version
    busy.value = true
    error.value = ''
    try {
      let listed = false
      try { listed = await readAccounts(name, current) === true } catch (caught) {
        if ((caught as { status?: number })?.status !== 404) throw caught
      }
      if (current !== version) return
      if (!scope && listed && !accounts.value.length) {
        clearAuthorizationTimer()
        account.value = null
        pending.value = false
        verificationUrl.value = ''
        return
      }
      const state = authorizationState(name, await api.get<AccountState>(accountPath(name, 'account')))
      if (current !== version) return
      account.value = state
      scheduleAuthorizationExpiry(name, state)
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
      const wasPending = pending.value
      if (isPending(state) && !authorizationFailed(state)) {
        pending.value = true
        if (state.authenticated || state.canvas_preparing) {
          verificationUrl.value = ''
          assistantDownload.value = ''
        } else {
          verificationUrl.value = verifiedUrl(name, state.verification_url) || verificationUrl.value
          assistantDownload.value = verifiedAssistantUrl(state.assistant_download_url) || assistantDownload.value
        }
      } else {
        pending.value = false
        verificationUrl.value = ''
        assistantDownload.value = ''
        if (authorizationFailed(state) || wasPending && !state.authenticated) {
          error.value = state.message || message(name, state.status === 'expired' || wasPending ? 'expired' : 'unavailable')
        }
      }
    } catch (caught) {
      if (current === version) error.value = caught instanceof Error ? caught.message : message(name, 'unavailable')
    } finally {
      if (current === version) busy.value = false
    }
  }

  async function start(prepareCanvas: boolean, reservedTab?: Window | null): Promise<boolean> {
    const name = provider.value
    if (!name || (scope && !selectedAccountId.value) || busy.value) {
      reservedTab?.close()
      return false
    }
    const allowed = prepareCanvas && name === 'libtv'
      ? account.value?.can_prepare_canvas ?? account.value?.can_authorize
      : account.value?.can_authorize
    if (prepareCanvas && allowed === false) {
      reservedTab?.close()
      error.value = account.value?.message || message(name, 'authorizationUnavailable')
      return false
    }
    const current = version
    busy.value = true
    error.value = ''
    clearAuthorizationTimer()
    assistantDownload.value = ''
    if (!prepareCanvas) {
      // 新增账号在第一次请求前已预开窗口，直接复用，避免异步请求后被拦截。
      openingTab = reservedTab === undefined ? openAuthorizationTab() : reservedTab
    }
    try {
      const state = authorizationState(name, await api.post<AccountState>(accountPath(name, 'auth/start'), {}))
      if (current !== version) return false
      remember(state)
      if (authorizationFailed(state)) throw new Error(state.message || message(name, state.status === 'expired' ? 'expired' : 'unavailable'))
      if (!isPending(state) && isAuthenticated(name, state)) {
        closeOpeningTab()
        pending.value = false
        verificationUrl.value = ''
        busy.value = false
        await refresh()
        return !error.value
      }
      const link = verifiedUrl(name, state.verification_url)
      const helper = name === 'libtv' && state.login_method === 'local_helper'
        ? verifiedAssistantUrl(state.assistant_download_url) : undefined
      if (!link && !helper && !(name === 'libtv' && (state.authenticated || state.canvas_preparing) && isPending(state))) {
        throw new Error(state.message || message(name, 'invalidAuthorizationUrl'))
      }
      verificationUrl.value = link || ''
      assistantDownload.value = helper || ''
      pending.value = true
      scheduleAuthorizationExpiry(name, state)
      if (openingTab && link) {
        try { openingTab.location.replace(link) } catch { closeOpeningTab() }
        openingTab = null
      } else closeOpeningTab()
      return true
    } catch (caught) {
      if (current !== version) return false
      closeOpeningTab()
      clearAuthorizationTimer()
      pending.value = false
      verificationUrl.value = ''
      error.value = caught instanceof Error ? caught.message : message(name, 'unavailable')
      return false
    } finally {
      if (current === version) busy.value = false
    }
  }

  async function disconnect() {
    const name = provider.value
    if (!name || busy.value || phoneBusy.value || !canDisconnect.value) return false
    const current = version
    busy.value = true
    disconnecting.value = true
    error.value = ''
    try {
      const state = await api.post<AccountState>(accountPath(name, 'auth/disconnect'), {})
      if (current !== version || provider.value !== name) return false
      if (isAuthenticated(name, state) || isPending(state)) throw new Error(message(name, 'disconnectFailed'))
      account.value = state
      clearAuthorizationTimer()
      pending.value = false
      verificationUrl.value = ''
      closeOpeningTab()
      closePhone()
      return true
    } catch (caught) {
      if (current === version && provider.value === name) {
        error.value = caught instanceof Error ? caught.message : message(name, 'disconnectFailed')
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
      const challenge = await libtvPhoneAPI.send(phone, selectedAccountId.value)
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
      const state = await libtvPhoneAPI.verify<AccountState>(challenge.challenge_id, code, selectedAccountId.value)
      if (current !== phoneVersion) return
      if (!isPending(state) && !isAuthenticated('libtv', state)) {
        throw new Error(state.message || message('libtv', 'phoneVerifyFailed'))
      }
      remember(state)
      closePhone()
      if (isPending(state)) {
        pending.value = true
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

  function resetCurrent() {
    version++
    clearAuthorizationTimer()
    closeOpeningTab()
    account.value = null
    pending.value = false
    verificationUrl.value = ''
    assistantDownload.value = ''
    error.value = ''
    closePhone()
  }

  async function changeSavedAccount(action: (name: VideoCliProvider) => Promise<string | undefined>) {
    const name = provider.value
    if (!name || busy.value || phoneBusy.value) return false
    resetCurrent()
    const current = version
    busy.value = true
    try {
      const selected = await action(name)
      if (current !== version) return false
      if (selected !== undefined) selectedAccountId.value = selected
      busy.value = false
      await refresh()
      // 账号操作已在服务端完成，下一账号的登录状态读取失败不代表操作失败。
      return true
    } catch (caught) {
      if (current === version) {
        error.value = caught instanceof Error ? caught.message : '账号操作失败，请重试。'
        // Keep the current slot available even if activation/deletion was rejected.
        try {
          const state = await api.get<AccountState>(accountPath(name, 'account'))
          if (current === version) account.value = state
        } catch { /* Preserve the operation error. */ }
      }
      return false
    } finally {
      if (current === version) busy.value = false
    }
  }

  function selectAccount(id: string) {
    if (scope || !accounts.value.some(entry => entry.id === id)) return Promise.resolve(false)
    return changeSavedAccount(async name => {
      await api.post(`/${name}/accounts/${encodeURIComponent(id)}/activate`, {})
      return id
    })
  }

  async function addAccount(): Promise<boolean> {
    const providerName = provider.value
    if (scope || !providerName || busy.value || phoneBusy.value) return false
    resetCurrent()
    const current = version
    busy.value = true
    // 保留点击手势，平台授权地址返回后无需用户再次点击。
    openingTab = openAuthorizationTab()
    try {
      const created = await api.post<VideoCliSavedAccount>(`/${providerName}/accounts`, {})
      if (current !== version) return false
      if (!created.id) throw new Error('未能创建账号，请重试。')
      accounts.value = [...accounts.value, created]
      selectedAccountId.value = created.id
      await api.post(`/${providerName}/accounts/${encodeURIComponent(created.id)}/activate`, {})
      if (current !== version) return false
      activeAccountId.value = created.id
      busy.value = false
      return await start(false, openingTab)
    } catch (caught) {
      if (current !== version) return false
      closeOpeningTab()
      error.value = caught instanceof Error ? caught.message : '账号授权未能开始，请重试。'
      return false
    } finally {
      if (current === version) busy.value = false
    }
  }

  function renameAccount(name: string) {
    const label = name.trim()
    const id = selectedAccountId.value
    if (!label || !id) return Promise.resolve(false)
    return changeSavedAccount(async providerName => {
      await api.put(`/${providerName}/accounts/${encodeURIComponent(id)}`, { name: label })
      return id
    })
  }

  function removeAccount() {
    const id = selectedAccountId.value
    if (scope || !id) return Promise.resolve(false)
    return changeSavedAccount(async name => {
      await api.del(`/${name}/accounts/${encodeURIComponent(id)}`)
      accounts.value = accounts.value.filter(entry => entry.id !== id)
      const next = accounts.value[0]?.id || ''
      if (activeAccountId.value === id) activeAccountId.value = next
      return next
    })
  }

  watch([provider, () => scope?.accountId.value], ([name, id], _previous, onCleanup) => {
    if (!name) return
    if (scope) selectedAccountId.value = id ?? ''
    void refresh()
    onCleanup(() => {
      resetCurrent()
      accounts.value = []
      selectedAccountId.value = ''
      activeAccountId.value = ''
      busy.value = false
      disconnecting.value = false
      pending.value = false
      error.value = ''
      verificationUrl.value = ''
      closePhone()
    })
  }, { immediate: true, flush: scope ? 'sync' : 'pre' })

  const phone = { open: phoneOpen, number: phoneNumber, code: phoneCode, challenge: phoneChallenge, expired: phoneExpired,
    busy: phoneBusy, error: phoneError, masked: maskedPhone, start: openPhone, close: closePhone, change: changePhone,
    send: sendPhone, verify: verifyPhone }
  return { account, accounts, selectedAccountId, activeAccountId, selectAccount, addAccount, renameAccount, removeAccount,
    busy, pending, error, verificationUrl, assistantDownloadUrl, phone, refresh, canDisconnect, disconnecting, disconnect,
    authorize: () => start(false), prepare: () => start(true) }
}
