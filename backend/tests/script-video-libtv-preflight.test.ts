import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('LibTV 未授权在提交前明确失败，不产生结果待确认或重复计费拦截', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'libtv-preflight-'))
  const cli = path.join(root, 'cli.cjs')
  const originalExec = cp.execFile
  // Windows 不执行 shebang；测试始终使用 Node 启动自有 fixture。
  cp.execFile = ((file: any, args: any, options: any, callback: any) => file === cli
    ? (originalExec as any)(process.execPath, [cli, ...args], options, callback)
    : (originalExec as any)(file, args, options, callback)) as typeof cp.execFile
  syncBuiltinESMExports()
  Object.assign(process.env, {
    SQLITE_PATH: path.join(root, 'test.sqlite3'), HUOBAO_DATA_DIR: root,
    VIDEO_CLI_ACCOUNTS_DIR: path.join(root, 'accounts'),
    MYSQL_AUTO_IMPORT: 'false', LIBTV_PROJECT_ID: '', LIBTV_CLI_BIN: cli,
  })
  await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args.join(' ') !== 'account info') throw new Error('禁止创建或生成任务');
console.error('未登录，请先授权');
process.exitCode = 1;
`, { mode: 0o700 })
  const { db, schema } = await import('../src/db/index.js')
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const stores = new Set<InstanceType<typeof ScriptVideoStore>>()
  const getQueue = Object.getOwnPropertyDescriptor(ScriptVideoStore.prototype, 'queue')!.get!
  t.mock.getter(ScriptVideoStore.prototype, 'queue', function (this: InstanceType<typeof ScriptVideoStore>) {
    stores.add(this)
    return getQueue.call(this)
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const { startScriptVideoGeneration, getScriptVideoGeneration } = await import('../src/services/script-video-generation.js')
  const { createVideoCliAccount } = await import('../src/services/video-cli-accounts.js')
  const account = createVideoCliAccount('libtv', '未授权的测试账号')
  const store = new ScriptVideoStore(path.join(root, 'projects'))
  t.after(async () => {
    cp.execFile = originalExec
    syncBuiltinESMExports()
    await Promise.all([...stores].map(item => item.close()))
    db.$client.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const ts = new Date().toISOString(), model = 'star-video2.5-flash'
  const configId = db.insert(schema.aiServiceConfigs).values({
    provider: 'libtv', model: JSON.stringify([model]), name: '未授权 LibTV', videoCliAccountId: account.id,
    serviceType: 'video', baseUrl: '', apiKey: '', isActive: true, createdAt: ts, updatedAt: ts,
  }).returning().get().id
  const { id } = await store.create('未授权提交回归')
  const episodeId = await store.mutate(id, record => {
    const episode = record.project.episodes[0]
    episode.confirmed = true
    episode.confirmedScript = '窗前日光。'
    episode.cards = [{ id: 'part', title: '新的片段', version: 1, status: 'draft', duration: 5,
      manuallyAdded: true, prompt: '窗前日光落在木桌上。', assetIds: [], shots: [] }]
    return { result: episode.id, documentChanged: true }
  })
  const unused = () => { throw new Error('不应调用其他生成服务') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviewScriptVideoEpisode: unused,
    reviseScriptVideoCard: unused, assertScriptVideoFormal: unused, recoverVideoTask: unused,
    startScriptVideoGeneration: (input, control) => startScriptVideoGeneration({ ...input, allowLibTV: true }, control),
    getScriptVideoGeneration,
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request(`/projects/${id}/episodes/${episodeId}/cards/part/video`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1' },
      body: JSON.stringify({ configId, model, aspectRatio: '16:9', resolution: '480p', expectedCardVersion: 1 }),
    })
    const result = await response.json() as any
    assert.equal(response.status, 400, JSON.stringify(result))
    assert.equal(result.errorCode, 'VALIDATION')
    assert.match(result.message, /请先授权 LibTV 账号/)
    assert.equal(db.select().from(schema.sysTask).all().length, 0)
  }
  const saved = await store.get(id)
  assert.ok(saved.episodes[0].tasks.every((task: any) => task.code === 'VALIDATION'))
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(calls, [['account', 'info'], ['account', 'info']], '不能提交生成或触发付费')
})
