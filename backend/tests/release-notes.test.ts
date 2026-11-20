import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

test('release notes are published once by authorized operators and served newest first without caching', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-release-notes-'))
  const origin = 'https://drama.example.test'
  const secret = 'release-test-private-marker-'.repeat(3)
  const env = {
    SQLITE_PATH: join(directory, 'release-notes.sqlite3'),
    MYSQL_AUTO_IMPORT: 'false',
    NODE_ENV: 'production',
    HUOBAO_DESKTOP: '',
    JIMENG_PRIVATE_ORIGIN: origin,
    JIMENG_PRIVATE_PROXY_SECRET: secret,
    FEEDBACK_ADMIN_USER: 'feedback-owner',
    RELEASE_NOTES_ADMIN_USER: 'owner',
  }
  const previousEnv = Object.keys(env).map(key => [key, process.env[key]] as const)
  Object.assign(process.env, env)
  t.after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })

  const { default: settings } = await import('../src/routes/settings.js')
  const app = new Hono().route('/api/v1/settings', settings)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  t.after(async () => new Promise<void>(resolve => server.close(() => resolve())))
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const admin = {
    Host: 'drama.example.test',
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    'X-Drama-Jimeng-Private-Proxy': secret,
    'X-Drama-Authenticated-User': 'owner',
  }
  const member = { ...admin, 'X-Drama-Authenticated-User': 'member' }
  const feedbackOwner = { ...admin, 'X-Drama-Authenticated-User': 'feedback-owner' }
  const call = (method: string, path = '', body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; cacheControl?: string; data: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request({
        host: '127.0.0.1',
        port: address.port,
        path: `/api/v1/settings/release-notes${path}`,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload && { 'Content-Length': String(Buffer.byteLength(payload)) }),
          ...headers,
        },
      }, response => {
        let serialized = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { serialized += chunk })
        response.on('end', () => resolve({
          status: response.statusCode!,
          cacheControl: response.headers['cache-control'],
          data: JSON.parse(serialized).data,
        }))
      })
      req.once('error', reject)
      req.end(payload)
    })

  const access = await call('GET', '/access', undefined, admin)
  assert.equal(access.cacheControl, 'no-store')
  assert.deepEqual(access.data, { canPublish: true })
  assert.deepEqual((await call('GET', '/access', undefined, member)).data, { canPublish: false })
  assert.deepEqual((await call('GET', '/access', undefined, feedbackOwner)).data, { canPublish: false })
  assert.deepEqual((await call('GET', '/access')).data, { canPublish: false })
  const emptyFeed = await call('GET', '', undefined, member)
  assert.equal(emptyFeed.cacheControl, 'no-store')
  assert.deepEqual(emptyFeed.data, { items: [] })

  const update = { requestId: randomUUID(), title: ' 本次优化 ', changes: [' 改善分镜预览 ', '修复视频下载'] }
  assert.equal((await call('POST', '', update, member)).status, 403)
  assert.equal((await call('POST', '', update, feedbackOwner)).status, 403)
  assert.equal((await call('POST', '', update)).status, 403)
  assert.equal((await call('POST', '', update, { ...admin, 'X-Drama-Jimeng-Private-Proxy': 'unverified' })).status, 403)
  assert.equal((await call('POST', '', update, { ...admin, Origin: 'https://other.example.test' })).status, 403)
  assert.equal((await call('POST', '', update, { ...admin, 'Sec-Fetch-Site': 'same-site' })).status, 403)
  assert.equal((await call('POST', '', update, { ...admin, 'Content-Type': 'text/plain' })).status, 400)
  for (const invalid of [
    { requestId: 'invalid' },
    { title: ' ' },
    { title: '字'.repeat(101) },
    { changes: [] },
    { changes: ['  '] },
    { changes: ['字'.repeat(501)] },
    { changes: Array(21).fill('改进') },
  ]) {
    assert.equal((await call('POST', '', { ...update, ...invalid }, admin)).status, 400)
  }
  assert.equal((await call('POST', '', { ...update, title: 'a'.repeat(66_000) }, admin)).status, 413)

  const [first, retry] = await Promise.all([
    call('POST', '', update, admin),
    call('POST', '', { ...update, title: '本次优化', requestId: update.requestId.toUpperCase() }, admin),
  ])
  assert.deepEqual([first.status, retry.status].sort(), [200, 201])
  assert.deepEqual(first.data, retry.data)
  assert.deepEqual(first.data, {
    id: 1,
    title: '本次优化',
    changes: ['改善分镜预览', '修复视频下载'],
    publishedAt: new Date(first.data.publishedAt).toISOString(),
  })
  assert.equal((await call('POST', '', { ...update, changes: ['不同内容'] }, admin)).status, 409)

  process.env.NODE_ENV = 'development'
  assert.deepEqual((await call('GET', '/access')).data, { canPublish: true })
  assert.equal((await call('POST', '', update, { 'Sec-Fetch-Site': 'same-site' })).status, 403)
  process.env.NODE_ENV = 'production'
  process.env.HUOBAO_DESKTOP = '1'
  assert.deepEqual((await call('GET', '/access')).data, { canPublish: true })
  assert.equal((await call('POST', '', update)).status, 200)

  for (let number = 2; number <= 31; number++) {
    const published = await call('POST', '', { ...update, requestId: randomUUID(), title: `更新 ${number}` }, admin)
    assert.equal(published.status, 201)
  }
  const { initDb } = await import('../src/db/index.js')
  initDb()
  const history = await call('GET', '', undefined, member)
  assert.equal(history.data.items.length, 30)
  assert.deepEqual(history.data.items.map((note: { id: number }) => note.id), Array.from({ length: 30 }, (_, index) => 31 - index))
  assert.equal((await call('POST', '', update, admin)).data.id, first.data.id)
})
