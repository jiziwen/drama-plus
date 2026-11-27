import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createVideoCliAccount, getActiveVideoCliAccountId, listVideoCliAccounts, removeVideoCliAccount, renameVideoCliAccount, resolveVideoCliAccountId, setActiveVideoCliAccount, videoCliAccountDirectory } from '../src/services/video-cli-accounts.js'
import { createJimengVideoDraft, getJimengAccount, getJimengVideoModels, inspectJimengVideo, JimengCliError, runJimengVideo, startJimengAuthorization, withJimengAccount } from '../src/services/jimeng-cli.js'
import jimeng from '../src/routes/jimeng.js'

test('saved accounts keep the legacy profile and isolate provider selection and credential directories', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-video-accounts-'))
  const old = process.env.VIDEO_CLI_ACCOUNTS_DIR
  process.env.VIDEO_CLI_ACCOUNTS_DIR = directory
  t.after(async () => { if (old === undefined) delete process.env.VIDEO_CLI_ACCOUNTS_DIR; else process.env.VIDEO_CLI_ACCOUNTS_DIR = old; await rm(directory, { recursive: true, force: true }) })
  assert.equal(getActiveVideoCliAccountId('jimeng'), 'default')
  assert.equal(videoCliAccountDirectory('jimeng', 'default'), undefined)
  const a = createVideoCliAccount('jimeng', '主账号')
  const b = createVideoCliAccount('jimeng', '备用账号')
  setActiveVideoCliAccount('jimeng', a.id)
  assert.equal(getActiveVideoCliAccountId('jimeng'), a.id)
  assert.equal(getActiveVideoCliAccountId('libtv'), 'default')
  assert.notEqual(videoCliAccountDirectory('jimeng', a.id), videoCliAccountDirectory('jimeng', b.id))
  assert.throws(() => resolveVideoCliAccountId('jimeng', '../escape'), /不存在/)
  assert.throws(() => resolveVideoCliAccountId('libtv', a.id), /不存在/)
  removeVideoCliAccount('jimeng', a.id)
  assert.equal(getActiveVideoCliAccountId('jimeng'), 'default')
  assert.deepEqual(listVideoCliAccounts('jimeng').map(account => account.name), ['默认账号', '备用账号'])
})

test('Jimeng concurrent account calls and pending web authorizations use the selected credential scope', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-jimeng-scopes-'))
  const previous = { VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR, JIMENG_CLI_BIN: process.env.JIMENG_CLI_BIN }
  process.env.VIDEO_CLI_ACCOUNTS_DIR = directory
  process.env.JIMENG_CLI_BIN = process.execPath
  const calls: { profile: string; dir: string | undefined; command: string }[] = []
  const waiting = new Map<string, (error: Error | null, stdout: string, stderr: string) => void>()
  const loggedIn = new Set<string>()
  let failure: Record<string, unknown> | undefined
  t.mock.method(childProcess, 'execFile', (_binary: string, args: string[], options: { env: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const profile = args[2]!
    const command = args.slice(3, 5).join(' ')
    calls.push({ profile, dir: options.env.DREAMINA_CANVAS_STATE_DIR, command })
    const child = Object.assign(new EventEmitter(), { stdin: { end() {} }, kill() { queueMicrotask(() => callback(new Error('cancelled'), '', '')); return true } })
    const ok = (data: unknown) => queueMicrotask(() => callback(null, JSON.stringify({ ok: true, data }), ''))
    if (command === 'auth status') ok({ loggedIn: loggedIn.has(profile) })
    else if (command === 'auth account') ok({ userId: profile, displayName: profile })
    else if (command === 'auth login') ok({ status: 'authorization_required', challenge: { deviceCode: profile, verificationUriComplete: 'https://jimeng.jianying.com/authorize?scope=' + profile } })
    else if (command === 'auth wait') waiting.set(profile, callback)
    else if (command === 'model ls') {
      if (failure) queueMicrotask(() => callback(new Error('failed'), '', JSON.stringify({ ok: false, error: failure })))
      else ok({ items: [{ model: 'seedance_2.5', displayName: 'Seedance 2.5' }] })
    } else if (command === 'space current') ok({ userId: profile, kind: 'personal' })
    else if (command === 'node create') ok({ node: { nodeId: 'node-1' } })
    else if (command === 'node show') ok({ nodes: [{ result: 'FOUND', node: { nodeId: 'node-1', type: 'video', generation: { model: 'seedance_2.5', mode: 't2v', prompt: '一束阳光照在桌上。', durationSeconds: 4, ratio: '16:9', resolution: '720P', outputCount: 1, references: [] } } }] })
    else if (command === 'node quote') ok({ consumptionSubject: { userId: profile, kind: 'personal' }, items: [{ nodeId: 'node-1', maxCredits: 10 }], totalMaxCredits: 10, draftVersion: 1 })
    else if (command === 'node confirm') ok({ consumptionSubject: { userId: profile, kind: 'personal' }, creditCeiling: 10, creditConfirmationToken: 'fixture-only' })
    else if (command === 'node run') ok({ items: [{ nodeId: 'node-1', submitId: args.find(arg => arg.startsWith('--submit-id='))!.slice('--submit-id='.length), state: 'ACCEPTED' }] })
    else if (command === 'operation status') ok({ state: 'failed', submissionError: { code: 4107, message: '当前账号积分不足', reason: 'insufficient_credits' } })
    else ok({})
    return child
  })
  syncBuiltinESMExports()
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; await rm(directory, { recursive: true, force: true }) })
  const a = createVideoCliAccount('jimeng')
  const b = createVideoCliAccount('jimeng')
  const [authA, authB] = await Promise.all([withJimengAccount(a.id, () => startJimengAuthorization()), withJimengAccount(b.id, () => startJimengAuthorization())])
  assert.notEqual(authA.verificationUrl, authB.verificationUrl)
  assert.equal(waiting.size, 2)
  const profileA = calls.find(call => call.dir === videoCliAccountDirectory('jimeng', a.id))!.profile
  const profileB = calls.find(call => call.dir === videoCliAccountDirectory('jimeng', b.id))!.profile
  assert.notEqual(profileA, profileB)
  setActiveVideoCliAccount('jimeng', b.id)
  loggedIn.add(profileA)
  waiting.get(profileA)!(null, JSON.stringify({ ok: true, data: { status: 'logged_in' } }), '')
  waiting.get(profileB)!(new Error('failed'), '', JSON.stringify({ ok: false, error: { code: 4101, message: '网页授权已过期', reason: 'authorization_expired' } }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await withJimengAccount(a.id, () => getJimengAccount())).authenticated, true)
  assert.equal(listVideoCliAccounts('jimeng').find(account => account.id === a.id)!.name, profileA)
  assert.equal(listVideoCliAccounts('jimeng').find(account => account.id === b.id)!.name, b.name, 'another account must not be renamed by account A login')
  renameVideoCliAccount('jimeng', a.id, '我的备注')
  await withJimengAccount(a.id, () => getJimengAccount())
  assert.equal(listVideoCliAccounts('jimeng').find(account => account.id === a.id)!.name, '我的备注')
  assert.match((await withJimengAccount(b.id, () => getJimengAccount())).message!, /网页授权已过期/)
  const draft = await withJimengAccount(a.id, () => createJimengVideoDraft({ projectId: 'canvas', model: 'jimeng-seedance-2.5', mode: 't2v', prompt: '一束阳光照在桌上。', duration: 4, aspectRatio: '16:9', resolution: '720p' }, profileA))
  assert.equal(draft.profileId, a.id)
  const beforeRun = calls.length
  await runJimengVideo(draft)
  assert.ok(calls.length > beforeRun)
  assert.ok(calls.slice(beforeRun).every(call => call.profile === profileA), 'draft verification, quote, approval and submission must all use saved account A')
  const operation = await inspectJimengVideo('canvas', 'submission', a.id)
  assert.equal(calls.at(-1)!.profile, profileA, 'polling an existing task must not use newly activated account B')
  assert.match(operation.message!, /当前账号积分不足/)
  await inspectJimengVideo('canvas', 'submission')
  assert.equal(calls.at(-1)!.profile, '--profile=drama-plus', 'legacy task keeps its original profile')
  failure = { code: 40018, message: '账号积分为 0，无法支付本次生成', reason: 'insufficient_credits' }
  await assert.rejects(withJimengAccount(a.id, () => getJimengVideoModels()), error => error instanceof JimengCliError && /账号积分为 0/.test(error.message))
})

test('Jimeng account routes save, rename, activate, reject invalid accounts and preserve private access', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-jimeng-account-api-'))
  const previous = { VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR, SQLITE_PATH: process.env.SQLITE_PATH, MYSQL_AUTO_IMPORT: process.env.MYSQL_AUTO_IMPORT }
  process.env.VIDEO_CLI_ACCOUNTS_DIR = directory
  process.env.SQLITE_PATH = path.join(directory, 'tasks.sqlite3')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  let closeDatabase: (() => void) | undefined
  const app = new Hono().route('/jimeng', jimeng)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); closeDatabase?.(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; await rm(directory, { recursive: true, force: true }) })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/jimeng`
  const call = async (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const initial = await call('/accounts')
  assert.equal(initial.headers.get('cache-control'), 'no-store')
  assert.equal((await initial.json()).data.activeAccountId, 'default')
  const automatic = (await (await call('/accounts', 'POST', {})).json()).data
  assert.match(automatic.id, /^[a-f\d-]{36}$/u)
  const emptyBody = (await (await call('/accounts', 'POST')).json()).data
  assert.match(emptyBody.id, /^[a-f\d-]{36}$/u)
  for (const body of [{}, undefined]) {
    const reply = await call('/accounts', 'POST', body)
    assert.equal(reply.status, 200)
    assert.deepEqual(Object.keys((await reply.json()).data).sort(), ['id', 'name'])
  }
  const added = (await (await call('/accounts', 'POST', { name: '第二账号' })).json()).data
  assert.match(added.id, /^[a-f\d-]{36}$/u)
  assert.equal((await call(`/accounts/${added.id}`, 'PATCH', { name: '工作号', active: true })).status, 200)
  const saved = (await (await call('/accounts')).json()).data
  assert.equal(saved.activeAccountId, added.id)
  assert.equal(saved.accounts.find((entry: { id: string }) => entry.id === added.id).name, '工作号')
  const { db, schema: { sysTask } } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const date = new Date().toISOString()
  db.insert(sysTask).values({ type: 'video', provider: 'jimeng', status: 'failed', taskId: 'original-submission', errorCode: 'submission_unknown', params: JSON.stringify({ jimeng: { profileId: added.id } }), createdAt: date, updatedAt: date }).run()
  const refusedRemoval = await call(`/accounts/${added.id}`, 'DELETE')
  assert.equal(refusedRemoval.status, 409)
  assert.match((await refusedRemoval.json()).message, /恢复|原任务/)
  assert.ok(listVideoCliAccounts('jimeng').some(account => account.id === added.id))
  assert.equal((await call('/accounts', 'POST', { name: '' })).status, 400)
  assert.equal((await call('/account?account_id=missing')).status, 404)
  const denied = await fetch(base + '/accounts', { headers: { Origin: 'https://untrusted.example.test', 'Sec-Fetch-Site': 'cross-site' } })
  assert.equal(denied.status, 403)
})
