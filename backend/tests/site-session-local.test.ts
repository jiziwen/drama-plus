import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { hash } from 'bcryptjs'
import { Hono } from 'hono'

test('local site sessions preserve feedback permissions for test accounts and Caddy snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-local-site-session-'))
  const origin = 'http://localhost:3013'
  const adminPassword = 'test-admin-password'
  const memberPassword = 'test-member-password'
  const environment: Record<string, string | undefined> = {
    SQLITE_PATH: join(directory, 'site-session.sqlite3'),
    MYSQL_AUTO_IMPORT: 'false',
    NODE_ENV: 'development',
    HUOBAO_DESKTOP: '',
    JIMENG_PRIVATE_ORIGIN: '',
    FEEDBACK_ADMIN_USER: '',
    RELEASE_NOTES_ADMIN_USER: '',
    DRAMA_LOCAL_SITE_ACCOUNTS: undefined,
    DRAMA_LOCAL_SITE_ADMIN_PASSWORD: adminPassword,
    DRAMA_LOCAL_SITE_MEMBER_PASSWORD: memberPassword,
    DRAMA_LOCAL_SITE_SESSION_SECRET: 'synthetic-local-session-secret-'.repeat(2),
  }
  const previous = Object.keys(environment).map(name => [name, process.env[name]] as const)
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  t.after(async () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true, force: true })
  })

  const { default: session, requireLocalSiteSession } = await import('../src/routes/site-session.js')
  const { default: feedback } = await import('../src/routes/feedback.js')
  const { default: releaseNotes } = await import('../src/routes/release-notes.js')
  const app = new Hono()
  app.route('/api/v1/site-session', session)
  app.use('/api/v1/*', requireLocalSiteSession)
  app.route('/api/v1/settings/feedback', feedback)
  app.route('/api/v1/settings/release-notes', releaseNotes)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  t.after(async () => new Promise<void>(resolve => server.close(() => resolve())))
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: `/api/v1${path}`, method, headers: {
        'Sec-Fetch-Site': 'same-origin',
        ...(method !== 'GET' && { Origin: origin }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...headers,
      } }, res => {
        let serialized = ''
        res.setEncoding('utf8').on('data', chunk => { serialized += chunk }).on('end', () => resolve({
          status: res.statusCode!, headers: res.headers, body: serialized,
        }))
      })
      req.once('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    call('POST', '/site-session/login', {
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      ...headers,
    })
  const queue = '/settings/feedback/manage'
  const forgedAdmin = { 'X-Drama-Authenticated-User': 'admin' }

  const signedOut = await call('GET', '/site-session/me')
  assert.equal(signedOut.status, 401)
  assert.equal(signedOut.headers['x-drama-local-site-login'], 'required')
  assert.equal((await call('GET', queue, forgedAdmin)).status, 401)
  assert.equal((await login('admin', 'wrong-password', forgedAdmin)).status, 401)
  assert.equal((await login('admin', adminPassword, { Origin: 'http://localhost:3014' })).status, 403)
  assert.equal((await login('admin', adminPassword, { 'Sec-Fetch-Site': 'same-site' })).status, 403)

  const memberLogin = await login('member', memberPassword)
  assert.equal(memberLogin.status, 200)
  assert.deepEqual(JSON.parse(memberLogin.body).data, { username: 'member', administrator: false })
  const memberSetCookie = memberLogin.headers['set-cookie']?.[0] ?? ''
  assert.match(memberSetCookie, /^__Host-drama-plus-local-session=[\w.-]+;/u)
  for (const attribute of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) {
    assert.ok(memberSetCookie.split('; ').includes(attribute), memberSetCookie)
  }
  assert.doesNotMatch(memberSetCookie, /Domain=/iu)
  const member = { Cookie: memberSetCookie.split(';')[0], ...forgedAdmin }
  const memberAccount = await call('GET', '/site-session/me', member)
  assert.equal(memberAccount.status, 200)
  assert.deepEqual(JSON.parse(memberAccount.body).data, { username: 'member', administrator: false })

  const submitted = await call('POST', '/settings/feedback', member, {
    title: 'Preview problem',
    description: 'Video never appears.',
  })
  assert.equal(submitted.status, 201)
  const { id } = JSON.parse(submitted.body).data
  const update = { status: 'resolved', operatorNote: 'Fixed locally.', revision: 0 }
  assert.equal((await call('GET', queue, member)).status, 403)
  assert.equal((await call('PUT', `${queue}/${id}`, member, update)).status, 403)

  const adminLogin = await login('admin', adminPassword)
  assert.equal(adminLogin.status, 200)
  assert.deepEqual(JSON.parse(adminLogin.body).data, { username: 'admin', administrator: true })
  const admin = { Cookie: adminLogin.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }
  const list = await call('GET', queue, admin)
  assert.equal(list.status, 200)
  const [entry] = JSON.parse(list.body).data.items
  assert.equal(entry.id, id)
  assert.equal(entry.submittedBy, 'member')
  const resolved = await call('PUT', `${queue}/${id}`, admin, update)
  assert.equal(resolved.status, 200)
  assert.equal(JSON.parse(resolved.body).data.status, 'resolved')
  assert.equal(JSON.parse((await call('GET', `${queue}?status=resolved`, admin)).body).data.items[0].id, id)

  const logout = await call('POST', '/site-session/logout', admin)
  assert.equal(logout.status, 204)
  assert.match(logout.headers['set-cookie']?.[0] ?? '', /^__Host-drama-plus-local-session=;/u)
  assert.match(logout.headers['set-cookie']?.[0] ?? '', /Max-Age=0/u)
  assert.equal((await call('GET', '/site-session/me', admin)).status, 401)
  assert.equal((await call('GET', queue, admin)).status, 401)

  process.env.DRAMA_LOCAL_SITE_ACCOUNTS = 'invalid JSON'
  assert.equal((await login('admin', adminPassword)).status, 503)
  assert.equal((await call('GET', queue)).status, 503)

  const snapshot = {
    administrator: 'site-owner',
    feedbackAdministrator: 'feedback.operator',
    hashes: {
      'site-owner': await hash('owner-password', 4),
      'feedback.operator': await hash('operator-password', 4),
      admin: await hash('ordinary-password', 4),
    },
  }
  process.env.DRAMA_LOCAL_SITE_ACCOUNTS = JSON.stringify(snapshot)
  const ownerLogin = await login('site-owner', 'owner-password')
  assert.equal(ownerLogin.status, 200)
  assert.deepEqual(JSON.parse(ownerLogin.body).data, { username: 'site-owner', administrator: true })
  const owner = { Cookie: ownerLogin.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }
  assert.equal((await call('GET', queue, owner)).status, 200)

  const operatorLogin = await login('feedback.operator', 'operator-password')
  assert.equal(operatorLogin.status, 200)
  assert.deepEqual(JSON.parse(operatorLogin.body).data, { username: 'feedback.operator', administrator: false })
  const operator = { Cookie: operatorLogin.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }
  assert.equal((await call('GET', queue, operator)).status, 200)
  const operatorPublishAccess = await call('GET', '/settings/release-notes/access', operator)
  assert.equal(operatorPublishAccess.status, 200)
  assert.deepEqual(JSON.parse(operatorPublishAccess.body).data, { canPublish: false })

  assert.equal((await login('admin', adminPassword)).status, 401)
  const ordinaryLogin = await login('admin', 'ordinary-password')
  assert.equal(ordinaryLogin.status, 200)
  assert.deepEqual(JSON.parse(ordinaryLogin.body).data, { username: 'admin', administrator: false })
  const ordinary = { Cookie: ordinaryLogin.headers['set-cookie']?.[0]?.split(';')[0] ?? '' }
  assert.equal((await call('GET', queue, ordinary)).status, 403)

  snapshot.hashes['site-owner'] = await hash('new-owner-password', 4)
  process.env.DRAMA_LOCAL_SITE_ACCOUNTS = JSON.stringify(snapshot)
  assert.equal((await call('GET', queue, owner)).status, 401)
  assert.equal((await login('site-owner', 'owner-password')).status, 401)
  assert.equal((await login('site-owner', 'new-owner-password')).status, 200)

  process.env.NODE_ENV = 'production'
  assert.equal((await login('admin', adminPassword)).status, 403)
  assert.equal((await call('GET', '/site-session/me')).headers['x-drama-local-site-login'], undefined)
})
