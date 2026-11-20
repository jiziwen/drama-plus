import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { effectScope, nextTick, ref } from 'vue'
import { useVideoCliAccount, type VideoCliProvider } from '../app/composables/useVideoCliAccount'

test('Jimeng reads the account once on entry and only refreshes by request after authorization starts', async t => {
  const originalFetch = globalThis.fetch
  const scope = effectScope()
  t.after(() => {
    scope.stop()
    globalThis.fetch = originalFetch
  })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  const accountPath = '/api/v1/jimeng/account'
  const startPath = '/api/v1/jimeng/auth/start'
  const disconnectPath = '/api/v1/jimeng/auth/disconnect'
  const calls: string[] = []
  const verification = 'https://jimeng.jianying.com/authorize'
  let account: Record<string, unknown> = { available: true, authenticated: false }
  let start: Record<string, unknown> = { ...account, status: 'pending', verification_url: verification }
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    calls.push(path)
    if (path === disconnectPath) {
      assert.equal(init?.method, 'POST')
      account = { available: true, authenticated: false, status: 'unauthenticated' }
      return Response.json({ code: 200, data: account })
    }
    assert.ok(path === accountPath || path === startPath, path)
    return Response.json({ code: 200, data: path === accountPath ? account : start })
  }
  const provider = ref<VideoCliProvider | undefined>('jimeng')
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  async function waitForRead() {
    for (let i = 0; i < 30 && state.busy.value; i++) await nextTick()
    assert.equal(state.busy.value, false)
  }
  await waitForRead()
  assert.deepEqual(calls, [accountPath])
  await state.authorize()
  assert.equal(state.pending.value, true)
  assert.equal(state.verificationUrl.value, verification)
  t.mock.timers.tick(10_000)
  await nextTick()
  assert.deepEqual(calls, [accountPath, startPath])

  account = { available: true, authenticated: false, status: 'pending' }
  await state.refresh()
  assert.equal(state.verificationUrl.value, verification)
  assert.equal(state.pending.value, true)

  // Current Jimeng CLI sends an explanatory message and drops the pending marker after expiry.
  account = { available: true, authenticated: false, message: '即梦账号授权未完成或已过期，请重新发起授权' }
  await state.refresh()
  assert.equal(state.pending.value, false)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.error.value, account.message)

  await state.authorize()
  assert.equal(state.error.value, '')
  account = { available: true, authenticated: true, credits: 52, models: ['jimeng-seedance-2.5'] }
  t.mock.timers.tick(10_000)
  await nextTick()
  assert.equal(state.pending.value, true)
  assert.equal(state.account.value?.credits, undefined)
  await state.refresh()
  assert.equal(state.pending.value, false)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.account.value?.credits, 52)
  assert.equal(state.error.value, '')
  assert.deepEqual(calls, [accountPath, startPath, accountPath, accountPath, startPath, accountPath])

  // Reopening the panel restores a pending state. The explicit button can recover its live link.
  provider.value = undefined
  await nextTick()
  account = { available: true, authenticated: false, status: 'pending' }
  provider.value = 'jimeng'
  await nextTick()
  await waitForRead()
  assert.equal(state.pending.value, true)
  assert.equal(state.verificationUrl.value, '')
  await state.authorize()
  assert.equal(state.pending.value, true)
  assert.equal(state.verificationUrl.value, verification)
  assert.deepEqual(calls.slice(-2), [accountPath, startPath])

  assert.equal(state.canDisconnect.value, true)
  assert.equal(await state.disconnect(), true)
  assert.equal(state.pending.value, false)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.canDisconnect.value, false)
  t.mock.timers.tick(10_000)
  await nextTick()
  assert.deepEqual(calls.slice(-2), [startPath, disconnectPath])

  // When the CLI immediately reuses a session, its response is enough to update connection status.
  provider.value = undefined
  await nextTick()
  account = { available: true, authenticated: false }
  start = { ...account, authenticated: true, status: 'authorized', verification_url: '' }
  provider.value = 'jimeng'
  await nextTick()
  await waitForRead()
  const before = calls.length
  await state.authorize()
  assert.equal(state.account.value?.authenticated, true)
  assert.deepEqual(calls.slice(before), [startPath])

  account = { available: true, authenticated: true, username: 'Old account', credits: 52, models: ['jimeng-seedance-2.5'] }
  await state.refresh()
  assert.equal(await state.disconnect(), true)
  assert.equal(state.account.value?.authenticated, false)
  assert.equal(state.account.value?.username, undefined)
  assert.equal(state.account.value?.credits, undefined)
  assert.equal(state.account.value?.models, undefined)
  assert.deepEqual(calls.slice(-2), [accountPath, disconnectPath])
})

test('LibTV opens verified authorization, counts a verified login, and preserves the Jimeng account flow', async t => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const scope = effectScope()
  t.after(() => {
    scope.stop()
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })

  const opened: string[] = []
  const popup = {
    opener: {},
    closes: 0,
    close() { this.closes++ },
    location: { replace: (url: string) => { opened.push(url) } },
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    open(url: string) { assert.equal(url, 'about:blank'); return popup },
  } })

  let authorized = false
  let canvasReady = false
  let preparing = false
  let canAuthorize = false
  let disconnectBlocked = true
  let verificationUrl = 'https://www.liblib.tv.attacker.invalid/authorize'
  const calls: string[] = []
  globalThis.fetch = async input => {
    const path = String(input)
    calls.push(path)
    if (path.endsWith('/libtv/auth/disconnect')) {
      if (disconnectBlocked) return Response.json({ code: 409, message: 'LibTV 有生成任务正在运行。' }, { status: 409 })
      authorized = false
      canvasReady = false
      return Response.json({ code: 200, data: { available: true, authenticated: false, can_authorize: true, canvas_ready: false } })
    }
    const data = path.endsWith('/libtv/account') ? { available: true, authenticated: authorized, can_authorize: canAuthorize, canvas_ready: canvasReady, canvas_name: '剧本转视频' }
      : path.endsWith('/libtv/auth/start') ? { available: true, authenticated: false, status: 'pending',
        ...(preparing ? { canvas_preparing: true } : { verification_url: verificationUrl }) }
      : path.endsWith('/libtv/auth/status') ? (authorized = true, canvasReady = true, { available: true, authenticated: true, status: 'authenticated' })
      : { available: true, authenticated: true, username: 'Jimeng test', credits: 10, models: ['jimeng-seedance-2.5'] }
    return Response.json({ code: 200, data })
  }

  const provider = ref<VideoCliProvider | undefined>('libtv')
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  for (let i = 0; i < 30 && state.busy.value; i++) await delay(25)
  assert.equal(state.account.value?.available, true)

  await state.authorize()
  assert.ok(!calls.includes('/api/v1/libtv/auth/start'))
  canAuthorize = true
  await state.refresh()
  await state.authorize()
  assert.equal(state.error.value, 'settings.libtv.invalidAuthorizationUrl')
  assert.deepEqual(opened, [])
  assert.equal(popup.closes, 1)

  verificationUrl = 'https://www.liblib.tv/?callback_url=local-test'
  await state.authorize()
  assert.deepEqual(opened, [verificationUrl])
  assert.equal(popup.opener, null)
  assert.equal(state.pending.value, true)
  assert.equal(state.verificationUrl.value, verificationUrl)
  for (let i = 0; i < 80 && !state.account.value?.canvas_ready; i++) await delay(50)
  assert.equal(state.pending.value, false)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.account.value?.canvas_name, '剧本转视频')
  assert.ok(calls.includes('/api/v1/libtv/auth/status'))

  canvasReady = false
  preparing = true
  await state.refresh()
  assert.equal(state.account.value?.authenticated, true)
  assert.equal(state.account.value?.canvas_ready, false)
  await state.prepare()
  assert.equal(state.pending.value, true)
  assert.equal(state.error.value, '')
  assert.equal(state.account.value?.canvas_preparing, true)
  assert.deepEqual(opened, [verificationUrl])
  for (let i = 0; i < 80 && !state.account.value?.canvas_ready; i++) await delay(50)
  assert.equal(state.account.value?.canvas_ready, true)

  assert.equal(await state.disconnect(), false)
  assert.equal(state.error.value, 'LibTV 有生成任务正在运行。')
  assert.equal(state.account.value?.authenticated, true)
  assert.equal(state.account.value?.canvas_name, '剧本转视频')
  disconnectBlocked = false
  assert.equal(await state.disconnect(), true)
  assert.equal(state.error.value, '')
  assert.equal(state.pending.value, false)
  assert.equal(state.account.value?.authenticated, false)
  assert.equal(state.account.value?.can_authorize, true)
  assert.equal(state.account.value?.canvas_name, undefined)
  assert.equal(state.canDisconnect.value, false)

  provider.value = 'jimeng'
  await nextTick()
  for (let i = 0; i < 30 && state.busy.value; i++) await delay(25)
  assert.equal(state.account.value?.credits, 10)
  assert.deepEqual(state.account.value?.models, ['jimeng-seedance-2.5'])
})

test('hosted LibTV SMS follows connection capabilities, keeps entered values private and prepares the canvas', async t => {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const scope = effectScope()
  t.after(() => {
    scope.stop()
    globalThis.fetch = originalFetch
    console.log = originalLog
  })
  const logs: unknown[][] = []
  console.log = (...args) => { logs.push(args) }
  const requests: { path: string; body?: Record<string, unknown> }[] = []
  let canAuthorizePhone = false
  let sends = 0
  let authorized = false
  let canvasReady = false
  let holdSend: (() => void) | undefined
  const phone = '13900000000'
  const code = '123456'
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, body })
    if (path.endsWith('/auth/phone/send')) {
      assert.deepEqual(body, { phone })
      sends++
      if (sends === 3) await new Promise<void>(resolve => { holdSend = resolve })
      return Response.json({ code: 200, data: { challenge_id: `sms-${sends}`, expires_at: Date.now() + 300_000 } })
    }
    if (path.endsWith('/auth/phone/verify')) {
      assert.deepEqual(body, { challenge_id: `sms-${sends}`, code })
      if (sends === 1) return Response.json({ code: 410, message: '验证码已过期' }, { status: 410 })
      return Response.json({ code: 200, data: { available: true, authenticated: false, status: 'pending', canvas_preparing: true } })
    }
    if (path.endsWith('/auth/status')) {
      authorized = true
      canvasReady = true
    }
    if (path.endsWith('/auth/start')) {
      return Response.json({ code: 200, data: { available: true, authenticated: true, status: 'pending', canvas_preparing: true } })
    }
    assert.ok(path.endsWith('/account') || path.endsWith('/auth/status'), path)
    return Response.json({ code: 200, data: {
      available: true, authenticated: authorized, can_authorize: false, can_authorize_phone: canAuthorizePhone && !authorized,
      can_prepare_canvas: canAuthorizePhone, canvas_ready: canvasReady,
    } })
  }
  const provider = ref<VideoCliProvider | undefined>('libtv')
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  while (state.busy.value) await delay(5)
  state.phone.start()
  assert.equal(state.phone.open.value, false)
  await state.phone.send()
  assert.equal(sends, 0)

  canAuthorizePhone = true
  await state.refresh()
  state.phone.start()
  assert.equal(state.phone.open.value, true)
  state.phone.number.value = '1'
  await state.phone.send()
  assert.equal(state.phone.error.value, 'settings.libtv.phoneInvalid')
  assert.equal(sends, 0)
  state.phone.number.value = phone
  await state.phone.send()
  assert.equal(state.phone.challenge.value?.challenge_id, 'sms-1')
  assert.equal(state.phone.masked.value, '139****0000')
  state.phone.code.value = '123'
  await state.phone.verify()
  assert.equal(state.phone.error.value, 'settings.libtv.phoneCodeInvalid')
  state.phone.code.value = code
  await state.phone.verify()
  assert.equal(state.phone.expired.value, true)
  assert.equal(state.phone.code.value, '')
  assert.equal(state.phone.error.value, '验证码已过期')

  await state.phone.send()
  assert.equal(state.phone.challenge.value?.challenge_id, 'sms-2')
  assert.equal(state.phone.expired.value, false)
  state.phone.change()
  assert.equal(state.phone.open.value, true)
  assert.equal(state.phone.number.value, '')
  assert.equal(state.phone.challenge.value, undefined)

  state.phone.number.value = phone
  const sending = state.phone.send()
  state.phone.close()
  holdSend?.()
  await sending
  assert.equal(state.phone.open.value, false)
  assert.equal(state.phone.number.value, '')
  assert.equal(state.phone.code.value, '')
  assert.equal(state.phone.challenge.value, undefined)

  state.phone.start()
  state.phone.number.value = phone
  await state.phone.send()
  state.phone.code.value = code
  await state.phone.verify()
  assert.equal(state.phone.open.value, false)
  assert.equal(state.phone.number.value, '')
  assert.equal(state.phone.code.value, '')
  assert.equal(state.pending.value, true)
  assert.equal(state.account.value?.canvas_preparing, true)
  for (let i = 0; i < 80 && !state.account.value?.canvas_ready; i++) await delay(50)
  assert.equal(state.pending.value, false)
  assert.equal(state.account.value?.canvas_ready, true)
  assert.equal(state.account.value?.authenticated, true)
  assert.equal(state.verificationUrl.value, '')

  canvasReady = false
  await state.refresh()
  await state.prepare()
  assert.equal(state.pending.value, true)
  assert.ok(requests.some(request => request.path.endsWith('/auth/start')))
  assert.doesNotMatch(JSON.stringify(logs), /13900000000|123456|sms-\d/u)
})
