import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

test('GPT Image 2.6 保持横屏尺寸并在任务完成后保存图片', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gpt-image-landscape-'))
  process.env.SQLITE_PATH = ':memory:'
  process.env.HUOBAO_DATA_DIR = root
  const [{ OpenAIImageAdapter }, { db, schema }, { generateImage }, { eq }] = await Promise.all([
    import('../src/services/adapters/openai-image.js'),
    import('../src/db/index.js'),
    import('../src/services/generation.js'),
    import('drizzle-orm'),
  ])
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const adapter = new OpenAIImageAdapter()
  const config = { provider: 'openai', baseUrl: 'https://www.aicost.me', apiKey: 'test-only', model: 'gpt-image-2.6-sunburst' }
  const image = 'data:image/png;base64,' + (await sharp({ create: { width: 16, height: 16, channels: 3, background: '#dedede' } }).png().toBuffer()).toString('base64')
  for (const model of ['gpt-image-2', 'gpt-image-2-2026-04-21', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare']) {
    const request = adapter.buildGenerateRequest(config, { id: 1, model, prompt: '人物', size: '2048x1152' })
    assert.equal(request.body.size, '2048x1152', model)
    const edit = adapter.buildGenerateRequest(config, { id: 1, model, prompt: '人物', size: '2048x1152', referenceImages: JSON.stringify([image]) })
    assert.ok(edit.body instanceof FormData)
    assert.equal(edit.body.get('size'), '2048x1152', model)
  }
  const legacy = adapter.buildGenerateRequest(config, { id: 1, model: 'gpt-image-1', size: '2048x1152' })
  assert.equal(legacy.body.size, '1536x1024')

  const ts = new Date().toISOString()
  const service = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'image', provider: 'openai', name: 'test', baseUrl: config.baseUrl,
    apiKey: config.apiKey, model: JSON.stringify([config.model]), isActive: true, createdAt: ts, updatedAt: ts,
  }).returning().get()
  const output = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: '#abc' } }).png().toBuffer()
  t.mock.method(globalThis, 'fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body))
    assert.equal(request.model, config.model)
    assert.equal(request.size, '2048x1152')
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })
  const id = await generateImage({ configId: service.id, model: config.model, prompt: '人物', size: '2048x1152', requireLandscape16x9: true })
  let task
  for (let attempt = 0; attempt < 200; attempt++) {
    task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    if (task?.status !== 'processing') break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(task?.status, 'completed', task?.errorMsg ?? '')
  assert.ok(task?.localPath)
  const meta = await sharp(join(root, task.localPath)).metadata()
  assert.equal(meta.width, 2048)
  assert.equal(meta.height, 1152)
})
