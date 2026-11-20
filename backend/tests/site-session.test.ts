import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

test('the trusted gateway exchanges a login for a revocable browser session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-site-session-'))
  const origin = 'https://drama.example.test'
  const secret = 'synthetic-session-test-proxy-key-'.repeat(3)
  const environment = {
    SQLITE_PATH: join(directory, 'site-session.sqlite3'),
    NODE_ENV: 'production',
    JIMENG_PRIVATE_ORIGIN: origin,
    JIMENG_PRIVATE_PROXY_SECRET: secret,
    FEEDBACK_ADMIN_USER: 'reporter',
    RELEASE_NOTES_ADMIN_USER: 'owner',
  }
  const previous = Object.keys(environment).map(name => [name, process.env[name]] as const)
  Object.assign(process.env, environment)
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true, force: true })
  })

  const { default: route } = await import('../src/routes/site-session.js')
  const { db, schema } = await import('../src/db/index.js')
  const app = new Hono().route('/api/v1/site-session', route)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const gateway = { Host: 'drama.example.test', 'X-Drama-Jimeng-Private-Proxy': secret }
  const sameOrigin = { ...gateway, Origin: origin, 'Sec-Fetch-Site': 'same-origin' }
  const navigation = { ...gateway, 'X-Forwarded-Method': 'GET', 'X-Forwarded-Uri': '/script-to-video?interface=cinematic',
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document' }
  const call = (method: string, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: `/api/v1/site-session${path}`, method, headers }, res => {
        let body = ''
        res.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => resolve({
          status: res.statusCode!, headers: res.headers, body,
        }))
      })
      req.once('error', reject)
      req.end()
    })
  const login = (username: string, headers: Record<string, string> = {}) =>
    call('POST', '/login', { ...sameOrigin, 'X-Drama-Authenticated-User': username, ...headers })
  const cookie = (response: Awaited<ReturnType<typeof login>>) => response.headers['set-cookie']?.[0]?.split(';')[0]

  const next = await call('GET', '/check', navigation)
  assert.equal(next.status, 302)
  assert.equal(next.headers['cache-control'], 'no-store')
  assert.equal(next.headers.location, '/site-login?next=%2Fscript-to-video%3Finterface%3Dcinematic')
  assert.equal((await call('GET', '/check', { ...navigation, 'Sec-Fetch-Site': 'none' })).status, 302)
  for (const patch of [
    { 'X-Forwarded-Uri': '/api/v1/settings' },
    { 'X-Forwarded-Uri': '/%2fexample.test/path' },
    { 'X-Forwarded-Uri': 'https://example.test/path' },
    { 'X-Forwarded-Uri': '/\\example.test/path' },
    { 'X-Forwarded-Uri': '/site-login?next=x' },
    { 'X-Forwarded-Method': 'POST' },
    { 'Sec-Fetch-Dest': 'image' },
    { 'X-Drama-Jimeng-Private-Proxy': 'not-trusted' },
  ]) {
    const denied = await call('GET', '/check', { ...navigation, ...patch })
    assert.equal(denied.status, 401)
    assert.equal(denied.headers.location, undefined)
    assert.equal(denied.headers['www-authenticate'], undefined)
  }
  assert.equal((await call('GET', '/me', sameOrigin)).status, 401)
  assert.equal((await call('POST', '/login', sameOrigin)).status, 401)
  assert.equal((await login('header\r\nspoof'.replace(/\r\n/g, '-$'))).status, 401)
  assert.equal((await login('owner', { Origin: 'https://other.example.test' })).status, 403)
  assert.equal((await login('owner', { 'X-Drama-Jimeng-Private-Proxy': 'fake' })).status, 403)
  assert.equal((await call('POST', '/login', { ...gateway, 'X-Drama-Authenticated-User': 'owner' })).status, 403)

  const ownerLogin = await login('owner')
  assert.equal(ownerLogin.status, 200)
  assert.deepEqual(JSON.parse(ownerLogin.body).data, { username: 'owner', administrator: true })
  const setCookie = ownerLogin.headers['set-cookie']?.[0] ?? ''
  assert.match(setCookie, /^__Host-drama-plus-session=[\w.-]+;/u)
  assert.match(setCookie, /(?:^|; )Max-Age=604800(?:;|$)/iu)
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(setCookie.split('; ').includes(attribute), setCookie)
  }
  assert.doesNotMatch(setCookie, /Domain=/iu)
  const owner = cookie(ownerLogin)!
  const opaqueId = owner.split('=')[1].split('.')[0]
  const stored = db.select().from(schema.siteSessions).all()
  assert.equal(stored.length, 1)
  assert.equal(stored[0].sessionHash, createHash('sha256').update(opaqueId).digest('hex'))
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(opaqueId))
  const allowed = await call('GET', '/check', { ...navigation, Cookie: owner, 'X-Drama-Authenticated-User': 'forged' })
  assert.equal(allowed.status, 204)
  assert.equal(allowed.headers['x-drama-authenticated-user'], 'owner')
  assert.equal((await call('GET', '/check', { ...navigation, Cookie: owner.replace(/.$/u, last => last === 'a' ? 'b' : 'a') })).status, 302)
  assert.equal((await call('POST', '/logout', { ...sameOrigin, Cookie: owner, Origin: 'https://other.example.test' })).status, 403)
  assert.deepEqual(JSON.parse((await call('GET', '/me', { ...sameOrigin, Cookie: owner })).body).data, { username: 'owner', administrator: true })

  const reporterLogin = await login('reporter', { Cookie: owner })
  assert.equal(reporterLogin.status, 200)
  const reporter = cookie(reporterLogin)!
  assert.notEqual(reporter, owner)
  assert.equal((await call('GET', '/me', { ...sameOrigin, Cookie: owner })).status, 401)
  assert.deepEqual(JSON.parse((await call('GET', '/me', { ...sameOrigin, Cookie: reporter })).body).data, { username: 'reporter', administrator: false })
  const logout = await call('POST', '/logout', { ...sameOrigin, Cookie: reporter })
  assert.equal(logout.status, 204)
  assert.match(logout.headers['set-cookie']?.[0] ?? '', /Max-Age=0/u)
  assert.equal((await call('GET', '/me', { ...sameOrigin, Cookie: reporter })).status, 401)
  assert.equal((await call('GET', '/check', { ...navigation, Cookie: reporter })).status, 302)
  assert.deepEqual(db.select().from(schema.siteSessions).all(), [])

  const expired = cookie(await login('reporter'))!
  db.update(schema.siteSessions).set({ expiresAt: Date.now() - 1 }).run()
  assert.equal((await call('GET', '/me', { ...sameOrigin, Cookie: expired })).status, 401)
  const active = cookie(await login('reporter'))!
  assert.equal(db.select().from(schema.siteSessions).all().length, 1)
  const newSecret = 'rotated-synthetic-proxy-key-'.repeat(3)
  process.env.JIMENG_PRIVATE_PROXY_SECRET = newSecret
  assert.equal((await call('GET', '/me', { ...sameOrigin, Cookie: active, 'X-Drama-Jimeng-Private-Proxy': newSecret })).status, 401)
})
