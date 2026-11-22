import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test, type TestContext } from 'node:test'
import { runInNewContext } from 'node:vm'

// Run the actual official hook with a logged-in fixture cookie and a failed profile check.
async function officialCallbacks(verificationUrl: string, valid: boolean) {
  const source = await readFile(new URL('./fixtures/libtv-official-web-login.js', import.meta.url), 'utf8')
  const page = new URL(verificationUrl)
  const storage = new Map<string, string>()
  const callbacks: string[] = []
  let validationCalls = 0
  const exports: Record<string, (options: unknown) => () => void> = {}
  const location = { href: page.href, pathname: page.pathname, search: page.search, assign: (url: string) => callbacks.push(url) }
  runInNewContext(source, {
    URL, URLSearchParams, Date, Promise,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    window: { location, history: { replaceState(_state: unknown, _title: string, url: string) {
      const next = new URL(url, location.href); Object.assign(location, { href: next.href, pathname: next.pathname, search: next.search })
    } }, sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) }, addEventListener() {}, removeEventListener() {} },
    document: { addEventListener() {}, removeEventListener() {} },
    e: { s(items: unknown[]) { for (let i = 0; i < items.length; i += 3) exports[String(items[i])] = items[i + 2] as typeof exports[string] } },
    t: { USER_TOKEN_COOKIE_KEY: 'usertoken' }, n: { getCookie: () => 'fixture-only' }, a: '/mcp/authorize',
  })
  const cleanup = exports.M({ validateCredential: async () => { validationCalls++; return valid } })
  await new Promise(resolve => setImmediate(resolve))
  cleanup()
  return { validationCalls, callbacks }
}

async function authorizationFixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-libtv-auth-protocol-'))
  const previous = { VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR, LIBTV_CLI_BIN: process.env.LIBTV_CLI_BIN }
  Object.assign(process.env, { VIDEO_CLI_ACCOUNTS_DIR: directory, LIBTV_CLI_BIN: process.execPath })
  const children: (EventEmitter & { stderr: PassThrough; kill: () => boolean })[] = []
  t.mock.method(childProcess, 'execFile', (_binary: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
    queueMicrotask(() => callback(Object.assign(new Error('fixture only'), { code: 1 }), '', '接口错误 [401]: 未登录'))
    return new EventEmitter()
  })
  t.mock.method(childProcess, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', 1)); return true } })
    children.push(child)
    const callback = `http://127.0.0.1:${23000 + children.length}/callback`
    queueMicrotask(() => child.stderr.write('https://www.liblib.tv/zh?callback_url=' + encodeURIComponent(callback) + '\n'))
    return child
  })
  syncBuiltinESMExports()
  t.after(async () => {
    for (const child of children) child.kill()
    await new Promise(resolve => setImmediate(resolve))
    t.mock.restoreAll(); syncBuiltinESMExports()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(directory, { recursive: true, force: true })
  })
  const profiles = await import('../src/services/video-cli-accounts.js')
  const profile = profiles.createVideoCliAccount('libtv', '测试账号')
  const service = await import('../src/services/libtv-cli.js')
  return { service, children, run: <T>(action: () => T) => service.withLibTVAccount(profile.id, action) }
}

test('官网已登录但资料校验失败时仍按官方 CLI 协议返回，避免静默停在首页', async t => {
  const fixture = await authorizationFixture(t)
  const login = await fixture.run(() => fixture.service.startLibTVAuthorization())
  assert.equal(login.status, 'pending')
  const callback = new URL(new URL(login.verification_url!).searchParams.get('callback_url')!)
  const extended = new URL(callback)
  extended.searchParams.set('state', 'fixture-state')
  extended.searchParams.set('expires_at', String(Date.now() + 300_000))
  const website = new URL('https://www.liblib.tv/zh')
  website.searchParams.set('callback_url', extended.href)
  assert.deepEqual(await officialCallbacks(website.href, false), { validationCalls: 1, callbacks: [] }, '复现官网附加资料校验失败后静默等待')
  const actual = await officialCallbacks(login.verification_url!, false)
  assert.equal(actual.callbacks.length, 1, '已有登录cookie应交给官方CLI验证，不能卡在官网资料校验')
  assert.equal(actual.validationCalls, 0)
  assert.equal(callback.search, '', '本地授权保留官方原始callback协议')
  const helperCallback = new URL(callback)
  helperCallback.searchParams.set('state', 'fixture-assistant-state')
  const helperVerification = new URL(login.verification_url!)
  helperVerification.searchParams.set('callback_url', helperCallback.href)
  assert.equal((await officialCallbacks(helperVerification.href, false)).callbacks.length, 1, '助手保留state但不带expires_at时同样兼容官网')
})

test('过期计时器滞后时也不会复用旧授权，点击连接会启动新流程', async t => {
  const fixture = await authorizationFixture(t)
  const first = await fixture.run(() => fixture.service.startLibTVAuthorization())
  const current = Date.now()
  let clockNow = current + 6 * 60_000
  t.mock.method(Date, 'now', () => clockNow)
  const expired = await fixture.run(() => fixture.service.getLibTVAccount(true))
  assert.equal(expired.status, 'expired')
  assert.equal(expired.verification_url, undefined)
  const next = await fixture.run(() => fixture.service.startLibTVAuthorization())
  assert.equal(next.status, 'pending')
  assert.notEqual(next.verification_url, first.verification_url)
  assert.equal(fixture.children.length, 2)
  clockNow += 6 * 60_000
  const directNext = await fixture.run(() => fixture.service.startLibTVAuthorization())
  assert.notEqual(directNext.verification_url, next.verification_url)
  assert.equal(fixture.children.length, 3, '不先查询状态，直接点连接也必须替换过期子进程')
})
