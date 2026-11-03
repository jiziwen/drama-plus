import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-api-logs-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { recordedFetch, withApiCallContext, sanitizeCallData } = await import('../src/services/api-call-log.js')
const { db, schema } = await import('../src/db/index.js')
const route = (await import('../src/routes/apiCallLogs.js')).default
const server = http.createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume body */ }
  if (req.url?.startsWith('/stream')) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write('data: {"choices":[{"delta":{"content":"中文提示词"}}]}\n\n')
    res.end('data: [DONE]\n\n'); return
  }
  if (req.url?.startsWith('/fail')) res.statusCode = 400
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Set-Cookie', 'session=private-value')
  res.end(JSON.stringify({ prompt_id: 'upstream-id', url: 'https://files.example/image.png?token=secret-signed-value', b64_json: 'private-base64-value', usage: { total_tokens: 123 } }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
async function completed() {
  for (let i = 0; i < 100; i++) {
    const rows = db.select().from(schema.apiCallLogs).all()
    if (rows.length && rows.every(row => row.status !== 'pending')) return rows
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('call logs did not finish')
}

test('captures full JSON bodies with task context and strips secrets before persistence', async () => {
  const prompt = '角色设定参考图，纯白背景，正面侧面背面。'.repeat(80)
  const resp = await withApiCallContext({ provider: 'comfyui', category: 'image', taskId: 42, model: 'wf-image' }, () => recordedFetch(`${base}/prompt?api_key=url-private`, {
    method: 'POST', headers: { Authorization: 'Bearer private-key', 'x-goog-api-key': 'google-private', 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, seed: 42 }),
  }))
  assert.equal((await resp.json()).prompt_id, 'upstream-id')
  const [row] = await completed()
  assert.equal(row.taskId, 42)
  assert.equal(row.provider, 'comfyui')
  assert.equal(JSON.parse(row.request!).body.prompt, prompt)
  const serialized = JSON.stringify(row)
  for (const secret of ['private-key', 'url-private', 'google-private', 'private-base64-value', 'secret-signed-value', 'session=private-value']) assert.ok(!serialized.includes(secret), secret)
  assert.equal(JSON.parse(row.response!).body.usage.total_tokens, 123)
  const list = await (await route.request('/?provider=comfyui&task_id=42')).json() as any
  assert.equal(list.data.total, 1)
  assert.equal(list.data.items[0].request, undefined)
  const detail = await (await route.request(`/${row.id}`)).json() as any
  assert.equal(detail.data.request.body.prompt, prompt)
})

test('SSE stays consumable and is recorded as structured events; multipart records file metadata', async () => {
  const stream = await recordedFetch(`${base}/stream`)
  const text = await stream.text()
  assert.match(text, /中文提示词/)
  assert.match(text, /\[DONE\]/)
  const form = new FormData()
  form.append('image', new File([Buffer.from('binary-image')], 'reference.png', { type: 'image/png' }))
  await (await recordedFetch(`${base}/upload/image`, { method: 'POST', body: form })).text()
  await completed()
  const rows = db.select().from(schema.apiCallLogs).all()
  const upload = rows.find(row => row.url.endsWith('/upload/image'))!
  assert.equal(JSON.parse(upload.request!).body.fields.image[0].name, 'reference.png')
  assert.ok(!upload.request!.includes('binary-image'))
  const record = rows.find(row => row.url.endsWith('/stream'))!
  assert.equal(JSON.parse(record.response!).body.events[0].choices[0].delta.content, '中文提示词')
})

test('records HTTP and network failures and masks nested credentials without hiding token usage', async () => {
  await (await recordedFetch(`${base}/fail`)).text()
  await assert.rejects(recordedFetch('http://127.0.0.1:1/unreachable'))
  const rows = await completed()
  assert.ok(rows.some(row => row.statusCode === 400 && row.status === 'error'))
  assert.ok(rows.some(row => row.error && row.status === 'error'))
  assert.deepEqual(sanitizeCallData({ nested: { 'X-Api-Key': 'secret', access_token: 'token', max_tokens: 512 } }), { nested: { 'X-Api-Key': '[已隐藏]', access_token: '[已隐藏]', max_tokens: 512 } })
})

test('network failures retain the timeout cause code while redacting sensitive text', async () => {
  const original = globalThis.fetch
  const cause = Object.assign(new Error('headers timeout https://example.test?token=private-cause-token'), { code: 'UND_ERR_HEADERS_TIMEOUT' })
  const failure = new TypeError('fetch failed', { cause })
  globalThis.fetch = async () => { throw failure }
  try {
    await assert.rejects(recordedFetch('https://example.test/timeout'), error => error === failure)
  } finally { globalThis.fetch = original }
  const row = db.select().from(schema.apiCallLogs).all().find(row => row.url.endsWith('/timeout'))!
  const detail = JSON.parse(row.error!)
  assert.equal(detail.message, 'fetch failed')
  assert.equal(detail.cause.code, 'UND_ERR_HEADERS_TIMEOUT')
  assert.ok(!row.error!.includes('private-cause-token'))
})
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
