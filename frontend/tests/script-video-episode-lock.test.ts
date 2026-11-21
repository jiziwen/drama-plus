import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createRenderer } from 'vue'
import { useScriptVideoEpisodeLock } from '../app/composables/useScriptVideoEpisodeLock'

const renderer = createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert() {},
  remove() {},
  patchProp() {},
  setText() {},
  setElementText() {},
  parentNode: () => null,
  nextSibling: () => null,
})

const ok = (data: unknown) => Response.json({ data })
const locked = () => Response.json({ message: '制作中', errorCode: 'EPISODE_LOCKED' }, { status: 423 })

function mount(
  t: TestContext,
  fetcher: (url: string, init?: RequestInit) => Response | Promise<Response>,
  browserFeatures: Record<string, unknown> = {},
) {
  const browser = Object.assign(new EventTarget(), { crypto: globalThis.crypto }, browserFeatures)
  const browserDocument = Object.assign(new EventTarget(), { hidden: false })
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browserDocument })
  t.mock.method(globalThis, 'fetch', fetcher)
  let lock!: ReturnType<typeof useScriptVideoEpisodeLock>
  const app = renderer.createApp({
    setup() {
      lock = useScriptVideoEpisodeLock()
      return () => null
    },
  })
  app.mount({})
  t.after(() => {
    app.unmount()
    browser.dispatchEvent(new Event('pagehide'))
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  })
  return lock
}

test('编辑不等待在线提示，续报失败后仍能切集和继续编辑', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 })
  const calls: string[] = []
  const presence = mount(t, (url, init) => {
    calls.push(init?.method + ' ' + url)
    return locked()
  })
  presence.enter('project', 'first')
  assert.equal(presence.owns('project', 'first'), true)
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(31_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(presence.owns('project', 'first'), true)
  presence.enter('project', 'second')
  assert.equal(presence.owns('project', 'second'), true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(calls.some(call => call.includes('DELETE') && call.endsWith('/first/lock')))
})

test('a late roster response from the previous project cannot replace current occupations', async (t) => {
  const resolve = new Map<string, (response: Response) => void>()
  const lock = mount(t, (url) => new Promise(done => resolve.set(url.split('/').at(-2)!, done)))
  lock.watchProject('first')
  lock.watchProject('second')
  const ready = lock.refresh()
  await new Promise<void>((done) => { setImmediate(done) })
  resolve.get('second')!(ok({ 'working-episode': { expiresAt: 130_000 } }))
  await ready
  resolve.get('first')!(ok({ 'old-episode': { expiresAt: 130_000 } }))
  await new Promise<void>((done) => { setImmediate(done) })
  assert.deepEqual(lock.occupied.value, { 'working-episode': { expiresAt: 130_000 } })
})

test('暂停和恢复页面只更新在线提示，始终保留分集选择', async t => {
  const methods: Array<string | undefined> = []
  const lock = mount(t, (_url, init) => {
    methods.push(init?.method)
    return ok({ expiresAt: Date.now() + 30_000 })
  })
  lock.enter('project', 'episode')
  await new Promise<void>(resolve => setImmediate(resolve))
  window.dispatchEvent(new Event('pagehide'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(lock.owns('project', 'episode'), true)
  window.dispatchEvent(new Event('pageshow'))
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(methods, ['POST', 'DELETE', 'POST'])
  lock.leave()
  assert.equal(lock.owns('project', 'episode'), false)
})

test('后台暂停在线提示请求，切回前台恢复状态', async t => {
  t.mock.timers.enable({ apis: ['setTimeout','setInterval','Date'], now: 100_000 })
  let roster = 0, beats = 0
  const lock = mount(t, (url, init) => {
    if (url.endsWith('/episode-locks')) { roster++; return ok({}) }
    if (init?.method === 'POST') beats++
    return ok({})
  })
  const settle = () => new Promise<void>(resolve => setImmediate(resolve))
  lock.watchProject('project')
  lock.enter('project', 'episode')
  await settle()
  Object.assign(document, { hidden: true })
  document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(60_000)
  await settle()
  assert.deepEqual([roster, beats], [1, 1])
  assert.equal(lock.owns('project','episode'), true)
  Object.assign(document, { hidden: false })
  document.dispatchEvent(new Event('visibilitychange'))
  await settle()
  assert.deepEqual([roster, beats], [2, 2])
})
