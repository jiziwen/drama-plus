import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

test('未授权账号在官方 CLI 未安装时也能从应用移除，并保留其他账号和任务保护', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-empty-account-removal-'))
  const environment = {
    HUOBAO_DATA_DIR: directory, SQLITE_PATH: path.join(directory, 'tasks.sqlite3'), MYSQL_AUTO_IMPORT: 'false',
    VIDEO_CLI_ACCOUNTS_DIR: path.join(directory, 'profiles'),
    JIMENG_CLI_BIN: path.join(directory, 'missing-jimeng.exe'), LIBTV_CLI_BIN: path.join(directory, 'missing-libtv.exe'),
    LIBTV_CONFIG_DIR: path.join(directory, 'legacy-libtv'), DREAMINA_CANVAS_STATE_DIR: path.join(directory, 'legacy-jimeng'),
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  const [{ default: jimeng }, { default: libtv }, { db, schema: { sysTask } }, accounts] = await Promise.all([
    import('../src/routes/jimeng.js'), import('../src/routes/libtv.js'), import('../src/db/index.js'),
    import('../src/services/video-cli-accounts.js'),
  ])
  const app = new Hono().route('/jimeng', jimeng).route('/libtv', libtv)
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.$client.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${address.port}`
  for (const provider of ['jimeng', 'libtv'] as const) {
    await t.test(provider, async () => {
      const added = accounts.createVideoCliAccount(provider)
      const other = accounts.createVideoCliAccount(provider)
      accounts.setActiveVideoCliAccount(provider, added.id)
      const result = await fetch(`${base}/${provider}/accounts/${added.id}`, { method: 'DELETE' })
      const payload = await result.json()
      assert.equal(result.status, 200, payload.message)
      assert.deepEqual(payload.data.accounts, accounts.listVideoCliAccounts(provider), '删除结果直接返回剩余账号，不依赖后续 CLI 状态查询')
      assert.ok(!accounts.listVideoCliAccounts(provider).some(entry => entry.id === added.id))
      assert.ok(accounts.listVideoCliAccounts(provider).some(entry => entry.id === other.id))
      assert.equal(accounts.getActiveVideoCliAccountId(provider), 'default')

      const date = new Date().toISOString()
      db.insert(sysTask).values({ type: 'video', provider, status: 'processing',
        params: JSON.stringify({ videoCliAccountId: other.id }), createdAt: date, updatedAt: date }).run()
      const busy = await fetch(`${base}/${provider}/accounts/${other.id}`, { method: 'DELETE' })
      assert.equal(busy.status, 409)
      assert.match((await busy.json()).message, /任务|运行/u)
      assert.ok(accounts.listVideoCliAccounts(provider).some(entry => entry.id === other.id))
      db.delete(sysTask).run()

      const emptyDefault = await fetch(`${base}/${provider}/accounts/default`, { method: 'DELETE' })
      assert.equal(emptyDefault.status, 200, (await emptyDefault.json()).message)
      assert.ok(!accounts.listVideoCliAccounts(provider).some(entry => entry.id === 'default'))
    })
  }

  let mode: 'unauthenticated' | 'authenticated' | 'unavailable' = 'unauthenticated'
  const commands: string[] = []
  let cancelled = 0
  t.mock.method(childProcess, 'execFile', (binary: string, originalArgs: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const provider = binary === environment.JIMENG_CLI_BIN ? 'jimeng' : 'libtv'
    const args = provider === 'jimeng' ? originalArgs.slice(3) : originalArgs
    const command = args.slice(0, 2).join(' ')
    commands.push(`${provider}:${command}`)
    const child = Object.assign(new EventEmitter(), { stdin: { end() {} }, kill() {
      cancelled++
      queueMicrotask(() => callback(new Error('已取消'), '', ''))
      return true
    } })
    const ok = (data: unknown) => queueMicrotask(() => callback(null, JSON.stringify(provider === 'jimeng' ? { ok: true, data } : data), ''))
    const failure = (message: string, reason?: string) => queueMicrotask(() => callback(new Error('fixture'), '',
      JSON.stringify(provider === 'jimeng' ? { ok: false, error: { message, reason } } : { error: { message } })))
    if (mode === 'unavailable') {
      queueMicrotask(() => callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), '', ''))
    } else if (args.includes('logout')) failure('平台暂时无法退出此账号，请稍后重试')
    else if (provider === 'jimeng' && command === 'auth status') ok({ loggedIn: mode === 'authenticated' })
    else if (provider === 'libtv' && command === 'account info') {
      if (mode === 'authenticated') ok({ user: { uuid: 'fixture-user', nickname: '已授权用户' } })
      else queueMicrotask(() => callback(new Error('fixture'), '', '接口错误 [401]: 未登录'))
    } else if (command === 'auth login') ok({ status: 'authorization_required', challenge: {
      deviceCode: 'fixture-device', verificationUriComplete: 'https://jimeng.jianying.com/authorize?fixture=1',
    } })
    else if (command !== 'auth wait') ok({})
    return child
  })
  t.mock.method(childProcess, 'spawn', () => {
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stderr, kill() {
      cancelled++
      queueMicrotask(() => child.emit('close', 1))
      return true
    } })
    queueMicrotask(() => stderr.write('https://www.liblib.tv/zh?callback_url=http%3A%2F%2F127.0.0.1%3A23456%2Fcallback\n'))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  for (const provider of ['jimeng', 'libtv'] as const) {
    await t.test(`${provider} 未登录不必退出，已授权退出失败保留账号`, async () => {
      mode = 'unauthenticated'
      const empty = accounts.createVideoCliAccount(provider)
      commands.length = 0
      const deleted = await fetch(`${base}/${provider}/accounts/${empty.id}`, { method: 'DELETE' })
      assert.equal(deleted.status, 200, (await deleted.json()).message)
      assert.ok(!commands.some(command => command.includes('logout')), '未登录槽不能因无意义的退出命令失败而无法移除')

      mode = 'authenticated'
      const connected = accounts.createVideoCliAccount(provider)
      const failed = await fetch(`${base}/${provider}/accounts/${connected.id}`, { method: 'DELETE' })
      assert.equal(failed.status, 502)
      assert.match((await failed.json()).message, /平台暂时无法退出此账号/u)
      assert.ok(accounts.listVideoCliAccounts(provider).some(entry => entry.id === connected.id))
      mode = 'unavailable'
      const hasCredentials = accounts.createVideoCliAccount(provider)
      const credentialDirectory = accounts.videoCliAccountDirectory(provider, hasCredentials.id)!
      await fs.writeFile(path.join(credentialDirectory, 'fixture-credential'), 'fixture-only')
      const unavailable = await fetch(`${base}/${provider}/accounts/${hasCredentials.id}`, { method: 'DELETE' })
      assert.equal(unavailable.status, 502, '存在本地凭据时不能因 CLI 不可用就跳过退出')
      assert.ok(accounts.listVideoCliAccounts(provider).some(entry => entry.id === hasCredentials.id))
    })
    await t.test(`${provider} 删除等待网页授权的槽会终止等待，且不影响其他账号`, async () => {
      mode = 'unauthenticated'
      const pending = accounts.createVideoCliAccount(provider)
      const before = cancelled
      const started = await fetch(`${base}/${provider}/auth/start?accountId=${pending.id}`, { method: 'POST' })
      const state = (await started.json()).data
      assert.equal(state.status, 'pending')
      const deleted = await fetch(`${base}/${provider}/accounts/${pending.id}`, { method: 'DELETE' })
      assert.equal(deleted.status, 200, (await deleted.json()).message)
      assert.equal(cancelled, before + 1)
      assert.ok(!accounts.listVideoCliAccounts(provider).some(entry => entry.id === pending.id))
    })
  }
})
