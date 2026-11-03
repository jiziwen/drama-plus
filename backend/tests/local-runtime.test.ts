import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-runtime-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.HUOBAO_LOCAL_RUNTIME_ENABLED = 'true'
const { db, schema } = await import('../src/db/index.js')
const route = (await import('../src/routes/localRuntime.js')).default
const { waitForLocalComfy, configureLocalRuntime } = await import('../src/services/local-runtime.js')
const ts = new Date().toISOString()
db.insert(schema.aiServiceConfigs).values({ serviceType: 'image', provider: 'comfyui', name: 'test', baseUrl: 'http://host.docker.internal:8188', apiKey: '', createdAt: ts, updatedAt: ts }).run()
const dir = path.join(root, 'local-runtime')
await fs.mkdir(dir)
const status = (value: string, updatedAt = new Date().toISOString()) => fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({ status: value, updatedAt }))
const post = () => route.request('/ensure-comfyui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"command":"must-not-be-executed"}' })
test('fresh idle helper receives only a fixed start action and repeat requests are coalesced', async () => {
  await status('idle')
  assert.equal((await (await post()).json() as any).data.started, true)
  const first = JSON.parse(await fs.readFile(path.join(dir, 'request.json'), 'utf8'))
  assert.equal(first.action, 'start-comfyui')
  assert.equal(first.command, undefined)
  await post()
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'request.json'), 'utf8')).id, first.id)
})
test('ready, stale and disabled runtimes never enqueue another launch', async () => {
  const first = await fs.readFile(path.join(dir, 'request.json'), 'utf8')
  await status('ready'); assert.equal((await (await post()).json() as any).data.status, 'ready')
  await status('idle', '2000-01-01T00:00:00Z'); assert.equal((await (await post()).json() as any).data.available, false)
  await route.request('/', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' })
  assert.equal((await (await post()).json() as any).data.enabled, false)
  assert.equal(await fs.readFile(path.join(dir, 'request.json'), 'utf8'), first)
})

test('generation waits for an already-starting helper and skips remote ComfyUI services', async () => {
  configureLocalRuntime(true)
  await status('starting')
  await waitForLocalComfy('https://remote.example:8188')
  const ready = setTimeout(() => { void status('ready') }, 100)
  try { await waitForLocalComfy('http://127.0.0.1:8188') } finally { clearTimeout(ready) }
  await status('error')
  await assert.rejects(waitForLocalComfy('http://127.0.0.1:8188'), /启动失败/)
})
