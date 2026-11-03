import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-asset-media-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'
const { db, schema, initDb } = await import('../src/db/index.js')
const { default: characters } = await import('../src/routes/characters.js')
const { default: scenes } = await import('../src/routes/scenes.js')
const { default: props } = await import('../src/routes/props.js')
const { default: storyboards } = await import('../src/routes/storyboards.js')
const { default: tasks } = await import('../src/routes/tasks.js')
const { resolveMediaConfig, resolveAssetImageRequest } = await import('../src/services/media-selection.js')
const { GeminiImageAdapter } = await import('../src/services/adapters/gemini-image.js')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64')
const ref = `data:image/png;base64,${png.toString('base64')}`
const requests: { url: string; body: string }[] = []
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  requests.push({ url: req.url!, body: Buffer.concat(chunks).toString() })
  if (req.url === '/missing.png') { res.statusCode = 404; res.end('missing'); return }
  if (req.url?.includes('video_generation')) { res.statusCode = 400; res.end('controlled upstream failure'); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const ts = new Date().toISOString()
const config = (serviceType: string, model: string[], provider = 'openai', isActive = true) => db.insert(schema.aiServiceConfigs).values({ serviceType, provider, name: model[0], baseUrl: base, apiKey: 'local-test-only', model: JSON.stringify(model), isActive, createdAt: ts, updatedAt: ts }).returning().get()
const textImage = config('image', ['gpt-image-2'])
const editImage = config('image', ['gpt-image-2-edit'])
const disabled = config('image', ['gpt-image-disabled'], 'openai', false)
const video = config('video', ['MiniMax-H3'], 'minimax')
const otherVideo = config('video', ['MiniMax-H3-other'], 'minimax')
db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'test', imageConfigId: textImage.id, videoConfigId: otherVideo.id, createdAt: ts, updatedAt: ts }).run()
async function request(route: any, url: string, body: object, method = 'POST') {
  const response = await route.request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() as any }
}
async function finished(id: number) {
  for (let n = 0; n < 100; n++) {
    const task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
    if (task.status !== 'processing') return task
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('task timed out')
}

test('explicit selections validate active service type and declared model without provider fallback', async () => {
  await assert.rejects(resolveMediaConfig('image', { configId: disabled.id }), /停用/)
  await assert.rejects(resolveMediaConfig('image', { configId: video.id }), /不是图片/)
  await assert.rejects(resolveMediaConfig('image', { configId: textImage.id, model: 'missing' }), /不在该服务/)
  await assert.rejects(resolveMediaConfig('image', { configId: 99999 }), /删除/)
})

for (const kind of ['character', 'scene', 'prop'] as const) {
  test(`${kind}: independent text/reference models, sparse saves, explicit references and completed writeback`, async () => {
    const route = kind === 'character' ? characters : kind === 'scene' ? scenes : props
    const table = kind === 'character' ? schema.characters : kind === 'scene' ? schema.scenes : schema.props
    const asset = db.insert(table as any).values({ dramaId: 1, name: 'test', location: 'room', time: 'day', prompt: 'room', appearance: 'face', styling: 'suit', finalPrompt: '保留原始三视图提示词', createdAt: ts, updatedAt: ts }).returning().get() as any
    const saved = await request(route, `/${asset.id}`, { image_model: 'gpt-image-2', image_config_id: textImage.id, reference_model: 'gpt-image-2-edit', reference_config_id: editImage.id, reference_images: [ref], edit_prompt: 'make the coat blue' }, 'PUT')
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    const same = db.select().from(table).where(eq(table.id, asset.id)).get()!
    assert.equal(same.finalPrompt, '保留原始三视图提示词')
    assert.equal(same.imageUrl, null)
    initDb() // additive migration is safe to replay with existing saved data
    const text = await request(route, `/${asset.id}/generate-image`, { episode_id: 1, generation_mode: 'text', model: 'gpt-image-2-edit', config_id: editImage.id, reference_images: [ref], edit_prompt: 'must not enter text generation' })
    assert.equal(text.status, 200, JSON.stringify(text.body))
    const textTask = await finished(text.body.data.image_generation_id)
    assert.equal(textTask.status, 'completed', textTask.errorMsg || '')
    assert.equal(textTask.configId, textImage.id)
    assert.equal(textTask.prompt, '保留原始三视图提示词')
    assert.deepEqual(JSON.parse(textTask.params!).referenceImages, [])
    const missing = await request(route, `/${asset.id}/generate-image`, { episode_id: 1, generation_mode: 'reference', edit_prompt: 'test' })
    assert.equal(missing.status, 400) // current image and saved references cannot be selected implicitly
    const edited = await request(route, `/${asset.id}/generate-image`, { episode_id: 1, generation_mode: 'reference', reference_images: [ref], edit_prompt: 'make the coat blue', model: 'gpt-image-2', config_id: textImage.id })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    const editTask = await finished(edited.body.data.image_generation_id)
    assert.equal(editTask.status, 'completed', editTask.errorMsg || '')
    assert.equal(editTask.configId, editImage.id)
    assert.equal(editTask.prompt, 'make the coat blue')
    assert.deepEqual(JSON.parse(editTask.params!).referenceImages, [ref])
    assert.equal(db.select().from(table).where(eq(table.id, asset.id)).get()!.imageUrl, editTask.localPath)
    assert.equal(db.select().from(table).where(eq(table.id, asset.id)).get()!.finalPrompt, '保留原始三视图提示词')
    const history = await (await tasks.request(`/?type=image&${kind}_id=${asset.id}`)).json() as any
    assert.deepEqual(history.data.map((row: any) => row.id).sort((a: number, b: number) => a - b), [textTask.id, editTask.id])
    assert.ok(requests.some(r => r.url === '/v1/images/edits' && r.body.includes('make the coat blue') && r.body.includes('name="image[]"')))
    const cleared = await request(route, `/${asset.id}`, { reference_model: null, reference_config_id: null }, 'PUT')
    assert.equal(cleared.status, 200)
    const after = db.select().from(table).where(eq(table.id, asset.id)).get()!
    assert.equal(after.referenceModel, null)
    assert.equal(after.imageModel, 'gpt-image-2')
    assert.equal(after.editPrompt, 'make the coat blue')
  })
}

test('reference validation rejects empty edits, overflow and unsupported workflows before enqueue', async () => {
  const body = { generation_mode: 'reference', config_id: editImage.id, reference_images: [ref], edit_prompt: 'edit' }
  await assert.rejects(resolveAssetImageRequest({ ...body, edit_prompt: ' ' }, {}), /修改描述/)
  await assert.rejects(resolveAssetImageRequest({ ...body, reference_images: Array(5).fill(ref) }, {}), /1–4/)
  await assert.rejects(resolveAssetImageRequest({ ...body, reference_images: ['static/../secret'] }, {}), /路径无效/)
  const comfy = config('image', ['wf-z-image', 'wf-qwen-image'], 'comfyui')
  await assert.rejects(resolveAssetImageRequest({ ...body, config_id: comfy.id, model: 'wf-z-image' }, {}), /只支持文生图/)
  await assert.rejects(resolveAssetImageRequest({ generation_mode: 'text', config_id: comfy.id, model: 'wf-qwen-image' }, {}), /参考图/)
  const ordered = await resolveAssetImageRequest({ ...body, reference_images: ['static/images/main.png', 'static/images/secondary.png'] }, {})
  assert.deepEqual(ordered.referenceImages, ['static/images/main.png', 'static/images/secondary.png'])
})

test('batch text images honor each asset override and expose individual model failures', async () => {
  const good = db.insert(schema.characters).values({ dramaId: 1, name: 'batch', finalPrompt: '批量角色三视图', imageModel: 'gpt-image-2-edit', imageConfigId: editImage.id, createdAt: ts, updatedAt: ts }).returning().get()
  const stale = db.insert(schema.characters).values({ dramaId: 1, name: 'stale', finalPrompt: '批量角色三视图', imageModel: 'missing', imageConfigId: textImage.id, createdAt: ts, updatedAt: ts }).returning().get()
  const response = await request(characters, '/batch-generate-images', { episode_id: 1, character_ids: [good.id, stale.id], model: 'gpt-image-2', config_id: textImage.id })
  assert.equal(response.status, 200)
  assert.equal(response.body.data.count, 1)
  assert.equal(response.body.data.errors[0].character_id, stale.id)
  const task = await finished(response.body.data.ids[0])
  assert.equal(task.status, 'completed', task.errorMsg || '')
  assert.equal(task.model, 'gpt-image-2-edit')
  assert.equal(task.configId, editImage.id)
})

test('unreadable explicit references fail the task without sending a generation or edit request', async () => {
  for (const missing of ['static/images/missing.png', `${base}/missing.png`]) {
    const asset = db.insert(schema.characters).values({ dramaId: 1, name: 'invalid reference', createdAt: ts, updatedAt: ts }).returning().get()
    const before = requests.filter(r => r.url.startsWith('/v1/images/')).length
    const response = await request(characters, `/${asset.id}/generate-image`, { episode_id: 1, generation_mode: 'reference', reference_images: [missing, ref], edit_prompt: 'edit', config_id: editImage.id })
    assert.equal(response.status, 200)
    const task = await finished(response.body.data.image_generation_id)
    assert.equal(task.status, 'failed')
    assert.match(task.errorMsg!, /参考图.*(?:失败|无法读取)/)
    if (missing.startsWith('static/')) assert.equal(task.errorMsg, '参考图文件无法读取，请重新上传或选择历史图片')
    assert.equal(requests.filter(r => r.url.startsWith('/v1/images/')).length, before)
  }
})

test('video override is per-shot, persists without clearing fields, and wins over toolbar in task submission', async () => {
  const sb = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, description: 'description', atmosphere: 'atmosphere', videoPrompt: 'prompt', duration: 8, createdAt: ts, updatedAt: ts }).returning().get()
  const other = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 2, createdAt: ts, updatedAt: ts }).returning().get()
  assert.equal((await request(storyboards, `/${sb.id}`, { video_model: 'MiniMax-H3', video_config_id: video.id }, 'PUT')).status, 200)
  const persisted = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!
  assert.equal(persisted.description, 'description')
  assert.equal(persisted.atmosphere, 'atmosphere')
  assert.equal(persisted.videoPrompt, 'prompt')
  assert.equal(persisted.duration, 8)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, other.id)).get()!.videoModel, null)
  const generated = await request(tasks, '/', { type: 'video', storyboard_id: sb.id, model: 'MiniMax-H3-other', config_id: otherVideo.id, prompt: 'prompt', duration: 8 })
  assert.equal(generated.status, 201, JSON.stringify(generated.body))
  const task = await finished(generated.body.data.id)
  assert.equal(task.model, 'MiniMax-H3')
  assert.equal(task.configId, video.id)
  assert.equal(task.status, 'failed')
  assert.match(task.errorMsg!, /controlled upstream failure/)
  assert.equal((await request(storyboards, `/${sb.id}`, { video_model: null, video_config_id: null }, 'PUT')).status, 200)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!.videoModel, null)
})

test('official Gemini reference editing includes image parts rather than losing references in interactions', () => {
  const request = new GeminiImageAdapter().buildGenerateRequest({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'test', model: 'gemini-3-pro-image' }, { id: 1, prompt: 'edit', referenceImages: JSON.stringify([ref]) })
  assert.match(request.url, /generateContent/)
  assert.ok((request.body as any).contents[0].parts[0].inline_data)
})

after(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
