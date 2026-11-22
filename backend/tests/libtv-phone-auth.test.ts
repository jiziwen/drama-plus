import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { requestLogger } from '../src/middleware/logger.js'

test('a site member can authorize LibTV without sharing the SMS challenge across browsers', async t => {
  let closeDatabase: (() => void) | undefined
  const dir = await mkdtemp(join(tmpdir(), 'drama-libtv-phone-'))
  const binary = join(dir, 'mock-libtv')
  const origin = 'https://private.example.test'
  const marker = 'synthetic-private-marker-'.repeat(3)
  const commands = join(dir, 'commands')
  const captcha = join(dir, 'captcha')
  const loggedIn = join(dir, 'logged-in')
  const canvasId = '101f417e-6ea6-4cab-a78e-969224390598'
  const vars = {
    NODE_ENV: 'production', HUOBAO_DESKTOP: '', HUOBAO_DATA_DIR: dir, LIBTV_CONFIG_DIR: dir,
    SQLITE_PATH: join(dir, 'libtv-phone.sqlite3'), RELEASE_NOTES_ADMIN_USER: 'owner',
    LIBTV_CLI_BIN: binary, LIBTV_PROJECT_ID: '', FEEDBACK_ADMIN_USER: 'owner',
    JIMENG_PRIVATE_ORIGIN: origin, JIMENG_PRIVATE_PROXY_SECRET: marker,
  }
  const originals = Object.keys(vars).map(key => [key, process.env[key]] as const)
  Object.assign(process.env, vars)
  t.after(async () => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    closeDatabase?.()
    await rm(dir, { recursive: true, force: true })
  })

  const log = t.mock.method(console, 'log', () => {})
  let time = Date.now()
  t.mock.method(Date, 'now', () => time)
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs')
const [command, mode, ...args] = process.argv.slice(2)
const record = value => fs.appendFileSync(${JSON.stringify(commands)}, value + '\\n')
if (command === 'login' && mode === 'phone') {
  const verify = args[2] === '-c'
  record(verify ? 'phone-verify' : 'phone-send')
  if (!verify && fs.existsSync(${JSON.stringify(captcha)})) {
    console.error('需要人机验证 synthetic-private-provider-output'); process.exitCode = 1
  } else if (verify && args[3] !== '092003') {
    console.error('验证码错误 synthetic-private-provider-output'); process.exitCode = 1
  } else if (verify) {
    fs.writeFileSync(${JSON.stringify(loggedIn)}, 'yes')
    console.log('登录成功，凭据已保存 synthetic-private-provider-output')
  } else {
    setTimeout(() => console.log('验证码已发送'), 70)
  }
} else if (command === 'account') {
  if (fs.existsSync(${JSON.stringify(loggedIn)})) console.log(JSON.stringify({user:{uuid:'sensitive-account',nickname:'示例账号'},session:'synthetic-private-provider-output'}))
  else { console.error('接口错误 [401]: 未登录'); process.exitCode = 1 }
} else if (command === 'project') {
  record('project-' + mode)
  if (mode === 'list') console.log(JSON.stringify({projectMetaList:[]}))
  else console.log(JSON.stringify({uuid:${JSON.stringify(canvasId)},name:'示例画布'}))
} else {
  record('unexpected-login')
  process.exitCode = 1
}`, { mode: 0o700 })

  const [{ default: libtv }, { default: siteSession }] = await Promise.all([
    import('../src/routes/libtv.js'), import('../src/routes/site-session.js'),
  ])
  const { db } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const app = new Hono()
  app.use('*', requestLogger)
  app.route('/api/v1/libtv', libtv)
  app.route('/api/v1/site-session', siteSession)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  await once(server, 'listening')
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  const gatewayHeaders = { Host: 'private.example.test', Origin: origin, 'Sec-Fetch-Site': 'same-origin',
    'X-Drama-Jimeng-Private-Proxy': marker }
  const call = (route: string, headers: Record<string, string>, body?: unknown, service = 'libtv') =>
    new Promise<{ status: number; noStore: string | undefined; cookie?: string; result: Record<string, any> }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: `/api/v1/${service}${route}`,
        method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      }, res => {
        let content = ''
        res.setEncoding('utf8').on('data', part => { content += part }).on('end', () =>
          resolve({ status: res.statusCode!, noStore: res.headers['cache-control'],
            cookie: res.headers['set-cookie']?.[0]?.split(';')[0], result: JSON.parse(content || '{}') }))
      })
      req.once('error', reject)
      req.end(body === undefined ? undefined : JSON.stringify(body))
    })
  async function loggedInBrowser(username: string) {
    const headers = { ...gatewayHeaders, 'X-Drama-Authenticated-User': username }
    const login = await call('/login', headers, {}, 'site-session')
    assert.equal(login.status, 200)
    assert.equal(login.result.data.administrator, username === 'owner')
    assert.ok(login.cookie)
    return { ...headers, Cookie: login.cookie }
  }
  const gateway = await loggedInBrowser('reporter')
  const secondBrowser = await loggedInBrowser('reporter')
  const secondMember = await loggedInBrowser('owner')
  const send = '/auth/phone/send'
  const verify = '/auth/phone/verify'
  const input = { phone: '13800138000' }
  const testProof = { challenge_id: 'f6c7bd8c-3f75-423a-8485-6cdbf630568b', code: '092003' }
  assert.equal((await call('/account', gateway)).result.data.can_authorize_phone, true)
  assert.equal((await call('/account', secondMember)).result.data.can_authorize_phone, true)
  assert.equal((await call('/account', gatewayHeaders)).status, 403)
  assert.equal((await call('/account', gateway)).result.data.can_authorize, true, 'hosted members may also use the official website login')
  for (const headers of [gatewayHeaders, {}, { ...gateway, Origin: 'https://other.example.test' },
    { ...gateway, 'X-Drama-Authenticated-User': 'different-username' },
    { ...gateway, Cookie: '__Host-drama-plus-session=invalid' },
    { ...gateway, 'X-Drama-Jimeng-Private-Proxy': 'invalid' }]) {
    assert.equal((await call(send, headers, input)).status, 403)
    assert.equal((await call(verify, headers, testProof)).status, 403)
  }
  assert.equal((await call(send, { ...gateway, 'Content-Type': 'text/plain' }, input)).status, 400)
  assert.equal((await call(send, gateway, { ...input, additional: 'no' })).status, 400)
  assert.equal((await call(send, gateway, { ...input, additional: 'x'.repeat(600) })).status, 413)

  await writeFile(captcha, 'yes')
  const challenged = await call(send, gateway, input)
  assert.equal(challenged.status, 409)
  assert.match(String(challenged.result.message), /官方页面完成人机验证/u)
  assert.doesNotMatch(JSON.stringify(challenged.result), /synthetic-private-provider-output/u)
  assert.equal((await call(send, gateway, input)).status, 429)
  await rm(captcha)
  time += 60_001

  const parallel = await Promise.all([call(send, gateway, input), call(send, gateway, input)])
  assert.deepEqual(parallel.map(item => item.status).sort(), [200, 409])
  const sent = parallel.find(item => item.status === 200)!
  assert.equal(sent.noStore, 'no-store')
  const first = sent.result.data
  assert.deepEqual(Object.keys(first).sort(), ['challenge_id', 'expires_at'])
  assert.equal(typeof first.challenge_id, 'string')
  assert.equal(first.expires_at, time + 5 * 60_000)

  assert.equal((await call(verify, secondMember, { ...testProof, challenge_id: first.challenge_id })).status, 410)
  assert.equal((await call(verify, secondBrowser, { ...testProof, challenge_id: first.challenge_id })).status, 410)
  time += 60_001
  assert.equal((await call(send, secondBrowser, input)).status, 409)
  for (let i = 0; i < 5; i++) {
    const rejected = await call(verify, gateway, { challenge_id: first.challenge_id, code: '123456' })
    assert.equal(rejected.status, 400)
    assert.doesNotMatch(JSON.stringify(rejected.result), /synthetic-private-provider-output/u)
  }
  assert.equal((await call(verify, gateway, { ...testProof, challenge_id: first.challenge_id })).status, 410)

  time += 60_001
  const expired = (await call(send, gateway, input)).result.data
  time = expired.expires_at + 1
  assert.equal((await call(verify, gateway, { ...testProof, challenge_id: expired.challenge_id })).status, 410)

  const sentAgain = (await call(send, gateway, input)).result.data
  const pending = await call(verify, gateway, { ...testProof, challenge_id: sentAgain.challenge_id })
  assert.equal(pending.status, 200)
  assert.equal(pending.result.data.canvas_preparing, true)
  assert.equal(pending.result.data.verification_url, undefined)
  assert.equal(typeof pending.result.data.expires_at, 'number')
  assert.doesNotMatch(JSON.stringify(pending.result), /sensitive-account|synthetic-private-provider-output/u)
  assert.equal((await call(verify, gateway, { ...testProof, challenge_id: sentAgain.challenge_id })).status, 410)
  let account = (await call('/account', gateway)).result.data
  for (let i = 0; i < 70 && !account.canvas_ready; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
    account = (await call('/account', gateway)).result.data
  }
  assert.equal(account.authenticated, true)
  assert.equal(account.canvas_ready, true, JSON.stringify(account))
  assert.equal(account.can_authorize_phone, false)
  assert.equal((await call('/auth/start', gatewayHeaders, {})).status, 403)
  assert.equal((await call('/auth/start', secondMember, {})).result.data.canvas_ready, true)
  assert.equal((await call('/auth/start', gateway, {})).result.data.canvas_ready, true)
  const invoked = (await readFile(commands, 'utf8')).trim().split('\n')
  assert.equal(invoked.filter(line => line === 'phone-send').length, 4)
  assert.equal(invoked.filter(line => line === 'phone-verify').length, 6)
  assert.equal(invoked.includes('unexpected-login'), false)
  assert.doesNotMatch(log.mock.calls.map(call => call.arguments.join(' ')).join('\n'), /13800138000|092003|123456|challenge_id/u)
})
