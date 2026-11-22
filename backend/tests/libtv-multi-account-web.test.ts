import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

test('LibTV hosted web login returns to the site and keeps concurrent accounts isolated', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'drama-libtv-multi-'))
  const binary = path.join(dir, 'mock-libtv')
  const original = { ...process.env }
  Object.assign(process.env, {
    HUOBAO_DATA_DIR: dir, SQLITE_PATH: path.join(dir, 'fixture.sqlite3'), VIDEO_CLI_ACCOUNTS_DIR: path.join(dir, 'profiles'),
    LIBTV_CLI_BIN: binary, LIBTV_CONFIG_DIR: path.join(dir, 'legacy'), LIBTV_PROJECT_ID: '',
    JIMENG_PRIVATE_ORIGIN: 'https://private.example.test', JIMENG_PRIVATE_PROXY_SECRET: 'fixture-private-secret-at-least-32-characters',
  })
  await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const dir = process.env.LIBTV_CONFIG_DIR
fs.mkdirSync(dir, {recursive:true})
const credential = path.join(dir, 'identity')
const args = process.argv.slice(2)
if (args[0] === 'account') {
  if (!fs.existsSync(credential)) { console.error('接口错误 [401]: 未登录'); process.exitCode = 1 }
  else { const nickname = fs.readFileSync(credential,'utf8'); console.log(JSON.stringify({user:{uuid:nickname,nickname}})) }
} else if (args[0] === 'login' && args[1] === 'web') {
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://127.0.0.1')
    if (url.pathname !== '/callback') { res.statusCode=404; return res.end() }
    fs.writeFileSync(credential,url.searchParams.get('token'))
    res.setHeader('Connection','close');res.end('ok');server.close()
  })
  server.listen(0,'127.0.0.1', () => console.error('https://www.liblib.tv/zh?callback_url='+encodeURIComponent('http://127.0.0.1:'+server.address().port+'/callback')))
  setTimeout(()=>server.close(),15000).unref()
} else if (args[0] === 'project') {
  console.log(JSON.stringify(args[1]==='list'?{projectMetaList:[]}:{uuid:'01322532-e5de-42a4-9549-5248fb705309',name:'个人画布'}))
} else if (args[0] === 'logout') {
  fs.rmSync(credential,{force:true});console.log(JSON.stringify({loggedOut:true}))
} else { console.error('接口错误 [429]: 账号并发额度已满'); process.exitCode = 1 }
`, { mode: 0o700 })
  const [{ default: libtv, libtvCallbackRoutes }, profiles, service, { db }] = await Promise.all([
    import('../src/routes/libtv.js'), import('../src/services/video-cli-accounts.js'),
    import('../src/services/libtv-cli.js'), import('../src/db/index.js'),
  ])
  const app = new Hono().route('/api/v1/libtv', libtvCallbackRoutes).route('/api/v1/libtv', libtv)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close()
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
    await rm(dir, { recursive: true, force: true })
  })
  const gateway = { Host: 'private.example.test', Origin: 'https://private.example.test', 'Sec-Fetch-Site': 'same-origin',
    'X-Drama-Jimeng-Private-Proxy': process.env.JIMENG_PRIVATE_PROXY_SECRET!, 'X-Drama-Authenticated-User': 'owner' }
  const call = (route: string, method = 'GET', body?: unknown, headers = gateway) => new Promise<{ status: number; payload: any; text: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path: `/api/v1/libtv${route}`, method,
      headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let text = ''
      res.setEncoding('utf8').on('data', part => { text += part }).on('end', () => {
        let payload: any
        try { payload = JSON.parse(text) } catch {}
        resolve({ status: res.statusCode!, payload, text })
      })
    })
    req.once('error', reject).end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
  const firstReply = await call('/accounts', 'POST', {})
  assert.equal(firstReply.status, 200, 'adding an account must not ask for an account name')
  const first = firstReply.payload.data
  const secondReply = await call('/accounts', 'POST')
  assert.equal(secondReply.status, 200, 'an empty account-creation body is supported')
  const second = secondReply.payload.data
  assert.notEqual(first.id, second.id)
  assert.equal((await call('/accounts')).payload.data.activeAccountId, 'default')
  assert.equal((await call(`/accounts/${second.id}`, 'PUT', { name: '备用二号' })).payload.data.name, '备用二号')
  const [a, b] = await Promise.all([call(`/auth/start?accountId=${first.id}`, 'POST', {}), call(`/auth/start?accountId=${second.id}`, 'POST', {})])
  const callback = (data: any) => {
    assert.equal(data.can_authorize, true)
    assert.equal(data.verification_url, undefined)
    assert.equal(data.login_method, 'local_helper')
    const target = new URL(data.assistant_download_url)
    assert.equal(target.origin, 'https://private.example.test')
    assert.equal(target.pathname, '/api/v1/libtv/auth/assistant')
    return target
  }
  const ac = callback(a.payload.data), bc = callback(b.payload.data)
  assert.notEqual(ac.search, bc.search)
  const anotherBrowser = { ...gateway, 'X-Drama-Authenticated-User': 'member' }
  assert.equal((await call(`/account?accountId=${first.id}`, 'GET', undefined, anotherBrowser)).payload.data.verification_url, undefined)
  assert.equal((await call(`/auth/start?accountId=${first.id}`, 'POST', {}, anotherBrowser)).payload.data.status, 'failed')
  const helper = await call(`/auth/assistant${ac.search}`)
  assert.equal(helper.status, 200)
  assert.match(helper.text, /127\.0\.0\.1:/u)
  assert.match(helper.text, /<form method="post"/u)
  assert.equal((await call(`/auth/assistant${ac.search}`, 'GET', undefined, anotherBrowser)).status, 410)
  assert.equal((await call(`/auth/status?accountId=${first.id}`)).payload.data.assistant_download_url, a.payload.data.assistant_download_url)
  const complete = (target: URL, token: string) => call('/auth/callback', 'POST', new URLSearchParams({ state: target.searchParams.get('state')!, token }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' } as typeof gateway)
  assert.equal((await call('/auth/callback', 'POST', { state: 'untrusted', token: 'never-forward' })).status, 400)
  assert.equal((await complete(new URL('https://private.example.test/?state=untrusted'), 'never-forward')).status, 400)
  const completed = await complete(bc, '第二账号')
  assert.equal(completed.status, 200)
  assert.match(completed.text, /history.replaceState/u)
  assert.doesNotMatch(completed.text, /第二账号/u)
  assert.equal((await complete(bc, 'replay')).status, 400)
  assert.equal((await complete(ac, '第一账号')).status, 200)
  async function ready(id: string) {
    let state: any
    for (let i = 0; i < 100; i++) {
      state = (await call(`/account?accountId=${id}`)).payload.data
      if (state.canvas_ready) return state
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(JSON.stringify(state))
  }
  assert.equal((await ready(first.id)).username, '第一账号')
  assert.equal((await ready(second.id)).username, '第二账号')
  const named = (await call('/accounts')).payload.data.accounts
  assert.equal(named.find((account: { id: string }) => account.id === first.id).name, '第一账号')
  assert.equal(named.find((account: { id: string }) => account.id === second.id).name, '备用二号', 'a manually edited label must survive successful login')
  assert.deepEqual(Object.keys(named.find((account: { id: string }) => account.id === first.id)).sort(), ['id', 'name'])
  assert.equal(await readFile(path.join(profiles.videoCliAccountDirectory('libtv', first.id)!, 'identity'), 'utf8'), '第一账号')
  await call(`/accounts/${second.id}/activate`, 'POST', {})
  assert.equal((await call('/account')).payload.data.username, '第二账号')
  await assert.rejects(service.withLibTVAccount(first.id, () => service.runLibTVCli(['fail'])), /账号并发额度已满/u)
  assert.equal((await call(`/accounts/${first.id}`, 'DELETE')).status, 200)
  assert.equal((await call('/account')).payload.data.username, '第二账号')
  assert.equal((await call(`/account?accountId=${first.id}`)).status, 404)
  const third = (await call('/accounts', 'POST', { name: '待授权账号' })).payload.data
  const [pendingReply, concurrentBrowser] = await Promise.all([call(`/auth/start?accountId=${third.id}`, 'POST', {}), call(`/auth/start?accountId=${third.id}`, 'POST', {}, anotherBrowser)])
  const pending = pendingReply.payload.data
  assert.equal(concurrentBrowser.payload.data.status, 'failed')
  assert.equal(concurrentBrowser.payload.data.assistant_download_url, undefined)
  const pendingDownload = callback(pending)
  const realNow = Date.now()
  const clock = t.mock.method(Date, 'now', () => realNow + 6 * 60_000)
  assert.equal((await call(`/auth/assistant${pendingDownload.search}`)).status, 410)
  assert.equal((await complete(pendingDownload, 'expired-token')).status, 400)
  clock.mock.restore()
  assert.equal((await call(`/auth/disconnect?accountId=${third.id}`, 'POST', {})).status, 200)
  assert.equal((await complete(pendingDownload, 'cancelled-token')).status, 400)

})
