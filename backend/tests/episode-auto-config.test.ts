import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { eq } from 'drizzle-orm'

const root = await mkdtemp(path.join(os.tmpdir(), 'episode-global-default-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { default: routes } = await import('../src/routes/episodes.js')
const { setGlobalDefaultModel } = await import('../src/services/ai.js')
const { resolveMediaConfig } = await import('../src/services/media-selection.js')
const now = new Date().toISOString()
const config = (type: string, provider: string, models: string[]) => db.insert(schema.aiServiceConfigs).values({
  serviceType: type, provider, name: models[0], baseUrl: 'https://example.test', apiKey: 'fixture',
  model: JSON.stringify(models), isActive: true, createdAt: now, updatedAt: now,
}).returning().get()
const images = config('image', 'openai', ['gpt-image-1', 'gpt-image-2'])
const videos = config('video', 'minimax', ['first', 'second'])
const otherImages = config('image', 'openai', ['other-image'])
const otherVideos = config('video', 'minimax', ['other-video'])
db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: now, updatedAt: now }).run()
after(async () => { db.$client.close(); await rm(root, { recursive: true, force: true }) })

test('new legacy episodes follow changing global defaults and retain explicit pins', async () => {
  const create = async (body: Record<string, unknown>) => {
    const response = await routes.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ drama_id: 1, ...body }) })
    assert.equal(response.status, 200)
    return (await response.json() as any).data
  }
  setGlobalDefaultModel('image', { configId: images.id, model: 'gpt-image-1' })
  setGlobalDefaultModel('video', { configId: videos.id, model: 'first' })
  const inherited = await create({})
  assert.equal(inherited.image_config_id, null)
  assert.equal(inherited.video_config_id, null)
  const explicit = await create({ image_config_id: images.id, video_config_id: videos.id })
  assert.equal(explicit.image_config_id, images.id)
  assert.equal(explicit.video_config_id, videos.id)
  setGlobalDefaultModel('image', { configId: images.id, model: 'gpt-image-2' })
  setGlobalDefaultModel('video', { configId: videos.id, model: 'second' })
  const stored = db.select().from(schema.episodes).where(eq(schema.episodes.id, inherited.id)).get()!
  assert.equal((await resolveMediaConfig('image', { configId: stored.imageConfigId })).model, 'gpt-image-2')
  assert.equal((await resolveMediaConfig('video', { configId: stored.videoConfigId })).model, 'second')
  setGlobalDefaultModel('image', { configId: otherImages.id, model: 'other-image' })
  setGlobalDefaultModel('video', { configId: otherVideos.id, model: 'other-video' })
  const pinned = db.select().from(schema.episodes).where(eq(schema.episodes.id, explicit.id)).get()!
  assert.equal(pinned.imageConfigId, images.id)
  assert.equal(pinned.videoConfigId, videos.id)
  assert.equal((await resolveMediaConfig('image', { configId: pinned.imageConfigId })).model, 'gpt-image-1')
  assert.equal((await resolveMediaConfig('video', { configId: pinned.videoConfigId })).model, 'first')
})
