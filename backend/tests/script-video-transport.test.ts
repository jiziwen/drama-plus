import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retryBeforeTlsHandshake } from '../src/agents/tls-retry.js'

test('retries only resets known to precede TLS and never replays an accepted or ambiguous request', async () => {
  let calls = 0
  const reset = () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'Client network socket disconnected before secure TLS connection was established' } })
  const fetcher = retryBeforeTlsHandshake((async () => { if (++calls < 3) throw reset(); return new Response('ok') }) as typeof fetch)
  assert.equal(await (await fetcher('https://fixture.invalid', { method: 'POST' })).text(), 'ok')
  assert.equal(calls, 3)
  calls = 0
  await assert.rejects(retryBeforeTlsHandshake((async () => { calls++; throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'socket closed after write' } }) }) as typeof fetch)('https://fixture.invalid'))
  assert.equal(calls, 1)
  calls = 0
  assert.equal((await retryBeforeTlsHandshake((async () => { calls++; return new Response('bad', { status: 400 }) }) as typeof fetch)('https://fixture.invalid')).status, 400)
  assert.equal(calls, 1)
})
