import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import jimeng, { denyJimengPrivateAccess, requireJimengPrivateAccess } from '../src/routes/jimeng.js'

test('Jimeng requires the private gateway marker, exact host, and same-origin browser provenance', async t => {
  const app = new Hono()
  app.all('/check', c => {
    try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
    return c.text('ok')
  })
  app.route('/jimeng', jimeng)
  const envKeys = ['JIMENG_PRIVATE_ORIGIN', 'JIMENG_PRIVATE_PROXY_SECRET', 'JIMENG_PRIVATE_PROXY_SECRET_FILE']
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  const directory = await mkdtemp(join(tmpdir(), 'drama-jimeng-gateway-'))
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const status = (method: string, headers: Record<string, string> = {}, path = '/check') => new Promise<number>((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port: address.port, path, method, headers }, response => {
      response.resume()
      resolve(response.statusCode!)
    })
    call.once('error', reject)
    call.end()
  })

  const host = 'drama.example.test'
  const origin = `https://${host}`
  const marker = 'X-Drama-Jimeng-Private-Proxy'
  const secret = 'test-private-proxy-secret-'.repeat(3)
  const gateway = { Host: host, [marker]: secret }
  for (const key of envKeys) delete process.env[key]

  assert.equal(await status('POST'), 200, 'allow direct loopback clients')
  assert.equal(await status('POST', { Origin: 'http://localhost:3013', 'Sec-Fetch-Site': 'same-origin' }), 200, 'allow the local frontend dev proxy')
  assert.equal(await status('GET', { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'cross-site' }), 403)
  assert.equal(await status('GET', gateway), 403, 'the proxy route requires an explicit configuration')

  process.env.JIMENG_PRIVATE_ORIGIN = origin
  process.env.JIMENG_PRIVATE_PROXY_SECRET = secret
  assert.equal(await status('GET', gateway), 200, 'same-origin reads may omit the Origin header')
  assert.equal(await status('POST', { ...gateway, Origin: origin }), 200, 'accept an exact Origin even without Fetch Metadata')
  assert.equal(await status('PUT', { ...gateway, 'Sec-Fetch-Site': 'same-origin' }), 200, 'accept same-origin Fetch Metadata when Origin is absent')
  assert.equal(await status('POST', gateway), 403, 'mutations require browser provenance beyond the gateway marker')
  assert.equal(await status('GET', { Host: host, Origin: origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '127.0.0.1' }), 403)
  assert.equal(await status('POST', { ...gateway, [marker]: 'bad-' + secret, Origin: origin }), 403)
  assert.equal(await status('POST', { ...gateway, Host: 'other.example.test', 'X-Forwarded-Host': host, Origin: origin }), 403)
  assert.equal(await status('POST', { ...gateway, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' }), 403)
  assert.equal(await status('POST', { ...gateway, Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'same-site' }), 403)
  assert.equal(await status('POST', { ...gateway, Origin: origin, 'Sec-Fetch-Site': 'cross-site' }), 403)
  assert.equal(await status('POST', { ...gateway, Origin: origin, 'Sec-Fetch-Site': 'cross-site' }, '/jimeng/auth/disconnect'), 403)
  assert.equal(await status('POST', { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'cross-site' }, '/jimeng/auth/disconnect'), 403)
  assert.equal(await status('GET', { ...gateway, 'Sec-Fetch-Site': 'same-site' }), 403)

  delete process.env.JIMENG_PRIVATE_PROXY_SECRET
  process.env.JIMENG_PRIVATE_PROXY_SECRET_FILE = join(directory, 'missing')
  assert.equal(await status('GET', gateway), 403, 'a missing marker file fails closed')
  await writeFile(process.env.JIMENG_PRIVATE_PROXY_SECRET_FILE, secret + '\n', { mode: 0o600 })
  assert.equal(await status('GET', gateway), 200, 'read the marker from the mounted secret file')
  process.env.JIMENG_PRIVATE_ORIGIN = `${origin}/not-an-origin`
  assert.equal(await status('GET', gateway), 403, 'a misconfigured origin fails closed')
})
