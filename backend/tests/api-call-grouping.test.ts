import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import Database from 'better-sqlite3'
process.env.SQLITE_PATH = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-grouped-calls-')), 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { recordedFetch, withApiCallContext } = await import('../src/services/api-call-log.js')
const { requestFingerprint, requestParameters } = await import('../src/utils/api-call-request.js')
const { initSqliteSchema } = await import('../src/db/sqlite-schema.js')
const route = (await import('../src/routes/apiCallLogs.js')).default
let submissions = 0, polls = 0
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.setHeader('Content-Type', 'application/json')
  if (req.method === 'POST') { submissions++; res.end('{"prompt_id":"upstream-id"}'); return }
  polls++
  if (polls === 2) { res.statusCode = 503; res.end('{"error":"temporarily unavailable"}'); return }
  res.end(polls === 1 ? '{}' : '{"upstream-id":{"status":{"completed":true}}}')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}/api`
const timestamp = new Date().toISOString()
db.insert(schema.sysTask).values({ id: 42, type: 'video', provider: 'comfyui', model: 'wf-minimax-h3', taskId: 'upstream-id', prompt: '茶壶缓缓冒出蒸汽，固定镜头。', params: '{}', status: 'completed', createdAt: timestamp, updatedAt: timestamp }).run()
const invoke = (url: string, init?: RequestInit, taskId = 42) => withApiCallContext({ provider: 'comfyui', category: 'video', model: 'wf-minimax-h3', taskId }, async () => {
  const response = await recordedFetch(url, init)
  await response.text()
})
async function settled() {
  for (let i = 0; i < 100; i++) {
    const rows = db.select().from(schema.apiCallLogs).all()
    if (rows.length && rows.every(row => row.status !== 'pending')) return rows
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('log capture did not finish')
}
async function get(url: string) { return (await (await route.request(url)).json() as any).data }

test('identical polls merge with latest response and full attempt history, including earlier failures', async () => {
  await invoke(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: { '6': { class_type: 'CLIPTextEncode', inputs: { text: '红色茶壶，柔和日光。' } } }, prompt_id: 'upstream-id' }) })
  for (let i = 0; i < 3; i++) await invoke(`${base}/history/upstream-id`)
  const rows = await settled()
  const list = await get('/?task_id=42&keyword=history')
  assert.equal(list.grouped, true)
  assert.equal(list.total, 1)
  assert.equal(list.totalCalls, 3)
  assert.equal(list.items[0].callCount, 3)
  assert.equal(list.items[0].successCount, 2)
  assert.equal(list.items[0].errorCount, 1)
  assert.equal(list.items[0].statusCode, 200)
  assert.equal(list.items[0].request, undefined)
  const failureFilter = await get('/?task_id=42&keyword=history&status=error')
  assert.equal(failureFilter.total, 1)
  assert.equal(failureFilter.items[0].statusCode, 200)
  const raw = await get('/?task_id=42&keyword=history&grouped=0')
  assert.equal(raw.total, 3)
  assert.equal((await get('/?task_id=42&keyword=history&grouped=0&status=error')).total, 1)
  const firstPoll = rows.find(row => row.url.includes('/history/'))!
  const detail = await get(`/${firstPoll.id}?grouped=1`)
  assert.equal(detail.id, list.items[0].id)
  assert.equal(detail.group.attempts.length, 3)
  assert.equal(detail.request.pathParams.prompt_id, 'upstream-id')
  assert.equal(detail.request.body, null)
  assert.match(detail.requestNote, /路径参数/)
  assert.equal(detail.response.body['upstream-id'].status.completed, true)
  assert.equal(detail.generationRequest.id, rows[0].id)
  assert.match(detail.generationRequest.prompt, /茶壶/)
  const original = await get(`/${detail.generationRequest.id}`)
  assert.equal(original.request.body.prompt['6'].inputs.text, '红色茶壶，柔和日光。')
  assert.deepEqual((await get(`/${firstPoll.id}`)).response.body, {})
  assert.equal(submissions, 1)
  assert.equal(polls, 3)
})

test('task, credentials, URL and body changes remain distinct, while JSON key order is canonical', async () => {
  await invoke(`${base}/history/upstream-id`, undefined, 43)
  await invoke(`${base}/history/another-id`)
  await invoke(`${base}/history/upstream-id`, { headers: { Authorization: 'Bearer credential-one' } })
  await invoke(`${base}/history/upstream-id`, { headers: { Authorization: 'Bearer credential-two' } })
  await settled()
  assert.equal((await get('/?keyword=history')).total, 5)
  const key = { provider: 'comfyui', category: 'video', method: 'POST', url: `${base}/prompt` }
  assert.equal(requestFingerprint({ ...key, body: { a: 1, nested: { b: 2, c: 3 } } }), requestFingerprint({ ...key, body: { nested: { c: 3, b: 2 }, a: 1 } }))
  assert.notEqual(requestFingerprint({ ...key, body: { seed: 1 } }), requestFingerprint({ ...key, body: { seed: 2 } }))
  assert.notEqual(requestFingerprint({ ...key, body: { image: 'data:image/png;base64,AAAA' } }), requestFingerprint({ ...key, body: { image: 'data:image/png;base64,BBBB' } }))
  const query = requestParameters('GET', `${base}/view?filename=img.png&tag=a&tag=b&subfolder=Huobao`)
  assert.equal(query.query.filename, 'img.png')
  assert.deepEqual(query.query.tag, ['a', 'b'])
})

test('legacy records backfill grouping keys without changing bodies and the migration is idempotent', () => {
  const sqlite = new Database(':memory:')
  sqlite.exec('CREATE TABLE api_call_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, category TEXT NOT NULL, model TEXT, task_id INTEGER, drama_id INTEGER, method TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, status_code INTEGER, duration_ms INTEGER, request TEXT, response TEXT, error TEXT, created_at TEXT NOT NULL)')
  const request = '{"headers":{},"body":null}'
  const insert = sqlite.prepare("INSERT INTO api_call_logs (provider,category,task_id,method,url,status,request,response,created_at) VALUES ('comfyui','video',25,'GET',?,'success',?,'{}',?)")
  insert.run(`${base}/history/legacy-id`, request, timestamp)
  insert.run(`${base}/history/legacy-id`, request, timestamp)
  initSqliteSchema(sqlite)
  const rows = sqlite.prepare('SELECT request, request_key FROM api_call_logs').all() as any[]
  assert.equal(rows.length, 2)
  assert.equal(rows[0].request, request)
  assert.ok(rows[0].request_key)
  assert.equal(rows[0].request_key, rows[1].request_key)
  initSqliteSchema(sqlite)
  assert.deepEqual(sqlite.prepare('SELECT request, request_key FROM api_call_logs').all(), rows)
  sqlite.close()
})

after(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
