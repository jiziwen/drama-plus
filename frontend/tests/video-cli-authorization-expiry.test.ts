import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { useVideoCliAccount, type VideoCliProvider } from '../app/composables/useVideoCliAccount'

test('LibTV 手动刷新读到过期的 pending 时清除旧授权链接，不自动请求', async t => {
  const originalFetch = globalThis.fetch
  const scope = effectScope()
  t.after(() => { scope.stop(); globalThis.fetch = originalFetch })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  const link = 'https://www.liblib.tv/?callback_url=old-challenge'
  let account = { available: true, authenticated: false } as Record<string, unknown>
  const calls: string[] = []
  globalThis.fetch = async input => {
    const path = String(input)
    calls.push(path)
    if (path.endsWith('/accounts')) return Response.json({}, { status: 404 })
    return Response.json({ data: path.endsWith('/auth/start')
      ? { available: true, authenticated: false, status: 'pending', verification_url: link, expires_at: 110_000 }
      : account })
  }
  const state = scope.run(() => useVideoCliAccount(ref<VideoCliProvider | undefined>('libtv'), key => key))!
  for (let i = 0; i < 40 && state.busy.value; i++) await nextTick()
  await state.authorize()
  assert.equal(state.verificationUrl.value, link)
  const beforeWait = calls.length
  t.mock.timers.tick(11_000)
  await nextTick()
  assert.equal(calls.length, beforeWait, '授权过期也不能自动请求账号状态')
  assert.equal(state.pending.value, false, '单次本地计时应结束过期等待')
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.account.value?.status, 'expired')
  account = { available: true, authenticated: false, status: 'pending', expires_at: 110_000 }
  await state.refresh()
  assert.equal(state.pending.value, false)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.assistantDownloadUrl.value, '')
  assert.equal(state.error.value, 'settings.libtv.expired')
  account = { available: true, authenticated: true, status: 'pending', canvas_preparing: true, expires_at: 110_000 }
  await state.refresh()
  assert.equal(state.pending.value, true, '已登录后准备画布不应被旧授权时限终止')
  assert.equal(state.error.value, '')
  const beforeCanvasWait = calls.length
  t.mock.timers.tick(60_000)
  await nextTick()
  assert.equal(state.pending.value, true)
  assert.equal(calls.length, beforeCanvasWait)
})

test('LibTV 拒绝打开服务端返回的过期授权挑战', async t => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const scope = effectScope()
  t.after(() => {
    scope.stop(); globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  const opened: string[] = []
  let closes = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    open: () => ({ opener: null, close: () => { closes++ }, location: { replace: (url: string) => opened.push(url) } }),
  } })
  globalThis.fetch = async input => {
    const path = String(input)
    if (path.endsWith('/accounts')) return Response.json({}, { status: 404 })
    return Response.json({ data: path.endsWith('/auth/start')
      ? { available: true, authenticated: false, status: 'pending', expires_at: 99_000,
        verification_url: 'https://www.liblib.tv/?callback_url=expired-challenge' }
      : { available: true, authenticated: false } })
  }
  const state = scope.run(() => useVideoCliAccount(ref<VideoCliProvider | undefined>('libtv'), key => key))!
  for (let i = 0; i < 40 && state.busy.value; i++) await nextTick()
  assert.equal(await state.authorize(), false)
  assert.deepEqual(opened, [])
  assert.equal(closes, 1)
  assert.equal(state.pending.value, false)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.error.value, 'settings.libtv.expired')
})
