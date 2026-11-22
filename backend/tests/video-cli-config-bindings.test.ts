import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.js'
import { bindLegacyVideoCliConfigs } from '../src/db/video-cli-config-bindings.js'
import { createVideoCliAccount, getActiveVideoCliAccountId, listVideoCliAccounts, setActiveVideoCliAccount } from '../src/services/video-cli-accounts.js'

test('legacy video configurations pair with saved slots, including previously hidden accounts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-video-config-'))
  const previous = process.env.VIDEO_CLI_ACCOUNTS_DIR
  process.env.VIDEO_CLI_ACCOUNTS_DIR = path.join(root, 'accounts')
  const sqlite = new Database(path.join(root, 'legacy.db'))
  t.after(async () => {
    sqlite.close()
    if (previous === undefined) delete process.env.VIDEO_CLI_ACCOUNTS_DIR
    else process.env.VIDEO_CLI_ACCOUNTS_DIR = previous
    await rm(root, { recursive: true, force: true })
  })
  sqlite.exec(`CREATE TABLE ai_service_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, service_type TEXT NOT NULL, provider TEXT, name TEXT NOT NULL,
    base_url TEXT NOT NULL, api_key TEXT NOT NULL, model TEXT, endpoint TEXT, query_endpoint TEXT,
    priority INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1,
    settings TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  const add = sqlite.prepare(`INSERT INTO ai_service_configs(service_type, provider, name, base_url, api_key, model,
    priority, is_default, is_active, created_at, updated_at) VALUES('video', ?, ?, '', '', ?, 7, 1, 0, 'old', 'old')`)
  add.run('jimeng', '原有服务甲', '["jimeng-seedance-2.5"]')
  add.run('jimeng', '原有服务乙', '["jimeng-seedance-2.5-flash"]')
  add.run('libtv', 'LibTV 原有服务', '["star-video2.5"]')
  add.run('libtv', 'LibTV 另一个服务', '["star-video2.5"]')
  const alternate = createVideoCliAccount('jimeng', '备用账号')
  const hidden = createVideoCliAccount('jimeng', '先前在弹窗内添加的账号')
  setActiveVideoCliAccount('jimeng', alternate.id)

  initSqliteSchema(sqlite)
  bindLegacyVideoCliConfigs(sqlite)
  const list = sqlite.prepare(`SELECT id, name, provider, model, video_cli_account_id AS accountId,
    is_default AS isDefault, is_active AS isActive FROM ai_service_configs ORDER BY id`)
  const rows = list.all() as { id: number; name: string; provider: string; model: string; accountId: string; isDefault: number; isActive: number }[]
  assert.deepEqual(rows.map(row => row.accountId), ['default', alternate.id, 'default', listVideoCliAccounts('libtv')[1].id, hidden.id])
  assert.equal(rows[4].name, hidden.name)
  assert.equal(rows[4].model, rows[0].model)
  assert.equal(rows[4].isDefault, 0)
  assert.equal(rows[4].isActive, rows[0].isActive)
  assert.equal(getActiveVideoCliAccountId('jimeng'), alternate.id)
  bindLegacyVideoCliConfigs(sqlite)
  assert.deepEqual(list.all(), rows)
  sqlite.prepare('DELETE FROM ai_service_configs WHERE id = ?').run(rows[4].id)
  bindLegacyVideoCliConfigs(sqlite)
  assert.deepEqual(list.all(), rows.slice(0, 4), 'do not recreate an intentionally deleted config')
})

test('new configuration gets a dedicated account and editing leaves other credentials alone', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-video-config-api-'))
  const previous = { accounts: process.env.VIDEO_CLI_ACCOUNTS_DIR, sqlite: process.env.SQLITE_PATH }
  process.env.VIDEO_CLI_ACCOUNTS_DIR = path.join(root, 'accounts')
  process.env.SQLITE_PATH = ':memory:'
  const [{ default: app }, { getConfigById }] = await Promise.all([
    import('../src/routes/aiConfigs.js'), import('../src/services/ai.js'),
  ])
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous.accounts === undefined) delete process.env.VIDEO_CLI_ACCOUNTS_DIR
    else process.env.VIDEO_CLI_ACCOUNTS_DIR = previous.accounts
    if (previous.sqlite === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previous.sqlite
    await rm(root, { recursive: true, force: true })
  })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  async function call(url: string, method: string, body?: object) {
    return fetch(`http://127.0.0.1:${address.port}${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    })
  }
  const config = { service_type: 'video', provider: 'jimeng', model: ['jimeng-seedance-2.5'] }
  const first = await call('/', 'POST', { ...config, name: '第一个' })
  const second = await call('/', 'POST', { ...config, name: '第二个', temperature: 0.7 })
  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  const a = (await first.json()).data
  const b = (await second.json()).data
  assert.equal(a.video_cli_account_id, 'default')
  assert.notEqual(b.video_cli_account_id, a.video_cli_account_id)
  assert.equal(getActiveVideoCliAccountId('jimeng'), a.video_cli_account_id)
  assert.equal((await getConfigById(b.id))?.videoCliAccountId, b.video_cli_account_id)
  const duplicate = await call('/', 'POST', { ...config, video_cli_account_id: b.video_cli_account_id })
  assert.equal(duplicate.status, 409)
  const update = await call(`/${b.id}`, 'PUT', { name: '编辑第二个' })
  const edited = (await update.json()).data
  assert.equal(edited.video_cli_account_id, b.video_cli_account_id)
  assert.equal(edited.temperature, 0.7)
  assert.equal((await call(`/${b.id}`, 'PUT', { video_cli_account_id: a.video_cli_account_id })).status, 400)
  assert.equal((await call(`/${b.id}`, 'DELETE')).status, 200)
  assert.deepEqual((await (await call('/', 'GET')).json()).data.map((row: { id: number }) => row.id), [a.id])
  assert.ok(listVideoCliAccounts('jimeng').some(account => account.id === b.video_cli_account_id))
})
