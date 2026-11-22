import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { useVideoCliAccount, type VideoCliProvider } from '../app/composables/useVideoCliAccount'

async function setup(t: TestContext, providerName: VideoCliProvider, options: {
  deferred?: boolean
  helper?: boolean
  blocked?: boolean
  createError?: string
  authorizationError?: string
} = {}) {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const scope = effectScope()
  t.after(() => {
    scope.stop()
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  let activeAccountId = 'existing'
  const entries = [{ id: 'existing', name: '已有账号' }]
  const sessions = { existing: { authenticated: true, username: '原有已授权账号' }, added: { authenticated: false } }
  const calls: { path: string; body: unknown; method?: string }[] = []
  const browserEvents: string[] = []
  let finishCreate: (() => void) | undefined
  const verificationUrl = providerName === 'jimeng'
    ? 'https://jimeng.jianying.com/authorize' : 'https://www.liblib.tv/?callback_url=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback'
  const helperUrl = 'https://private.example/api/v1/libtv/auth/assistant?state=test-state&accountId=added'
  const popup = { opener: {}, close: () => { browserEvents.push('close') }, location: { replace: (url: string) => { browserEvents.push(url) } } }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'https://private.example/settings', origin: 'https://private.example' },
    open: (url: string) => { assert.equal(url, 'about:blank'); browserEvents.push('open'); return options.blocked ? null : popup },
  } })
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'https://private.example')
    const path = url.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: path + url.search, body, method: init?.method })
    if (path.endsWith('/accounts')) {
      if (init?.method === 'POST') {
        assert.deepEqual(body, {}, '新增账号直接提交，不要求用户先输入名称')
        assert.equal(browserEvents[0], 'open', '应在第一个异步请求之前打开授权窗口，以兼容弹窗拦截策略')
        if (options.deferred) await new Promise<void>(resolve => { finishCreate = resolve })
        if (options.createError) return Response.json({ message: options.createError }, { status: 503 })
        const entry = { id: 'added', name: `${providerName === 'libtv' ? 'LibTV' : '即梦'}账号 2` }
        entries.push(entry)
        return Response.json({ data: entry })
      }
      return Response.json({ data: { accounts: entries, activeAccountId } })
    }
    if (path.endsWith('/added/activate')) { activeAccountId = 'added'; return Response.json({ data: { activeAccountId } }) }
    assert.ok(!path.endsWith('/auth/disconnect'), '添加账号不能断开已有账号')
    if (path.endsWith('/auth/start')) {
      assert.equal(url.searchParams.get('accountId'), 'added', '只能授权新建账号槽')
      if (options.authorizationError) return Response.json({ message: options.authorizationError }, { status: 502 })
      return Response.json({ data: { available: true, authenticated: false, status: 'pending',
        ...(options.helper ? { login_method: 'local_helper', assistant_download_url: helperUrl } : { verification_url: verificationUrl }), expires_at: Date.now() + 300_000 } })
    }
    assert.ok(path.endsWith('/account'), path)
    const id = url.searchParams.get('accountId') as keyof typeof sessions
    assert.ok(sessions[id], `明确读取保存的账号：${id}`)
    return Response.json({ data: { available: true, can_authorize: true, ...sessions[id] } })
  }
  const provider = ref<VideoCliProvider | undefined>(providerName)
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  for (let i = 0; i < 100 && state.busy.value; i++) await nextTick()
  assert.equal(state.selectedAccountId.value, 'existing')
  assert.equal(state.account.value?.authenticated, true)
  return { state, entries, sessions, calls, browserEvents, verificationUrl, helperUrl, popup,
    finishCreate: () => { assert.ok(finishCreate); finishCreate() } }
}

for (const providerName of ['jimeng', 'libtv'] as const) {
  test(`${providerName} 点击添加直接预开授权窗口，自动创建并授权新账号，保留已有登录`, async t => {
    const app = await setup(t, providerName, { deferred: true })
    const adding = app.state.addAccount()
    assert.deepEqual(app.browserEvents, ['open'])
    assert.equal(app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/accounts')).length, 1)
    app.finishCreate()
    assert.equal(await adding, true)
    assert.equal(app.state.selectedAccountId.value, 'added')
    assert.equal(app.state.activeAccountId.value, 'added')
    assert.equal(app.state.pending.value, true)
    assert.equal(app.state.verificationUrl.value, app.verificationUrl)
    assert.deepEqual(app.browserEvents, ['open', app.verificationUrl])
    assert.deepEqual(app.sessions.existing, { authenticated: true, username: '原有已授权账号' })
    assert.ok(!app.calls.some(call => call.path.includes('existing') && call.path.includes('/auth/')))
    assert.equal(app.entries.length, 2)
  })
}

test('私站 LibTV 一键添加转入本机助手授权，不构造平台不支持的私站回调', async t => {
  const app = await setup(t, 'libtv', { helper: true })
  assert.equal(await app.state.addAccount(), true)
  assert.equal(app.state.selectedAccountId.value, 'added')
  assert.equal(app.state.pending.value, true)
  assert.equal(app.state.assistantDownloadUrl.value, app.helperUrl)
  assert.equal(app.state.verificationUrl.value, '')
  assert.deepEqual(app.browserEvents, ['open', 'close'])
  assert.equal(app.sessions.existing.authenticated, true)
})

test('浏览器拦截弹窗时仍保留新账号的官方授权链接供手动打开', async t => {
  const app = await setup(t, 'jimeng', { blocked: true })
  assert.equal(await app.state.addAccount(), true)
  assert.equal(app.state.error.value, '')
  assert.equal(app.state.verificationUrl.value, app.verificationUrl)
  assert.equal(app.state.pending.value, true)
})

test('创建账号失败会关闭预开窗口，并完整显示原因，不改动已有登录', async t => {
  const message = 'LibTV：账号数量已达上限，请先移除不用的账号'
  const app = await setup(t, 'libtv', { createError: message })
  assert.equal(await app.state.addAccount(), false)
  assert.equal(app.state.error.value, message)
  assert.equal(app.state.busy.value, false)
  assert.equal(app.state.pending.value, false)
  assert.deepEqual(app.browserEvents, ['open', 'close'])
  assert.equal(app.entries.length, 1)
  assert.equal(app.sessions.existing.authenticated, true)
})

test('新账号授权失败显示平台原因，保留新账号可重试，并不注销旧账号', async t => {
  const message = '即梦：当前授权服务暂不可用（authorization_unavailable）'
  const app = await setup(t, 'jimeng', { authorizationError: message })
  assert.equal(await app.state.addAccount(), false)
  assert.equal(app.state.error.value, message)
  assert.equal(app.state.selectedAccountId.value, 'added')
  assert.equal(app.state.pending.value, false)
  assert.deepEqual(app.browserEvents, ['open', 'close'])
  assert.equal(app.entries.length, 2)
  assert.equal(app.sessions.existing.authenticated, true)
})
