import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'video-public-media-'))
process.env.HUOBAO_DATA_DIR = directory
process.env.STORAGE_PATH = path.join(directory, 'static')
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.PUBLIC_BASE_URL = 'https://assets.example.test/'
delete process.env.PUBLIC_MEDIA_SIGNED_URLS
const { db, schema } = await import('../src/db/index.js')
const { generateVideo, isGenerationTaskActive } = await import('../src/services/generation.js')
const { resolvePublicMediaUrl } = await import('../src/services/public-media.js')
const { signedReferenceMediaRoutes } = await import('../src/services/signed-reference-media.js')

const storage = path.join(directory, 'static/uploads')
await fs.mkdir(storage, { recursive: true })
for (const name of ['first.png', 'second image.png', 'motion.mp4', 'voice.mp3', 'story.pdf', 'page.html']) {
  await fs.writeFile(path.join(storage, name), 'fixture')
}
after(() => fs.rm(directory, { recursive: true, force: true }))

const host = 'https://assets.example.test'
const first = `${host}/static/uploads/first.png`
const second = `${host}/static/uploads/second%20image.png`
const motion = `${host}/static/uploads/motion.mp4`
const voice = `${host}/static/uploads/voice.mp3`
const pdf = `${host}/static/uploads/story.pdf`
const web = `${host}/static/uploads/page.html`
const alreadyHosted = 'https://other.example.test/reference.png?keep=1'
const references = { referenceImageUrls: ['/static/uploads/second image.png', alreadyHosted, 'static/uploads/first.png'],
  referenceAudioUrls: ['/static/uploads/voice.mp3'], referenceVideoUrls: ['/static/uploads/motion.mp4'] }
const imageOrder = [second, alreadyHosted, first]

const models = {
  volcengine: 'doubao-seedance-2-5-260628',
  aicost: 'seedance2.5-ae-480p',
  aliyun: 'wan3.0-video',
  minimax: 'MiniMax-H3',
}

test('native video providers use ordered public URLs for deployment assets across the shared video entry point', async t => {
  const outbound: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('content-type'), 'application/json')
    outbound.push(JSON.parse(init.body))
    return new Response('mock submission end', { status: 400 })
  })
  const configs = Object.entries(models).map(([provider, model]) => {
    const now = new Date().toISOString()
    return db.insert(schema.aiServiceConfigs).values({ name: provider, provider, model: JSON.stringify([model]),
      baseUrl: `https://${provider}.example.test`, serviceType: 'video', apiKey: 'test-only', isActive: true,
      createdAt: now, updatedAt: now }).returning().get().id
  })
  async function submit(configId: number, media: Partial<Parameters<typeof generateVideo>[0]>) {
    const id = await generateVideo({ configId, prompt: '查看参考素材的顺序', duration: 6, ...media })
    const limit = Date.now() + 5000
    while (isGenerationTaskActive(id) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(isGenerationTaskActive(id), false)
    const task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
    assert.match(task?.errorMsg || '', /mock submission end/)
    return outbound.at(-1)
  }

  const ark = await submit(configs[0], references)
  assert.deepEqual(ark.content.slice(1).map(item => item[item.type].url), [...imageOrder, motion, voice])

  const aicost = await submit(configs[1], references)
  assert.deepEqual([aicost.images, aicost.videos, aicost.audios], [imageOrder, [motion], [voice]])

  const wan = await submit(configs[2], { ...references, referenceFileUrl: '/static/uploads/story.pdf' })
  assert.deepEqual(wan.input.media.map(item => item.url), [...imageOrder, motion, voice, pdf])
  const webRef = await submit(configs[2], { referenceLinkUrl: 'static/uploads/page.html' })
  assert.deepEqual(webRef.input.media, [{ type: 'link', url: web }])
  const frames = await submit(configs[2], { firstFrameUrl: '/static/uploads/first.png', lastFrameUrl: '/static/uploads/second image.png' })
  assert.deepEqual(frames.input.media, [{ type: 'first_frame', url: first }, { type: 'last_frame', url: second }])

  const minimax = await submit(configs[3], references)
  assert.deepEqual(minimax.content.slice(1).map(item => item[item.type].url), [...imageOrder, motion, voice])
  assert.equal(outbound.length, 6)
  const stored = db.select().from(schema.sysTask).all()
  assert.deepEqual(JSON.parse(stored[0].params!).referenceAudioUrls, references.referenceAudioUrls)
})

test('public references reject missing and traversing local paths, and preserve existing URLs', async () => {
  assert.equal(await resolvePublicMediaUrl(alreadyHosted, 'image'), alreadyHosted)
  assert.equal(await resolvePublicMediaUrl('/static/uploads/second image.png', 'image'), second)
  await assert.rejects(resolvePublicMediaUrl('/static/uploads/missing.png', 'image'), /不存在/)
  await assert.rejects(resolvePublicMediaUrl('/static/uploads/%2e%2e/first.png', 'image'), /路径无效/)
})

test('AICost public video references expose mismatched JPEG files with matching extensions and unchanged bytes', async t => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const jpeg = await fs.readFile(path.join(repo, 'docs/screenshots/tencent-private/01-server.jpg'))
  const png = await fs.readFile(path.join(repo, 'frontend/app/public/icons/dark/qwen-color.png'))
  await fs.writeFile(path.join(storage, 'jpeg-stored.png'), jpeg)
  await fs.writeFile(path.join(storage, 'actual.png'), png)
  const source = '/static/uploads/jpeg-stored.png'
  const normalPng = '/static/uploads/actual.png'
  const outbound: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    outbound.push(JSON.parse(init.body))
    return new Response('mock submission end', { status: 400 })
  })
  const now = new Date().toISOString()
  const configId = db.insert(schema.aiServiceConfigs).values({ name: 'aicost-public-mime', provider: 'aicost',
    model: JSON.stringify([models.aicost]), baseUrl: 'https://aicost.example.test', serviceType: 'video',
    apiKey: 'test-only', isActive: true, createdAt: now, updatedAt: now }).returning().get().id
  const arkConfigId = db.insert(schema.aiServiceConfigs).values({ name: 'ark-public-mime', provider: 'volcengine',
    model: JSON.stringify([models.volcengine]), baseUrl: 'https://volcengine.example.test', serviceType: 'video',
    apiKey: 'test-only', isActive: true, createdAt: now, updatedAt: now }).returning().get().id
  async function submit(media: Partial<Parameters<typeof generateVideo>[0]>, selectedConfigId = configId) {
    const id = await generateVideo({ configId: selectedConfigId, prompt: '查看参考图片', ...media })
    const limit = Date.now() + 5000
    while (isGenerationTaskActive(id) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(isGenerationTaskActive(id), false)
    assert.match(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()?.errorMsg || '', /mock submission end/)
    return outbound.at(-1)
  }
  const result = await submit({ referenceImageUrls: [source, normalPng, alreadyHosted, source] })
  assert.match(result.images[0], /^https:\/\/assets\.example\.test\/static\/reference-images\/.+\.jpg$/)
  assert.deepEqual(result.images, [result.images[0], `${host}/static/uploads/actual.png`, alreadyHosted, result.images[0]])
  const cached = new URL(result.images[0]).pathname.replace(/^\/static\//, '')
  assert.deepEqual(await fs.readFile(path.join(directory, 'static', cached)), jpeg)
  assert.deepEqual(await fs.readFile(path.join(storage, 'jpeg-stored.png')), jpeg)

  const frames = await submit({ firstFrameUrl: source, lastFrameUrl: normalPng })
  assert.equal(frames.start_frame, result.images[0])
  assert.equal(frames.end_frame, `${host}/static/uploads/actual.png`)
  const image = await submit({ imageUrl: source })
  assert.deepEqual(image.images, [result.images[0]])
  assert.equal(await resolvePublicMediaUrl(source, 'image'), `${host}/static/uploads/jpeg-stored.png`)
  const ark = await submit({ referenceImageUrls: [source] }, arkConfigId)
  assert.equal(ark.content[1].image_url.url, `${host}/static/uploads/jpeg-stored.png`)
})

test('signed AICost image reference serves a JPEG with a matching MIME type', async t => {
  process.env.PUBLIC_MEDIA_SIGNED_URLS = 'true'
  t.after(() => { delete process.env.PUBLIC_MEDIA_SIGNED_URLS })
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const jpeg = await fs.readFile(path.join(repo, 'docs/screenshots/tencent-private/01-server.jpg'))
  await fs.writeFile(path.join(storage, 'signed-jpeg.png'), jpeg)
  const reference = await resolvePublicMediaUrl('/static/uploads/signed-jpeg.png', 'image', { matchImageExtension: true })
  assert.match(new URL(reference!).pathname, /^\/api\/v1\/reference-media\/reference-images\/.+\.jpg$/)
  const app = new Hono().route('/api/v1/reference-media', signedReferenceMediaRoutes)
  const response = await app.request(reference!)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg)
})

test('private deployment resolves a local reference to a signed link that serves the original file', async t => {
  process.env.PUBLIC_MEDIA_SIGNED_URLS = 'true'
  t.after(() => { delete process.env.PUBLIC_MEDIA_SIGNED_URLS })
  const app = new Hono().route('/api/v1/reference-media', signedReferenceMediaRoutes)
  const reference = await resolvePublicMediaUrl('/static/uploads/voice.mp3', 'audio')
  const url = new URL(reference!)
  assert.equal(url.origin, host)
  assert.equal(url.pathname, '/api/v1/reference-media/uploads/voice.mp3')
  const result = await app.request(reference!)
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('Content-Type'), 'audio/mpeg')
  assert.equal(await result.text(), 'fixture')
  assert.equal((await app.request(url.origin + url.pathname)).status, 404)
})
