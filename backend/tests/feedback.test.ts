import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import sharp from 'sharp'

test('site administrators can review member feedback with or without a dedicated feedback operator', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-feedback-'))
  const origin = 'https://drama.example.test'
  const secret = 'feedback-test-private-marker-'.repeat(3)
  const original = new Map<string, string | undefined>()
  function setEnv(key: string, value: string) {
    if (!original.has(key)) original.set(key, process.env[key])
    process.env[key] = value
  }
  setEnv('SQLITE_PATH', join(directory, 'feedback.sqlite3'))
  setEnv('NODE_ENV', 'production')
  setEnv('HUOBAO_DESKTOP', '')
  setEnv('JIMENG_PRIVATE_ORIGIN', origin)
  setEnv('JIMENG_PRIVATE_PROXY_SECRET', secret)
  setEnv('FEEDBACK_ADMIN_USER', '')
  setEnv('RELEASE_NOTES_ADMIN_USER', 'publisher')
  t.after(async () => {
    for (const [key, value] of original) {
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

  const gateway = { Host: 'drama.example.test', Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-Drama-Jimeng-Private-Proxy': secret }
  const reporter = { ...gateway, 'X-Drama-Authenticated-User': 'reporter' }
  const anotherMember = { ...gateway, 'X-Drama-Authenticated-User': 'another-reporter' }
  const operator = { ...gateway, 'X-Drama-Authenticated-User': 'owner' }
  const administrator = { ...gateway, 'X-Drama-Authenticated-User': 'publisher' }
  const call = async (method: string, route = '', body?: unknown, headers: Record<string, string> = {}) => {
    const form = body instanceof FormData ? new Response(body) : null
    const payload = form ? Buffer.from(await form.arrayBuffer()) : body === undefined ? undefined : JSON.stringify(body)
    return new Promise<{ status: number; data: any; bytes: Buffer; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
      const call = request({ host: '127.0.0.1', port: address.port, path: `/api/v1/settings/feedback${route}`, method, headers: {
        'Content-Type': form?.headers.get('Content-Type') ?? 'application/json', ...headers,
      } }, response => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const bytes = Buffer.concat(chunks)
          const data = response.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString()).data : undefined
          resolve({ status: response.statusCode!, data, bytes, headers: response.headers })
        })
      })
      call.once('error', reject)
      call.end(payload)
    })
  }

  assert.equal((await call('GET', '/access', undefined, operator)).data.canManage, false)
  assert.equal((await call('GET', '/manage', undefined, operator)).status, 403)
  assert.equal((await call('GET', '/access', undefined, administrator)).data.canManage, true)
  assert.equal((await call('GET', '/access', undefined, reporter)).data.canManage, false)
  assert.equal((await call('GET', '/manage', undefined, reporter)).status, 403)
  assert.equal((await call('GET', '/manage')).status, 403, 'production loopback bypass is disabled')
  assert.equal((await call('GET', '/manage', undefined, { ...administrator, 'X-Drama-Jimeng-Private-Proxy': 'unverified' })).status, 403)
  assert.equal((await call('POST', '', { title: 'Administrator submission', description: 'Denied' }, administrator)).status, 403)

  assert.equal((await call('POST', '', { title: ' ', description: 'a problem' }, reporter)).status, 400)
  assert.equal((await call('POST', '', { title: 'Preview', description: 'a'.repeat(50_000) }, reporter)).status, 413)
  const submitted = await call('POST', '', { title: ' Preview ', description: 'Video never appears.', pagePath: '/script-to-video', contact: 'reply@example.test' }, reporter)
  assert.equal(submitted.status, 201)
  assert.deepEqual(Object.keys(submitted.data), ['id'])

  const queue = await call('GET', '/manage?status=open', undefined, administrator)
  assert.equal(queue.status, 200)
  assert.equal(queue.data.total, 1)
  assert.equal(queue.data.items[0].id, submitted.data.id)
  assert.equal(queue.data.items[0].title, 'Preview')
  assert.equal(queue.data.items[0].submittedBy, 'reporter')
  assert.equal(queue.data.items[0].contact, 'reply@example.test')
  assert.equal(queue.data.items[0].screenshotCount, 0)

  const updateRoute = `/manage/${submitted.data.id}`
  const update = { status: 'resolved', operatorNote: 'Fixed the preview.', revision: 0 }
  assert.equal((await call('PUT', updateRoute, update, reporter)).status, 403)
  assert.equal((await call('PUT', updateRoute, update, { ...administrator, Origin: 'https://other.example.test' })).status, 403)
  const resolved = await call('PUT', updateRoute, update, administrator)
  assert.equal(resolved.status, 200)
  assert.equal(resolved.data.revision, 1)
  assert.equal((await call('PUT', updateRoute, update, administrator)).data.revision, 1, 'same network retry is idempotent')
  assert.equal((await call('PUT', updateRoute, { ...update, operatorNote: 'Stale review.' }, administrator)).status, 409)
  assert.equal((await call('GET', '/manage?status=open', undefined, administrator)).data.total, 0)

  setEnv('FEEDBACK_ADMIN_USER', 'owner')
  assert.equal((await call('GET', '/access', undefined, operator)).data.canManage, true)
  assert.equal((await call('POST', '', { title: 'Operator submission', description: 'Denied' }, operator)).status, 403)
  assert.equal((await call('GET', '/access', undefined, administrator)).data.canManage, true)
  assert.equal((await call('GET', '/manage', undefined, administrator)).status, 200)
  const finished = await call('GET', '/manage?status=resolved', undefined, operator)
  assert.equal(finished.data.items[0].operatorNote, 'Fixed the preview.')

  const screenshot = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#234567' } }).png().toBuffer()
  function formWithScreenshot() {
    const form = new FormData()
    form.set('title', 'Screenshot feedback')
    form.set('description', 'An image documents the problem.')
    form.append('screenshots', new Blob([new Uint8Array(screenshot)], { type: 'image/png' }), 'screenshot.png')
    return form
  }
  const invalid = formWithScreenshot()
  invalid.append('screenshots', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'fake.png')
  assert.equal((await call('POST', '', invalid, reporter)).status, 400)
  assert.equal((await call('GET', '/manage?status=open', undefined, administrator)).data.total, 0)
  assert.equal((await call('POST', '', formWithScreenshot())).status, 403)

  const withScreenshot = await call('POST', '', formWithScreenshot(), reporter)
  assert.equal(withScreenshot.status, 201)
  const screenshotId = withScreenshot.data.id
  const screenshotPath = `/${screenshotId}/screenshots/1`
  for (const account of [reporter, administrator, operator]) {
    const image = await call('GET', screenshotPath, undefined, account)
    assert.equal(image.status, 200)
    assert.equal(image.headers['content-type'], 'image/png')
    assert.equal(image.headers['cache-control'], 'no-store')
    assert.deepEqual(image.bytes, screenshot)
  }
  assert.equal((await call('GET', screenshotPath, undefined, anotherMember)).status, 404)
  assert.equal((await call('GET', screenshotPath)).status, 404)
  const picturedQueue = await call('GET', '/manage?status=open', undefined, administrator)
  assert.equal(picturedQueue.data.items[0].id, screenshotId)
  assert.equal(picturedQueue.data.items[0].screenshotCount, 1)
  const picturedUpdate = await call('PUT', `/manage/${screenshotId}`, update, administrator)
  assert.equal(picturedUpdate.status, 200)
  assert.equal(picturedUpdate.data.screenshotCount, 1)

  setEnv('NODE_ENV', 'development')
  assert.equal((await call('GET', '/access')).data.canManage, true)
  assert.equal((await call('GET', '/manage', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
})
