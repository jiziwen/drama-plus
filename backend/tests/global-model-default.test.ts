import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await mkdtemp(path.join(os.tmpdir(), 'global-model-default-'))
process.env.SQLITE_PATH = path.join(root, 'db.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { default: routes } = await import('../src/routes/aiConfigs.js')
const { getActiveConfig, getActiveConfigId, getConfigById, getGlobalDefaultModel } = await import('../src/services/ai.js')
const { projectModelOptions } = await import('../src/services/project-model-options.js')
const { resolveAssetImageRequest } = await import('../src/services/media-selection.js')
const { videoPromptModelLabel } = await import('../src/services/video-prompts.js')
after(async () => { db.$client.close(); await rm(root, { recursive: true, force: true }) })

const timestamp = new Date().toISOString()
function insert(serviceType: string, provider: string, models: string[], priority = 0, isActive = true) {
  return db.insert(schema.aiServiceConfigs).values({ serviceType, provider, name: provider, baseUrl: 'https://example.test', apiKey: 'test',
    model: JSON.stringify(models), priority, isActive, createdAt: timestamp, updatedAt: timestamp }).returning().get()
}
const textA = insert('text', 'openai', ['text-a1', 'text-a2'])
const textB = insert('text', 'gemini', ['text-b1', 'text-b2'])
const inactive = insert('text', 'volcengine', ['inactive'], 50, false)
const empty = insert('text', 'openai', [], 100)
const imageA = insert('image', 'openai', ['dall-e-3', 'gpt-image-2'], 1)
const imageB = insert('image', 'gemini', ['image-b1'])
const videoA = insert('video', 'volcengine', ['video-a1', 'video-a2'])
const videoCli = insert('video', 'jimeng', ['jimeng-seedance-2.5'], 20)

const set = (type: string, configId: number, model: string) => routes.request(`/default/${type}`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ configId, model }),
})
async function list() {
  const response = await routes.request('/')
  assert.equal(response.status, 200)
  return (await response.json() as any).data as any[]
}

test('one persisted default per type survives reload and never changes provider-local ordering or priority', async () => {
  assert.deepEqual(getGlobalDefaultModel('text'), { configId: textA.id, model: 'text-a1' })
  assert.equal((await set('text', textB.id, 'text-b2')).status, 200)
  assert.deepEqual(getGlobalDefaultModel('text'), { configId: textB.id, model: 'text-b2' })
  assert.equal((await getActiveConfig('text'))?.model, 'text-b2')
  assert.equal(await getActiveConfigId('text'), textB.id)
  assert.equal((await getConfigById(textB.id))?.model, 'text-b2')
  assert.equal((await getConfigById(textA.id))?.model, 'text-a1')
  const unchanged = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, textB.id)).get()!
  assert.equal(unchanged.model, JSON.stringify(['text-b1', 'text-b2']))
  assert.equal(unchanged.priority, 0)
  assert.equal(projectModelOptions().find(option => option.kind === 'text')?.model, 'text-b2')
  const rows = await list()
  assert.equal(rows.find(row => row.id === textB.id).global_default_model, 'text-b2')
  assert.equal(rows.find(row => row.id === textA.id).global_default_model, null)
  assert.equal(rows.find(row => row.id === inactive.id).global_default_eligible, false)
  assert.equal(rows.find(row => row.id === empty.id).global_default_eligible, false)
  assert.equal(rows.find(row => row.id === videoCli.id).global_default_eligible, false)
  assert.equal((await set('image', imageB.id, 'image-b1')).status, 200)
  assert.equal((await set('video', videoA.id, 'video-a2')).status, 200)
  assert.equal((await getActiveConfig('image'))?.model, 'image-b1')
  assert.equal((await getActiveConfig('video'))?.model, 'video-a2')
  assert.match(await videoPromptModelLabel(), /video-a2/)
  assert.match(await videoPromptModelLabel(videoA.id), /video-a2/)
  assert.match(await videoPromptModelLabel(999999), /已失效/)
  assert.equal((await getActiveConfig('text'))?.model, 'text-b2')
})

test('invalid, inactive, removed and CLI-only video choices fail without changing a saved default', async () => {
  assert.equal((await set('text', inactive.id, 'inactive')).status, 400)
  assert.equal((await set('text', textB.id, 'not-in-list')).status, 400)
  assert.equal((await set('text', imageA.id, 'dall-e-3')).status, 400)
  assert.equal((await set('video', videoCli.id, 'jimeng-seedance-2.5')).status, 400)
  assert.equal((await set('audio', textA.id, 'text-a1')).status, 400)
  assert.deepEqual(getGlobalDefaultModel('text'), { configId: textB.id, model: 'text-b2' })
  db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, textB.id)).run()
  assert.deepEqual(getGlobalDefaultModel('text'), { configId: textA.id, model: 'text-a1' })
  db.update(schema.aiServiceConfigs).set({ isActive: true, model: JSON.stringify(['text-b1']) }).where(eq(schema.aiServiceConfigs.id, textB.id)).run()
  assert.deepEqual(getGlobalDefaultModel('text'), { configId: textA.id, model: 'text-a1' })
  db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, textB.id)).run()
  assert.deepEqual(getGlobalDefaultModel('text'), { configId: textA.id, model: 'text-a1' })
})

test('image-mode filtering preserves a usable option when the global image model does not support editing', async () => {
  assert.equal((await set('image', imageA.id, 'dall-e-3')).status, 200)
  assert.equal(projectModelOptions().find(option => option.kind === 'image')?.model, 'dall-e-3')
  const references = projectModelOptions({ imageMode: 'reference' }).filter(option => option.kind === 'image')
  assert.ok(references.every(option => option.model !== 'dall-e-3'))
  assert.equal(references[0].model, 'gpt-image-2')
  await assert.rejects(resolveAssetImageRequest({ generation_mode: 'reference', reference_images: ['/static/uploads/ref.png'], edit_prompt: '修改' }, {}), /DALL-E/)
})
