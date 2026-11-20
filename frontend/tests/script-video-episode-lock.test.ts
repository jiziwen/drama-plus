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
  options: Parameters<typeof useScriptVideoEpisodeLock>[0],
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
      lock = useScriptVideoEpisodeLock(options)
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

test('denied entry keeps the existing lease and a rejected renewal ends that ownership', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  const lost: string[] = []
  const requests: { path: string; method?: string; body?: BodyInit | null; session: string | null }[] = []
  const lock = mount(t, (path, init) => {
    requests.push({
      path, method: init?.method, body: init?.body,
      session: new Headers(init?.headers).get('X-Script-Video-Session'),
    })
    if (path.endsWith('/second/lock') || init?.body) return locked()
    return ok({ expiresAt: Date.now() + 30_000 })
  }, { onLost: (lease) => { lost.push(lease.episodeId) } })

  await lock.enter('project', 'first')
  await assert.rejects(lock.enter('project', 'second'), { status: 423, code: 'EPISODE_LOCKED' })
  assert.equal(lock.owns('project', 'first'), true)
  assert.equal(requests.some(request => request.method === 'DELETE'), false)
  assert.match(requests[0]!.session!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(requests[1]!.session, requests[0]!.session)

  t.mock.timers.tick(8_000)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  assert.equal(requests.at(-1)?.body, '{"renew":true}')
  assert.equal(lock.active.value, null)
  assert.deepEqual(lost, ['first'])
})

test('a late roster response from the previous project cannot replace current occupations', async (t) => {
  const resolve = new Map<string, (response: Response) => void>()
  const lock = mount(t, (url) => new Promise(done => resolve.set(url.split('/').at(-2)!, done)), {
    onLost: () => {},
  })
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

test('pagehide leaves a dirty draft protected and releases clean ownership on a later exit', async (t) => {
  let clean = false
  const releases: RequestInit[] = []
  const lock = mount(t, (_path, init) => {
    if (init?.method === 'DELETE') releases.push(init)
    return ok({ expiresAt: Date.now() + 30_000 })
  }, { onLost: () => {}, canReleaseOnPageHide: () => clean })

  await lock.enter('project', 'episode')
  window.dispatchEvent(new Event('pagehide'))
  await new Promise<void>((done) => { setImmediate(done) })
  assert.equal(releases.length, 0)

  window.dispatchEvent(new Event('pageshow'))
  await new Promise<void>((done) => { setImmediate(done) })
  assert.equal(lock.owns('project', 'episode'), true)
  clean = true
  window.dispatchEvent(new Event('pagehide'))
  await new Promise<void>((done) => { setImmediate(done) })
  assert.equal(releases.length, 1)
  assert.equal(releases[0]?.keepalive, true)
})

test('reloadable clean ownership survives document exit, while explicit leave sends DELETE', async (t) => {
  const releases: RequestInit[] = []
  const lock = mount(t, (_path, init) => {
    if (init?.method === 'DELETE') releases.push(init)
    return ok({ expiresAt: Date.now() + 30_000 })
  }, { onLost: () => {}, canReleaseOnPageHide: () => true }, {
    BroadcastChannel,
    sessionStorage: { getItem: () => null, setItem: () => {} },
  })

  await lock.enter('project', 'episode')
  window.dispatchEvent(new Event('pagehide'))
  await new Promise<void>(done => { setImmediate(done) })
  assert.equal(releases.length, 0)

  window.dispatchEvent(new Event('pageshow'))
  await lock.leave()
  assert.equal(releases.length, 1)
  assert.equal(releases[0]?.keepalive, false)
})

test('hidden tabs stop fetching the roster while their active episode lease still renews', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 })
  let rosterRequests = 0
  let renewals = 0
  const lock = mount(t, (url, init) => {
    if (url.endsWith('/episode-locks')) {
      rosterRequests++
      return ok({})
    }
    if (init?.body) renewals++
    return ok({ expiresAt: Date.now() + 30_000 })
  }, { onLost: () => {} })
  lock.watchProject('project')
  await lock.refresh()
  assert.equal(rosterRequests, 1)
  t.mock.timers.tick(4_000)
  assert.equal(rosterRequests, 1)
  t.mock.timers.tick(6_000)
  await lock.refresh()
  assert.equal(rosterRequests, 2)

  await lock.enter('project', 'episode')
  await lock.refresh()
  assert.equal(rosterRequests, 3)
  Object.assign(document, { hidden: true })
  document.dispatchEvent(new Event('visibilitychange'))
  t.mock.timers.tick(12_000)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await lock.refresh()
  assert.equal(rosterRequests, 3)
  assert.equal(renewals, 1)
  assert.equal(lock.owns('project', 'episode'), true)

  Object.assign(document, { hidden: false })
  document.dispatchEvent(new Event('visibilitychange'))
  await lock.refresh()
  window.dispatchEvent(new Event('focus'))
  await lock.refresh()
  assert.equal(rosterRequests, 4)
  assert.equal(renewals, 1)
})
