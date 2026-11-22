import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import { useVideoCliAccount, type VideoCliProvider } from '../app/composables/useVideoCliAccount'

test('配置新增不读取其他账号，编辑和授权只使用配置绑定的账号', async t => {
  const originalFetch = globalThis.fetch
  const scope = effectScope()
  t.after(() => { scope.stop(); globalThis.fetch = originalFetch })
  const calls: { method: string; path: string }[] = []
  const entries = [{ id: 'first', name: '当前账号' }, { id: 'second', name: '已绑定账号' }]
  let finishSecondRead: ((response: Response) => void) | undefined
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push({ method: init?.method || 'GET', path: url.pathname + url.search })
    if (url.pathname.endsWith('/accounts')) return Response.json({ data: { accounts: entries, activeAccountId: 'first' } })
    if (url.pathname.endsWith('/accounts/second')) {
      entries[1]!.name = JSON.parse(String(init?.body)).name
      return Response.json({ data: entries[1] })
    }
    const id = url.searchParams.get('accountId')
    if (url.pathname.endsWith('/auth/start')) {
      return Response.json({ data: { available: true, status: 'pending', verification_url: 'https://jimeng.jianying.com/authorize' } })
    }
    if (id === 'second' && !finishSecondRead) {
      return new Promise<Response>(resolve => { finishSecondRead = resolve })
    }
    return Response.json({ data: { available: true, authenticated: true, username: id } })
  }
  const provider = ref<VideoCliProvider | undefined>('jimeng')
  const accountId = ref<string>()
  const state = scope.run(() => useVideoCliAccount(provider, key => key, { accountId }))!
  const settle = async () => { for (let i = 0; i < 40; i++) await nextTick() }

  await state.refresh()
  assert.equal(await state.authorize(), false)
  assert.deepEqual(calls, [])

  accountId.value = 'second'
  await settle()
  assert.equal(state.selectedAccountId.value, 'second')
  assert.deepEqual(state.accounts.value, [entries[1]])
  assert.ok(finishSecondRead)
  accountId.value = 'first'
  await settle()
  finishSecondRead(Response.json({ data: { available: true, username: '过期的账号结果' } }))
  await settle()
  assert.equal(state.account.value?.username, 'first')

  accountId.value = 'second'
  await settle()
  assert.equal(await state.selectAccount('first'), false)
  assert.equal(await state.renameAccount('绑定账号新名称'), true)
  assert.deepEqual(state.accounts.value, [{ id: 'second', name: '绑定账号新名称' }])
  assert.equal(await state.authorize(), true)
  assert.ok(calls.some(call => call.method === 'PUT' && call.path.endsWith('/accounts/second')))
  assert.ok(calls.some(call => call.method === 'POST' && call.path.endsWith('/auth/start?accountId=second')))
  assert.ok(!calls.some(call => call.path.endsWith('/activate')))
})

test('添加、切换、重命名和删除后仅查询当前账号', async t => {
  const originalFetch = globalThis.fetch
  const scope = effectScope()
  t.after(() => { scope.stop(); globalThis.fetch = originalFetch })
  let activeAccountId = 'first'
  let entries = [{ id: 'first', name: '已有账号' }, { id: 'second', name: '工作账号' }]
  const calls: { path: string; body: any }[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    const path = url.pathname.replace('/api/v1', '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname + url.search, body })
    if (path === '/libtv/accounts') {
      if (init?.method === 'POST') {
        assert.deepEqual(body, {})
        const entry = { id: 'third', name: 'LibTV账号 3' }
        entries.push(entry)
        return Response.json({ data: entry })
      }
      return Response.json({ data: { accounts: entries, activeAccountId } })
    }
    const match = path.match(/^\/libtv\/accounts\/([^/]+)(\/activate)?$/u)
    if (match) {
      if (match[2]) activeAccountId = match[1]!
      else if (init?.method === 'PUT') entries.find(entry => entry.id === match[1])!.name = body.name
      else if (init?.method === 'DELETE') { entries = entries.filter(entry => entry.id !== match[1]); activeAccountId = entries[0]!.id }
      return Response.json({ data: { accounts: entries, activeAccountId } })
    }
    const id = url.searchParams.get('accountId')
    assert.equal(id, activeAccountId, '每次账号请求必须明确传递所选账号')
    if (path.endsWith('/auth/start')) return Response.json({ data: { available: true, authenticated: false,
      status: 'pending', verification_url: 'https://www.liblib.tv/?callback_url=http%3A%2F%2F127.0.0.1%3A54321%2Fcallback', expires_at: Date.now() + 300_000 } })
    return Response.json({ data: { available: true, authenticated: false, username: id, can_authorize: true, can_authorize_phone: true } })
  }
  const provider = ref<VideoCliProvider | undefined>('libtv')
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  for (let i = 0; i < 100 && state.busy.value; i++) await nextTick()
  assert.equal(state.accounts.value.length, 2)
  assert.equal(state.selectedAccountId.value, 'first')
  await state.selectAccount('second')
  assert.equal(state.account.value?.username, 'second')
  await state.renameAccount('新名称')
  assert.equal(state.accounts.value.find(entry => entry.id === 'second')?.name, '新名称')
  assert.equal(await state.addAccount(), true)
  assert.equal(state.selectedAccountId.value, 'third')
  assert.equal(state.activeAccountId.value, 'third')
  assert.equal(await state.removeAccount(), true)
  assert.equal(state.selectedAccountId.value, 'first')
  assert.ok(calls.some(call => call.path.endsWith('/accounts/second/activate')))
  assert.ok(calls.some(call => call.path.endsWith('/auth/start?accountId=third')))
})

for (const providerName of ['jimeng', 'libtv'] as const) {
  test(`${providerName} 手动刷新绑定当前账号，失败原因完整显示，切换不接收旧状态`, async t => {
    const originalFetch = globalThis.fetch
    const scope = effectScope()
    t.after(() => { scope.stop(); globalThis.fetch = originalFetch })
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
    let activeAccountId = 'first'
    let authorized = false
    let delayNextRead = false
    let staleResponse: ((response: Response) => void) | undefined
    const urls: URL[] = []
    const failure = `${providerName === 'libtv' ? 'LibTV' : '即梦'} 生成失败：当前账号积分不足，请充值后重试（quota_exceeded）`
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://localhost')
      urls.push(url)
      const path = url.pathname
      if (path.endsWith('/accounts')) return Response.json({ data: { accounts: [{ id: 'first', name: '账号一' }, { id: 'second', name: '账号二' }], activeAccountId } })
      if (path.endsWith('/activate')) {
        activeAccountId = path.includes('/first/') ? 'first' : 'second'
        return Response.json({ data: { activeAccountId } })
      }
      assert.equal(url.searchParams.get('accountId'), activeAccountId)
      if (path.endsWith('/auth/start')) return Response.json({ data: { available: true, status: 'pending',
        verification_url: providerName === 'libtv' ? 'https://www.liblib.tv/?callback_url=test' : 'https://jimeng.jianying.com/authorize', expires_at: Date.now() + 300_000 } })
      if (path.endsWith('/account') && delayNextRead) {
        delayNextRead = false
        return new Promise<Response>(resolve => { staleResponse = resolve })
      }
      if (path.endsWith('/auth/phone/send')) {
        assert.equal(JSON.parse(String(init?.body)).phone, '13900000000')
        return Response.json({ data: { challenge_id: 'phone-challenge', expires_at: Date.now() + 300_000 } })
      }
      if (path.endsWith('/auth/phone/verify')) {
        assert.deepEqual(JSON.parse(String(init?.body)), { challenge_id: 'phone-challenge', code: '123456' })
        authorized = true
      }
      return Response.json({ data: { available: true, authenticated: authorized, can_authorize: true, can_authorize_phone: true, username: activeAccountId } })
    }
    const provider = ref<VideoCliProvider | undefined>(providerName)
    const state = scope.run(() => useVideoCliAccount(provider, key => key))!
    const settle = async () => { for (let i = 0; i < 100 && state.busy.value; i++) await nextTick() }
    await settle()
    await state.authorize()
    assert.equal(state.pending.value, true)
    const beforeWaiting = urls.length
    t.mock.timers.tick(2500)
    await nextTick()
    assert.equal(urls.length, beforeWaiting, '授权等待期间不自动刷新')
    delayNextRead = true
    const delayedRefresh = state.refresh()
    await settle()
    assert.ok(staleResponse)
    // Closing and reopening the settings dialog invalidates an in-flight response.
    provider.value = undefined
    await nextTick()
    provider.value = providerName
    await nextTick()
    await settle()
    await state.selectAccount('second')
    staleResponse!(Response.json({ data: { available: true, authenticated: true, username: '错误的旧账号' } }))
    await delayedRefresh
    await nextTick()
    await nextTick()
    assert.equal(state.selectedAccountId.value, 'second')
    assert.equal(state.account.value?.username, 'second')
    await state.authorize()
    const beforeFailureRefresh = urls.length
    t.mock.timers.tick(2500)
    await nextTick()
    assert.equal(urls.length, beforeFailureRefresh)
    delayNextRead = true
    const failedRefresh = state.refresh()
    await settle()
    staleResponse!(Response.json({ data: { available: true, status: 'failed', message: failure, can_authorize: true, can_authorize_phone: true } }))
    await failedRefresh
    assert.equal(state.error.value, failure)
    assert.equal(state.pending.value, false)
    if (providerName === 'libtv') {
      state.phone.start()
      state.phone.number.value = '13900000000'
      await state.phone.send()
      state.phone.code.value = '123456'
      await state.phone.verify()
      assert.equal(state.account.value?.authenticated, true)
      assert.ok(urls.some(url => url.pathname.endsWith('/auth/phone/verify') && url.searchParams.get('accountId') === 'second'))
    }
    assert.ok(urls.some(url => url.pathname.endsWith('/account') && url.searchParams.get('accountId') === 'second'))
    assert.ok(!urls.some(url => url.pathname.endsWith('/auth/status')))
  })
}

test('私站 LibTV 授权助手完成后手动刷新，拒绝第三方下载地址', async t => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const scope = effectScope()
  t.after(() => {
    scope.stop()
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  let closes = 0
  let authenticated = false
  let reads = 0
  const expected = 'https://private.example/api/v1/libtv/auth/assistant?state=one-time-test&accountId=work'
  let downloadUrl = expected
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href: 'https://private.example/settings', origin: 'https://private.example' },
    open: () => ({ opener: null, close: () => { closes++ }, location: { replace: () => assert.fail('助手模式不能把网页登录地址改为私站回调') } }),
  } })
  globalThis.fetch = async input => {
    reads++
    const url = new URL(String(input), 'https://private.example')
    if (url.pathname.endsWith('/accounts')) return Response.json({ data: { accounts: [{ id: 'work', name: '工作账号' }], activeAccountId: 'work' } })
    assert.equal(url.searchParams.get('accountId'), 'work')
    if (url.pathname.endsWith('/auth/start')) return Response.json({ data: { available: true, authenticated: false,
      status: 'pending', login_method: 'local_helper', assistant_download_url: downloadUrl, expires_at: Date.now() + 300_000 } })
    assert.ok(!url.pathname.endsWith('/auth/status'))
    return Response.json({ data: { available: true, authenticated, can_authorize: true, canvas_ready: authenticated } })
  }
  const provider = ref<VideoCliProvider | undefined>('libtv')
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  const settle = async () => { for (let i = 0; i < 100 && state.busy.value; i++) await nextTick() }
  await settle()
  await state.authorize()
  assert.equal(state.error.value, '')
  assert.equal(state.pending.value, true)
  assert.equal(state.verificationUrl.value, '')
  assert.equal(state.assistantDownloadUrl.value, expected)
  assert.equal(closes, 1)
  const beforeRefresh = reads
  authenticated = true
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(reads, beforeRefresh, '助手授权完成也不应自动发起请求')
  assert.equal(state.pending.value, true)
  await state.refresh()
  assert.equal(state.account.value?.authenticated, true)
  assert.equal(state.pending.value, false)
  assert.equal(state.assistantDownloadUrl.value, '')
  provider.value = undefined
  await nextTick()
  authenticated = false
  downloadUrl = 'https://private.example.attacker.invalid/api/v1/libtv/auth/assistant?state=malicious'
  provider.value = 'libtv'
  await nextTick()
  await settle()
  await state.authorize()
  assert.equal(state.pending.value, false)
  assert.equal(state.assistantDownloadUrl.value, '')
  assert.equal(state.error.value, 'settings.libtv.invalidAuthorizationUrl')
})

test('移除最后一个账号后显示空状态，不再请求不存在的默认账号', async t => {
  const originalFetch = globalThis.fetch
  const scope = effectScope()
  t.after(() => { scope.stop(); globalThis.fetch = originalFetch })
  let accountReads = 0
  globalThis.fetch = async input => {
    if (String(input).endsWith('/accounts')) return Response.json({ data: { accounts: [], activeAccountId: 'default' } })
    accountReads++
    return Response.json({ message: '账号不存在' }, { status: 404 })
  }
  const provider = ref<VideoCliProvider | undefined>('libtv')
  const state = scope.run(() => useVideoCliAccount(provider, key => key))!
  for (let i = 0; i < 100 && state.busy.value; i++) await nextTick()
  assert.equal(state.accounts.value.length, 0)
  assert.equal(state.selectedAccountId.value, '')
  assert.equal(state.account.value, null)
  assert.equal(state.error.value, '')
  assert.equal(accountReads, 0)
})
