import assert from 'node:assert/strict'
import { after, test, type TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-collaboration-'))
process.env.SQLITE_PATH = path.join(directory, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = directory
process.env.MYSQL_AUTO_IMPORT = 'false'
const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
after(() => fs.rm(directory, { recursive: true, force: true }))

async function fixture(_t: TestContext) {
  const store = new ScriptVideoStore(path.join(directory, randomUUID()))
  const project = await store.create('共享账号多页面')
  const eid = project.episodeId
  await store.mutate(project.id, record => {
    Object.assign(record.project.episodes[0], { confirmed: true, outlineConfirmed: true, stage: 'production', script: '城门开启。', confirmedScript: '城门开启。',
      cards: ['one', 'two'].map(id => ({ id, title: id, duration: 5, prompt: '镜头进入庭院。', shots: [],
        manuallyAdded: true, assetIds: [], version: 1, status: 'draft' })) })
    return { result: null, documentChanged: true }
  })
  let submissions = 0
  const states = new Map<number, any>()
  const app = createScriptVideoRoutes(store, {
    async startScriptVideoGeneration() { const taskId = ++submissions; states.set(taskId, { taskId, status: 'processing' }); return { taskId, status: 'processing' } },
    async getScriptVideoGeneration(taskId: number) { return states.get(taskId) },
  } as any)
  const a = randomUUID(), b = randomUUID()
  const url = `http://localhost/projects/${project.id}`
  async function request(session: string, suffix: string, body?: unknown, method = 'POST') {
    return app.request(url + suffix, { method, headers: { 'Content-Type': 'application/json', 'X-Script-Video-Session': session }, ...(body !== undefined && { body: JSON.stringify(body) }) })
  }
  const payload = (requestId: string, expectedCardVersion = 1) => ({ requestId, expectedCardVersion, configId: 1, model: 'test-model', aspectRatio: '16:9', resolution: '480p' })
  return { store, app, eid, a, b, request, payload, states, submittedCount: () => submissions, url }
}

test('a batch waiting in one page disables that card in another page before paid submission', async t => {
  const f = await fixture(t)
  const suffix = `/episodes/${f.eid}`
  assert.equal((await f.request(f.a, `${suffix}/video-queue`, { requestId: 'batch-a', cardIds: ['one'] })).status, 200)
  assert.equal((await f.request(f.b, `${suffix}/video-queue`, { requestId: 'batch-b', cardIds: ['one'] })).status, 409)
  const activity = (await (await f.request(f.b, `${suffix}/activity`, undefined, 'GET')).json()).data
  assert.deepEqual(activity.queuedCardIds, ['one'])
  assert.deepEqual(activity.activeCardIds, ['one'])
  assert.equal((await f.request(f.b, `${suffix}/cards/one/video`, f.payload('batch-b'))).status, 409)
  assert.equal(f.submittedCount(), 0)
  assert.equal((await f.request(f.a, `${suffix}/cards/one/video`, f.payload('batch-a'))).status, 201)
  assert.equal(f.submittedCount(), 1)
})

test('two pages racing the same card create one task, and editing its prompt cannot bypass the active state', async t => {
  const f = await fixture(t), suffix = `/episodes/${f.eid}`
  const attempts = await Promise.all([
    f.request(f.a, `${suffix}/cards/one/video`, f.payload('request-a')),
    f.request(f.b, `${suffix}/cards/one/video`, f.payload('request-b')),
  ])
  assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409])
  assert.equal(f.submittedCount(), 1)
  const save = await f.request(f.b, '/changes', { clientId: 'writer-b', sequence: 1, changes: [
    { target: 'card', episodeId: f.eid, id: 'one', fields: { prompt: '新提示词' } },
  ] }, 'PATCH')
  assert.equal(save.status, 200)
  const activity = (await (await f.request(f.b, `${suffix}/activity`, undefined, 'GET')).json()).data
  assert.ok(activity.activeCardIds.includes('one'))
  const version = (await f.store.episode(f.url.split('/').at(-1)!, f.eid)).episode.cards[0].version
  assert.equal((await f.request(f.b, `${suffix}/cards/one/video`, f.payload('new-request', version))).status, 409)
  f.states.set(1, { taskId: 1, status: 'completed', videoUrl: '/static/videos/old-input.mp4' })
  const done = (await (await f.request(f.b, `${suffix}/activity`, undefined, 'GET')).json()).data
  assert.deepEqual(done.activeCardIds, [])
  assert.equal(done.tasks[0].videoUrl, '/static/videos/old-input.mp4')
  assert.equal(done.tasks[0].staleResult, true)
})

test('canceling one browser batch leaves another batch in the same episode running', async t => {
  const f = await fixture(t), suffix = `/episodes/${f.eid}`
  assert.equal((await f.request(f.a, `${suffix}/cards/one/video`, f.payload('batch-a'))).status, 201)
  assert.equal((await f.request(f.b, `${suffix}/cards/two/video`, f.payload('batch-b'))).status, 201)
  const cancel = await f.request(f.a, `${suffix}/video-cancel`, { requestId: 'batch-a' })
  assert.equal(cancel.status, 200)
  const activity = (await (await f.request(f.b, `${suffix}/activity`, undefined, 'GET')).json()).data
  assert.equal(activity.tasks.find((task: any) => task.cardId === 'one').status, 'canceled')
  assert.equal(activity.tasks.find((task: any) => task.cardId === 'two').status, 'processing')
})
