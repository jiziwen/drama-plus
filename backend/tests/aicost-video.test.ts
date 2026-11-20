import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-aicost-'))
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { getVideoAdapter } = await import('../src/services/adapters/registry.js')

const adapter = getVideoAdapter('aicost')
const config = { baseUrl: 'https://www.aicost.me/v1/', apiKey: 'test-key', provider: 'aicost', model: 'seedance2.5-720p' }
await fs.mkdir(path.join(root, 'static/uploads'), { recursive: true })
await fs.writeFile(path.join(root, 'static/uploads/scene.png'), 'scene')
await fs.writeFile(path.join(root, 'static/uploads/actor.png'), 'actor')
await fs.writeFile(path.join(root, 'static/uploads/voice.wav'), 'voice')
await fs.writeFile(path.join(root, 'static/uploads/other-voice.mp3'), 'other-voice')
await fs.writeFile(path.join(root, 'static/uploads/motion.mp4'), 'motion')
after(() => fs.rm(root, { recursive: true, force: true }))

test('AICost keeps multipart for local Seedance 2.5 references without audio', async () => {
  const prompt = '按 @图片1、@图片2 的顺序出场。'
  const request = await adapter.buildGenerateRequest(config, {
    id: 1, model: 'seedance2.5-Custom', prompt, duration: 30, aspectRatio: '9:16', resolution: '1k',
    referenceImageUrls: JSON.stringify(['/static/uploads/scene.png', '/static/uploads/actor.png']),
    referenceVideoUrls: JSON.stringify(['/static/uploads/motion.mp4']),
  })
  assert.equal(request.url, 'https://www.aicost.me/v1/videos')
  assert.deepEqual(request.headers, { Authorization: 'Bearer test-key' })
  const body = request.body as FormData
  assert.ok(body instanceof FormData)
  assert.deepEqual(['model', 'prompt', 'seconds', 'aspect_ratio', 'resolution'].map(key => body.get(key)),
    ['seedance2.5-Custom', prompt, '30', '9:16', '1k'])
  assert.deepEqual(await Promise.all((body.getAll('images') as File[]).map(async file => [file.name, await file.text()])),
    [['scene.png', 'scene'], ['actor.png', 'actor']])
  assert.equal((body.get('videos') as File).type, 'video/mp4')
})

test('AICost Seedance 2.5 sends small local audio inline in JSON with the original reference order', async () => {
  const prompt = '@图片1 的对白参考 @音频1，@图片2 的对白参考 @音频2。'
  const request = await adapter.buildGenerateRequest(config, {
    id: 1, model: 'seedance2.5-ae-480p', prompt, duration: 30, aspectRatio: '16:9', resolution: '480p',
    referenceImageUrls: JSON.stringify(['/static/uploads/actor.png', '/static/uploads/scene.png']),
    referenceAudioUrls: JSON.stringify(['/static/uploads/other-voice.mp3', '/static/uploads/voice.wav']),
  })
  const data = (type: string, content: string) => `data:${type};base64,${Buffer.from(content).toString('base64')}`
  assert.equal(request.headers['Content-Type'], 'application/json')
  assert.deepEqual(request.body, {
    model: 'seedance2.5-ae-480p', prompt, seconds: 30, aspect_ratio: '16:9', resolution: '480p',
    images: [data('image/png', 'actor'), data('image/png', 'scene')],
    audios: [data('audio/mpeg', 'other-voice'), data('audio/wav', 'voice')],
  })
})

test('AICost sends JPEG content with its real media type even when stored with a PNG suffix', async () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const jpeg = await fs.readFile(path.join(repo, 'docs/screenshots/tencent-private/01-server.jpg'))
  const png = await fs.readFile(path.join(repo, 'frontend/app/public/icons/dark/qwen-color.png'))
  await fs.writeFile(path.join(root, 'static/uploads/mismatched.png'), jpeg)
  await fs.writeFile(path.join(root, 'static/uploads/real.png'), png)
  const images = JSON.stringify(['/static/uploads/mismatched.png', '/static/uploads/real.png'])

  // A voice reference selects Seedance 2.5's inline JSON path.
  const inline = await adapter.buildGenerateRequest(config, {
    id: 2, model: 'seedance2.5-ae-480p', prompt: '参考图片和声音',
    referenceImageUrls: images,
    referenceAudioUrls: JSON.stringify(['/static/uploads/voice.wav']),
  })
  assert.equal(inline.headers['Content-Type'], 'application/json')
  const inlineImages = inline.body.images as string[]
  assert.deepEqual(inlineImages.map(image => image.split(',')[0]), ['data:image/jpeg;base64', 'data:image/png;base64'])
  assert.deepEqual(inlineImages.map(image => Buffer.from(image.split(',')[1], 'base64')), [jpeg, png])

  // Without voice, the same local images take the multipart path.
  const multipart = await adapter.buildGenerateRequest(config, {
    id: 3, model: 'seedance2.5-ae-480p', prompt: '参考图片', referenceImageUrls: images,
  })
  assert.ok(multipart.body instanceof FormData)
  const files = multipart.body.getAll('images') as File[]
  assert.deepEqual(files.map(file => [file.name, file.type]), [
    ['mismatched.jpg', 'image/jpeg'], ['real.png', 'image/png'],
  ])
  assert.deepEqual(await Promise.all(files.map(async file => Buffer.from(await file.arrayBuffer()))), [jpeg, png])
})

test('AICost keeps multipart for large local references on Seedance 2.5', async () => {
  const large = path.join(root, 'static/uploads/large.mp4')
  await fs.writeFile(large, '')
  await fs.truncate(large, 49 * 1024 * 1024)
  const request = await adapter.buildGenerateRequest(config, {
    id: 1, prompt: '参考 @视频1 和 @音频1。',
    referenceVideoUrls: JSON.stringify(['/static/uploads/large.mp4']),
    referenceAudioUrls: JSON.stringify(['/static/uploads/voice.wav']),
  })
  assert.ok(request.body instanceof FormData)
  assert.equal((request.body.get('videos') as File).size, 49 * 1024 * 1024)
  assert.equal((request.body.get('audios') as File).name, 'voice.wav')
})

test('AICost JSON wire order survives mixed URL and local references, with documented H3 aliases', async () => {
  const mixed = await adapter.buildGenerateRequest(config, {
    id: 1, prompt: '@图片1 出现于 @图片2 前。',
    referenceImageUrls: JSON.stringify(['https://example.test/image.png', '/static/uploads/scene.png']),
  })
  assert.deepEqual(mixed.body.images, ['https://example.test/image.png', 'data:image/png;base64,c2NlbmU='])
  assert.equal(mixed.headers['Content-Type'], 'application/json')
  const h3 = await adapter.buildGenerateRequest(config, {
    id: 2, model: 'hailuo-03', prompt: '@图片1 说话。', duration: 10, resolution: '1440p',
    referenceImageUrls: JSON.stringify(['https://example.test/actor.png']),
    referenceAudioUrls: JSON.stringify(['/static/uploads/voice.wav']),
  })
  assert.deepEqual(h3.body, {
    model: 'hailuo-03', prompt: '@图片1 说话。', seconds: 10, resolution: '1440P',
    reference_images: ['https://example.test/actor.png'], audio_references: ['data:audio/wav;base64,dm9pY2U='],
  })
  await fs.symlink(path.join(root, 'private.png'), path.join(root, 'static/uploads/escaped.png'))
  await fs.writeFile(path.join(root, 'private.png'), 'private')
  await assert.rejects(adapter.buildGenerateRequest(config, { id: 3, prompt: 'image', imageUrl: '/static/uploads/escaped.png' }), /无法读取本地参考素材/)
})

test('AICost handles documented status variants and separates status from content retrieval', () => {
  assert.deepEqual(adapter.parseGenerateResponse({ id: 'task_1', status: 'queued' }), { isAsync: true, taskId: 'task_1' })
  assert.equal(adapter.parsePollResponse({ status: 'NOT_START' }).status, 'pending')
  assert.equal(adapter.parsePollResponse({ status: 'IN_PROGRESS' }).status, 'processing')
  assert.deepEqual(adapter.parsePollResponse({ status: 'FAILURE', fail_reason: 'denied' }), { status: 'failed', error: 'denied' })
  assert.equal(adapter.parsePollResponse({ status: 'SUCCESS' }).status, 'completed')
  assert.equal(adapter.buildPollRequest(config, 'task_1').url, 'https://www.aicost.me/v1/videos/task_1')
  const content = adapter.buildDownloadRequest!(config, 'task_1')
  assert.equal(content.url, 'https://www.aicost.me/v1/videos/task_1/content')
  assert.equal(content.headers.Authorization, 'Bearer test-key')
})

test('AICost recovery redownloads authorized content without resubmitting or sending the key to the redirect host', async () => {
  const { db, schema } = await import('../src/db/index.js')
  const { isGenerationTaskActive, recoverVideoTask } = await import('../src/services/generation.js')
  const requests: { url?: string; method?: string; authorization?: string }[] = []
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
  const asset = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization })
    res.end(mp4)
  })
  await new Promise<void>(resolve => asset.listen(0, '127.0.0.1', resolve))
  const gateway = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization })
    res.writeHead(302, { Location: `http://127.0.0.1:${(asset.address() as AddressInfo).port}/download` }).end()
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`
    const now = new Date().toISOString()
    const configId = db.insert(schema.aiServiceConfigs).values({ ...config, model: JSON.stringify([config.model]), baseUrl,
      name: 'mock', serviceType: 'video', isActive: true, createdAt: now, updatedAt: now }).returning().get().id
    const task = db.insert(schema.sysTask).values({ type: 'video', provider: config.provider, status: 'failed', stage: 'downloading',
      configId, configBaseUrl: baseUrl, taskId: 'task_1', resultUrl: `${baseUrl}/v1/videos/task_1/content`, errorCode: 'delivery_failed',
      createdAt: now, updatedAt: now }).returning().get()
    await recoverVideoTask(task.id)
    const deadline = Date.now() + 10_000
    while (isGenerationTaskActive(task.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const result = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, task.id)).get()
    assert.equal(result?.status, 'completed', result?.errorMsg || undefined)
    assert.deepEqual(await fs.readFile(path.join(root, result!.localPath!)), mp4)
    assert.deepEqual(requests, [
      { url: '/v1/videos/task_1/content', method: 'GET', authorization: 'Bearer test-key' },
      { url: '/download', method: 'GET', authorization: undefined },
    ])
  } finally {
    gateway.closeAllConnections()
    asset.closeAllConnections()
    await Promise.all([gateway, asset].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
})
