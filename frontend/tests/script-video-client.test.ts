import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { scriptVideoRequest } from '../app/utils/scriptVideoClient'

function simulateBrowser(t: TestContext) {
  const tabs: EventTarget[] = []
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.mock.method(globalThis, 'fetch', (_path: string, init: RequestInit) => new Response(JSON.stringify({
    data: new Headers(init.headers).get('X-Script-Video-Session'),
  })))
  t.after(() => {
    tabs.forEach(tab => tab.dispatchEvent(new Event('pagehide')))
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  function tab(storage: Map<string, string>, navigationType: string, navigator?: Pick<Navigator, 'locks'>) {
    const browser = Object.assign(new EventTarget(), {
      crypto: globalThis.crypto,
      navigator,
      BroadcastChannel,
      performance: { getEntriesByType: () => [{ type: navigationType }] },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) || null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    })
    tabs.push(browser)
    return browser
  }
  function session(browser: EventTarget) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
    return scriptVideoRequest<string>('/projects')
  }
  return { tab, session }
}

test('a reload reuses the previous session after exit, while copies of sessionStorage get distinct headers', async (t) => {
  const { tab, session } = simulateBrowser(t)
  const storage = new Map<string, string>()
  class SilentClaimChannel extends BroadcastChannel {
    override postMessage(message: unknown) {
      if (message !== 'claimed') super.postMessage(message)
    }
  }
  const original = Object.assign(tab(storage, 'navigate'), { BroadcastChannel: SilentClaimChannel })
  const originalId = await session(original)

  const copies = await Promise.all([
    session(tab(new Map(storage), 'navigate')),
    session(tab(new Map(storage), 'reload')),
  ])
  assert.equal(new Set([originalId, ...copies]).size, 3)
  assert.equal(await session(original), originalId)

  original.dispatchEvent(new Event('pagehide'))
  const reloaded = Object.assign(tab(storage, 'reload'), { BroadcastChannel: SilentClaimChannel })
  assert.equal(await session(reloaded), originalId)
  assert.notEqual(await session(tab(new Map(storage), 'reload')), originalId)
})

test('a secure-context reload waits for the old document to give up its Web Lock', {
  skip: !globalThis.navigator?.locks,
}, async (t) => {
  const { tab, session } = simulateBrowser(t)
  const storage = new Map<string, string>()
  const features = { locks: globalThis.navigator.locks }
  const original = tab(storage, 'navigate', features)
  const originalId = await session(original)

  const copiedTab = tab(new Map(storage), 'reload', features)
  assert.notEqual(await session(copiedTab), originalId)

  const reload = session(tab(storage, 'reload', features))
  original.dispatchEvent(new Event('pagehide'))
  assert.equal(await reload, originalId)
})

test('the original document reclaims its session when restored from the back-forward cache', async (t) => {
  const { tab, session } = simulateBrowser(t)
  const page = tab(new Map(), 'navigate')
  const originalId = await session(page)
  page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }))
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
  assert.equal(await session(page), originalId)
})

test('when tab storage is unavailable, the document can still make requests with an isolated session', async (t) => {
  const { tab, session } = simulateBrowser(t)
  const open = () => {
    const page = tab(new Map(), 'reload')
    Object.defineProperty(page, 'sessionStorage', {
      get: () => { throw new DOMException('Storage disabled', 'SecurityError') },
    })
    return page
  }
  const original = open()
  const originalId = await session(original)
  assert.equal(await session(original), originalId)
  assert.notEqual(await session(open()), originalId)
})
