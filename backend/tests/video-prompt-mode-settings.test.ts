import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import Database from 'better-sqlite3'
import { Hono } from 'hono'

test('视频提示词排版独立落库，不读取或改写账号设置，并沿用全局设置授权', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'video-prompt-mode-settings-'))
  const filename = path.join(folder, 'settings.sqlite3')
  const environment = {
    SQLITE_PATH: filename, HUOBAO_DATA_DIR: folder, VIDEO_CLI_ACCOUNTS_DIR: path.join(folder, 'accounts'),
    MYSQL_AUTO_IMPORT: 'false', NODE_ENV: 'test', HUOBAO_DESKTOP: '',
    DRAMA_LOCAL_SITE_ACCOUNTS: '', DRAMA_LOCAL_SITE_SESSION_SECRET: '',
    DRAMA_LOCAL_SITE_ADMIN_PASSWORD: '', DRAMA_LOCAL_SITE_MEMBER_PASSWORD: '',
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  delete process.env.DRAMA_LOCAL_SITE_ACCOUNTS
  const { db, schema } = await import('../src/db/index.js')
  const { default: settings } = await import('../src/routes/settings.js')
  const { getVideoPromptMode, setVideoPromptMode } = await import('../src/services/app-settings.js')
  const { getConfigById } = await import('../src/services/ai.js')
  const { requireLocalSiteSession } = await import('../src/routes/site-session.js')
  t.after(async () => {
    db.$client.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(folder, { recursive: true, force: true })
  })
  const app = new Hono().route('/api/v1/settings', settings)
  const endpoint = '/api/v1/settings/video-prompt-mode'
  const put = (value: unknown) => app.request(endpoint, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const saved = () => db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'video_prompt_mode')).get()
  const timestamp = new Date().toISOString()
  db.insert(schema.appSettings).values({ key: 'unrelated_secret', value: 'synthetic-secret-must-stay-private', updatedAt: timestamp }).run()
  const accounts = ['jimeng', 'libtv', 'aicost'].map(provider => db.insert(schema.aiServiceConfigs).values({
    provider, serviceType: 'video', name: provider, baseUrl: '', apiKey: 'synthetic-api-secret',
    model: JSON.stringify([provider === 'jimeng' ? 'jimeng-seedance-2.5' : provider === 'libtv' ? 'star-video2.5' : 'seedance2.5']),
    settings: JSON.stringify({ jimengPromptMode: 'inline', temperature: 0.7 }),
    createdAt: timestamp, updatedAt: timestamp,
  }).returning().get())

  await t.test('空设置固定采用素材说明置前，旧账号值不会成为默认', async () => {
    assert.equal(getVideoPromptMode(), 'reference-guide')
    const response = await app.request(endpoint)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    assert.deepEqual((await response.json()).data, { mode: 'reference-guide' })
    assert.equal(saved(), undefined, '读取默认值不会迁移账号或创建隐式配置')
    assert.equal('jimengPromptMode' in (await getConfigById(accounts[0].id))!, false)
  })

  await t.test('切换共享模式写入独立key，新连接可读且不影响任何账号或其它设置', async () => {
    const response = await put({ mode: 'inline' })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).data, { mode: 'inline' })
    assert.equal(getVideoPromptMode(), 'inline')
    assert.equal(saved()?.value, 'inline')
    const independent = new Database(filename, { readonly: true })
    try {
      assert.equal((independent.prepare("SELECT value FROM app_settings WHERE key='video_prompt_mode'").get() as { value: string }).value, 'inline')
    } finally { independent.close() }
    assert.equal(setVideoPromptMode('reference-guide'), 'reference-guide')
    assert.deepEqual((await (await app.request(endpoint)).json()).data, { mode: 'reference-guide' })
    assert.deepEqual(db.select().from(schema.aiServiceConfigs).all(), accounts)
    const text = await (await app.request(endpoint)).text()
    assert.doesNotMatch(text, /synthetic|apiKey|api_key|unrelated_secret/u)
    assert.equal(db.select().from(schema.appSettings).where(eq(schema.appSettings.key, 'unrelated_secret')).get()?.value,
      'synthetic-secret-must-stay-private')
  })

  await t.test('无效模式或损坏请求不能覆盖设置，数据库坏值回退默认而不修改原值', async () => {
    for (const value of [null, {}, [], { mode: null }, { mode: 1 }, { mode: 'unknown' }, { mode: 'INLINE' }]) {
      assert.equal((await put(value)).status, 400)
      assert.equal(getVideoPromptMode(), 'reference-guide')
      assert.equal(saved()?.value, 'reference-guide')
    }
    assert.equal((await app.request(endpoint, { method: 'PUT', body: '{' })).status, 400)
    db.update(schema.appSettings).set({ value: 'damaged' }).where(eq(schema.appSettings.key, 'video_prompt_mode')).run()
    assert.equal(getVideoPromptMode(), 'reference-guide')
    assert.equal(saved()?.value, 'damaged')
  })

  await t.test('需要站点登录的环境中，新端点同样拒绝匿名读写', async () => {
    process.env.DRAMA_LOCAL_SITE_SESSION_SECRET = 'synthetic-shared-setting-session-secret-'.repeat(2)
    process.env.DRAMA_LOCAL_SITE_ADMIN_PASSWORD = 'synthetic-admin-password'
    process.env.DRAMA_LOCAL_SITE_MEMBER_PASSWORD = 'synthetic-member-password'
    const protectedApp = new Hono()
    protectedApp.use('/api/v1/*', requireLocalSiteSession)
    protectedApp.route('/api/v1/settings', settings)
    for (const method of ['GET', 'PUT']) {
      const response = await protectedApp.request(endpoint, { method,
        ...(method === 'PUT' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'inline' }) }) })
      assert.equal(response.status, 401)
    }
    assert.equal(saved()?.value, 'damaged')
  })
})
