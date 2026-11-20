import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { holdVideoCliSubmission } from '../src/services/video-cli-tasks.js'

test('LibTV web authorization is local, single-flight, and provisions only after a user starts it', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'drama-libtv-auth-'))
  const binary = path.join(root, 'mock-libtv')
  const canvasId = '01322532-e5de-42a4-9549-5248fb705309'
  const vars = {
    HUOBAO_DATA_DIR: root, SQLITE_PATH: path.join(root, 'libtv-auth.sqlite3'),
    LIBTV_CLI_BIN: binary, LIBTV_CONFIG_DIR: root, LIBTV_PROJECT_ID: '',
    JIMENG_PRIVATE_ORIGIN: 'https://private.example.test',
    JIMENG_PRIVATE_PROXY_SECRET: 'fixture-private-proxy-key-at-least-32-characters',
  }
  const originals = Object.entries(vars).map(([key]) => [key, process.env[key]] as const)
  Object.assign(process.env, vars)
  t.after(async () => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })

  const loggedIn = path.join(root, 'logged-in')
  const invalid = path.join(root, 'invalid')
  const staleBrowserLogin = path.join(root, 'stale-browser-login')
  const nextAccount = path.join(root, 'next-account')
  const logoutFailure = path.join(root, 'logout-failure')
  const commands = path.join(root, 'commands')
  await fs.writeFile(nextAccount, '原 LibTV 账号')
  await fs.writeFile(binary, `#!/usr/bin/env node
const { createServer } = require('node:http')
const { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + '\\n');
if (args[0] === 'account') {
  if (existsSync(${JSON.stringify(loggedIn)})) console.log(JSON.stringify({
    user: {uuid:'private-user-identity-' + readFileSync(${JSON.stringify(loggedIn)}, 'utf8'),
      nickname: readFileSync(${JSON.stringify(loggedIn)}, 'utf8')}, secret: 'must-not-be-returned'
  }))
  else { console.error('接口错误 [401]: 未登录'); process.exitCode = 1 }
} else if (args[0] === 'logout') {
  if (existsSync(${JSON.stringify(logoutFailure)})) {
    console.error('must-not-be-returned'); process.exitCode = 1
  } else {
    rmSync(${JSON.stringify(loggedIn)}, { force: true })
    console.log(JSON.stringify({ok:true,loggedOut:true,credentialsPath:'must-not-be-returned'}))
  }
} else if (args[0] === 'project') {
  if (args[1] === 'list') console.log(JSON.stringify({projectMetaList:[]}))
  else if (args[1] === 'create') setTimeout(() => console.log(JSON.stringify({uuid:${JSON.stringify(canvasId)}})), 150)
  else console.log(JSON.stringify({uuid:${JSON.stringify(canvasId)}, name:'默认视频画布'}))
} else if (args[0] === 'login') {
  if (existsSync(${JSON.stringify(invalid)})) {
    console.error('https://www.liblib.tv/zh?callback_url=http%3A%2F%2Flocalhost%3A23456%2Fcallback');
    console.error('https://www.liblib.tv/zh?callback_url=http%3A%2F%2F127.0.0.1%3A23456%2Fcallback&extra=1');
    console.error('https://www.liblib.tv/zh?callback_url=http%3A%2F%2F127.0.0.1%3A23456%2Fother');
    console.error('https://www.liblib.tv/zh?callback_url=http%3A%2F%2F127.0.0.1%3A80%2Fcallback');
    console.error('must-not-be-returned')
    process.exitCode = 1
  } else {
    const server = createServer((req,res) => {
      if (new URL(req.url, 'http://127.0.0.1').pathname !== '/callback') { res.statusCode = 404; return res.end() }
      res.setHeader('Connection', 'close')
      if (existsSync(${JSON.stringify(staleBrowserLogin)})) {
        console.error('登录失败：token 无效或无法拉取用户信息（getUserInfo） must-not-be-returned')
        res.statusCode = 500
        res.end('保存凭据失败')
        process.exitCode = 1
      } else {
        writeFileSync(${JSON.stringify(loggedIn)}, readFileSync(${JSON.stringify(nextAccount)}))
        res.end('ok')
      }
      server.close()
    })
    server.listen(0, '127.0.0.1', () => {
      const callback = 'http://127.0.0.1:' + server.address().port + '/callback'
      const link = 'https://www.liblib.tv/zh?callback_url=' + encodeURIComponent(callback)
      process.stderr.write(link.slice(0, -4))
      setTimeout(() => process.stderr.write(link.slice(-4) + '\\n'), 20)
    })
    setTimeout(() => server.close(), 5_000).unref()
  }
}`, { mode: 0o700 })

  const [{ default: libtv }, { default: configs }, { db, schema }] = await Promise.all([
    import('../src/routes/libtv.js'), import('../src/routes/aiConfigs.js'), import('../src/db/index.js'),
  ])
  const app = new Hono().route('/ai-configs', configs).route('/', libtv)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const local = { Origin: 'http://localhost:3013', 'Sec-Fetch-Site': 'same-origin' }
  const gateway = { Host: 'private.example.test', Origin: vars.JIMENG_PRIVATE_ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'X-Drama-Jimeng-Private-Proxy': vars.JIMENG_PRIVATE_PROXY_SECRET, 'X-Drama-Authenticated-User': 'site-member' }
  const requests = async () => (await fs.readFile(commands, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
  const send = async (route: string, headers: Record<string, string>, method: string) => {
    const result = await new Promise<IncomingMessage>((resolve, reject) =>
      request(base + route, { headers, method }, resolve).once('error', reject).end())
    const chunks: Buffer[] = []
    for await (const chunk of result) chunks.push(chunk)
    return { status: result.statusCode, headers: result.headers, body: Buffer.concat(chunks).toString() }
  }
  const account = async (route = '/account', headers: Record<string, string> = local, method = 'GET') => {
    const result = await send(route, headers, method)
    assert.equal(result.status, 200)
    assert.equal(result.headers['cache-control'], 'no-store')
    const payload = JSON.parse(result.body) as { data: Record<string, unknown> }
    assert.doesNotMatch(JSON.stringify(payload), /must-not-be-returned|private-user-identity|accountId/)
    return payload.data
  }

  assert.equal((await send('/auth/start', { Origin: 'https://untrusted.example.test' }, 'POST')).status, 403)
  assert.equal((await send('/auth/start', gateway, 'POST')).status, 409)
  assert.equal((await account('/account', gateway)).can_authorize, false)
  await fs.writeFile(loggedIn, 'prior CLI login')
  assert.equal((await account()).authenticated, true)
  assert.equal((await account()).canvas_ready, false)
  assert.ok(!(await requests()).some(args => args[0] === 'project'))
  await fs.unlink(loggedIn)

  const [login, duplicate] = await Promise.all([account('/auth/start', local, 'POST'), account('/auth/start', local, 'POST')])
  assert.deepEqual(login, duplicate)
  assert.equal(login.status, 'pending')
  assert.equal(login.authenticated, false)
  assert.equal(login.can_authorize, true)
  assert.ok(Number(login.expires_at) > Date.now())
  assert.equal((await requests()).filter(args => args[0] === 'login').length, 1)
  assert.equal(typeof login.verification_url, 'string')
  assert.equal((await account('/auth/status')).verification_url, undefined)
  assert.equal((await account()).verification_url, login.verification_url)
  assert.equal((await account('/account', gateway)).verification_url, undefined)
  const challenge = new URL(String(login.verification_url))
  assert.equal(challenge.origin, 'https://www.liblib.tv')
  const callback = challenge.searchParams.get('callback_url')
  assert.ok(callback)
  const callbackUrl = new URL(callback)
  assert.equal(callbackUrl.hostname, '127.0.0.1')
  assert.equal(callbackUrl.pathname, '/callback')
  assert.equal(callbackUrl.searchParams.get('expires_at'), String(login.expires_at))
  assert.match(callbackUrl.searchParams.get('state') ?? '', /^[\da-f-]{36}$/u)
  assert.equal((await fetch(callback)).status, 200)
  let authorized = await account('/auth/status')
  let canvasPreparing = authorized.canvas_preparing === true
  for (let i = 0; i < 100 && !authorized.canvas_ready; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    authorized = await account('/auth/status')
    canvasPreparing ||= authorized.canvas_preparing === true
  }
  assert.equal(canvasPreparing, true)
  assert.equal(authorized.authenticated, true)
  assert.equal(authorized.canvas_ready, true, JSON.stringify({ authorized, commands: (await requests()).slice(0, 20) }))
  assert.equal(authorized.canvas_name, '小李短剧 · 剧本转视频')
  assert.equal((await requests()).filter(args => args[0] === 'project' && args[1] === 'create').length, 1)
  assert.equal((await account('/account', gateway)).canvas_ready, true)
  assert.equal((await account('/auth/start', local, 'POST')).status, 'authenticated')
  assert.equal((await requests()).filter(args => args[0] === 'login').length, 1)

  const disconnect = '/auth/disconnect'
  const time = new Date().toISOString()
  const [active] = db.insert(schema.sysTask).values({ type: 'video', provider: 'libtv', status: 'processing',
    createdAt: time, updatedAt: time }).returning({ id: schema.sysTask.id }).all()
  assert.equal((await send(disconnect, { Origin: 'https://untrusted.example.test' }, 'POST')).status, 403)
  assert.equal((await send(disconnect, local, 'POST')).status, 409)
  assert.equal((await account()).authenticated, true)
  db.update(schema.sysTask).set({ status: 'completed' }).where(eq(schema.sysTask.id, active.id)).run()
  const releaseSubmission = holdVideoCliSubmission('libtv')
  try {
    assert.equal((await send(disconnect, local, 'POST')).status, 409)
    assert.equal((await account()).authenticated, true)
  } finally {
    releaseSubmission?.()
  }
  const disconnected = await account(disconnect, local, 'POST')
  assert.equal(disconnected.status, 'unauthenticated')
  assert.equal(disconnected.username, undefined)
  assert.equal(disconnected.canvas_name, undefined)
  assert.equal(disconnected.can_authorize, true)

  await fs.writeFile(nextAccount, '新 LibTV 账号')
  const next = await account('/auth/start', local, 'POST')
  const nextCallback = new URL(String(next.verification_url)).searchParams.get('callback_url')
  assert.ok(nextCallback)
  assert.equal((await fetch(nextCallback)).status, 200)
  let switched = await account('/auth/status')
  for (let i = 0; i < 100 && !switched.canvas_ready; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    switched = await account('/auth/status')
  }
  assert.equal(switched.username, '新 LibTV 账号')
  assert.equal(switched.canvas_ready, true)
  const rows = db.insert(schema.aiServiceConfigs).values(['配置一', '配置二'].map(name => ({
    name, serviceType: 'video', provider: 'libtv', baseUrl: '', apiKey: '',
    model: '[]', createdAt: time, updatedAt: time,
  }))).returning({ id: schema.aiServiceConfigs.id }).all()
  assert.equal((await send(`/ai-configs/${rows[0].id}`, local, 'DELETE')).status, 200)
  assert.equal((await account()).username, '新 LibTV 账号')
  await fs.writeFile(logoutFailure, 'yes')
  const rejectedDelete = await send(`/ai-configs/${rows[1].id}`, local, 'DELETE')
  assert.equal(rejectedDelete.status, 502)
  assert.doesNotMatch(rejectedDelete.body, /must-not-be-returned/)
  assert.ok(db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, rows[1].id)).get())
  await fs.unlink(logoutFailure)
  assert.equal((await send(`/ai-configs/${rows[1].id}`, local, 'DELETE')).status, 200)
  assert.equal(db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, rows[1].id)).get(), undefined)
  assert.equal((await account()).authenticated, false)

  const canceled = await account('/auth/start', local, 'POST')
  const canceledCallback = new URL(String(canceled.verification_url)).searchParams.get('callback_url')
  assert.ok(canceledCallback)
  assert.equal((await account(disconnect, local, 'POST')).status, 'unauthenticated')
  await assert.rejects(fetch(canceledCallback))
  await fs.writeFile(staleBrowserLogin, 'yes')
  const stale = await account('/auth/start', local, 'POST')
  const staleCallback = new URL(String(stale.verification_url)).searchParams.get('callback_url')
  assert.ok(staleCallback)
  assert.notEqual(new URL(staleCallback).searchParams.get('state'), callbackUrl.searchParams.get('state'))
  assert.equal((await fetch(staleCallback)).status, 500)
  let failed = await account('/auth/status')
  for (let i = 0; i < 100 && failed.status === 'pending'; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    failed = await account('/auth/status')
  }
  assert.equal(failed.status, 'failed')
  assert.match(String(failed.message), /在 LibTV 官网退出并重新登录/u)

  await fs.writeFile(invalid, 'yes')
  const rejected = await account('/auth/start', local, 'POST')
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.verification_url, undefined)
})
