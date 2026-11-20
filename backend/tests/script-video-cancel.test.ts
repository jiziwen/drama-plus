import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { eq } from 'drizzle-orm'
import type { ScriptVideoGenerationStatus } from '../src/services/script-video-generation.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-cancel-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
const { generateVideo, cancelUnsubmittedVideoTask, isGenerationTaskActive } = await import('../src/services/generation.js')
after(() => fs.rm(root, { recursive: true, force: true }))

const priorVideo = '/static/videos/prior.mp4'
type Dependencies = NonNullable<Parameters<typeof createScriptVideoRoutes>[1]>
type FixtureDependencies = Pick<Dependencies, 'startScriptVideoGeneration' | 'getScriptVideoGeneration'>

async function fixture(dependencies: FixtureDependencies) {
  const store = new ScriptVideoStore(path.join(root, randomUUID()))
  const project = await store.create('取消生成验收')
  const main = project.episodeId
  const other = 'episode-other'
  const cards = [
    { id: 'first', title: '第一段', status: 'ready', videoUrl: priorVideo },
    { id: 'second', title: '第二段', status: 'draft' },
  ].map(card => ({
    ...card, duration: 5, version: 1, assetIds: [], manuallyAdded: true,
    prompt: '光影越过台阶。', shots: [],
  }))
  await store.mutate(project.id, record => {
    const episode = record.project.episodes[0]
    Object.assign(episode, {
      stage: 'production', script: '城门外有薄雾。', confirmedScript: '城门外有薄雾。',
      confirmed: true, outlineConfirmed: true, cards,
    })
    record.project.episodes.push({ ...structuredClone(episode), id: other, number: 2, tasks: [] })
    return { result: null, documentChanged: true }
  })
  const app = createScriptVideoRoutes(store, { ...dependencies } as Dependencies)
  const base = `http://localhost/projects/${project.id}`
  const headers = { 'Content-Type': 'application/json', 'X-Script-Video-Session': randomUUID() }
  const post = (url: string, body: object) => app.request(`${base}${url}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  for (const id of [main, other])
    assert.equal((await post(`/episodes/${id}/lock`, {})).status, 200)
  return {
    main, other, store, projectId: project.id,
    status: (taskId: number) => app.request(`${base}/video/${taskId}`),
    submit: (episodeId: string, cardId: string, requestId: string, confirmRetryAfterUnknown = false) =>
      post(`/episodes/${episodeId}/cards/${cardId}/video`, {
        expectedCardVersion: 1, configId: 1, model: 'test-video',
        aspectRatio: '16:9', resolution: '720p', requestId, confirmRetryAfterUnknown,
      }),
    cancel: (episodeId: string, body: { jobIds?: string[]; requestId?: string; cardId?: string }) =>
      post(`/episodes/${episodeId}/video-cancel`, body),
  }
}

async function cancelResult(response: Response) {
  assert.equal(response.status, 200)
  return ((await response.json()) as { data: { canceled: number; upstreamUnconfirmed: number } }).data
}

async function submitted(response: Response) {
  assert.equal(response.status, 201)
  return ((await response.json()) as { data: { jobId: string; taskId: number } }).data
}

test('video cancellation aborts preparation and a late request with the same ID cannot submit', { timeout: 5_000 }, async () => {
  const preparing = Promise.withResolvers<number>()
  const release = Promise.withResolvers<void>()
  let dispatched = 0
  const trial = await fixture({
    async startScriptVideoGeneration(_input, control) {
      const now = new Date().toISOString()
      const taskId = db.insert(schema.sysTask).values({
        type: 'video', status: 'processing', stage: 'preparing', provider: 'volcengine', createdAt: now, updatedAt: now,
      }).returning({ id: schema.sysTask.id }).get().id
      control?.onTaskCreated(taskId)
      preparing.resolve(taskId)
      await release.promise
      control?.signal.throwIfAborted()
      dispatched++
      return { taskId, status: 'processing' }
    },
    async getScriptVideoGeneration() { throw new Error('Preparation must not poll the provider') },
  })
  const requestId = randomUUID()
  const pending = trial.submit(trial.main, 'first', requestId)
  try {
    const taskId = await preparing.promise
    assert.deepEqual(await cancelResult(await trial.cancel(trial.main, { requestId })), { canceled: 1, upstreamUnconfirmed: 0 })
    const task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
    assert.deepEqual([task?.status, task?.stage, dispatched], ['canceled', 'canceled', 0])
    const late = await trial.submit(trial.main, 'second', requestId)
    assert.equal(late.status, 409)
    assert.equal(((await late.json()) as { errorCode: string }).errorCode, 'CANCELED')
  } finally {
    release.resolve()
  }
  assert.equal((await pending).status, 409)
  assert.equal(dispatched, 0)
  const current = (await trial.store.get(trial.projectId)).episodes[0]
  assert.equal(current.cards[0].videoUrl, priorVideo)
  assert.deepEqual(current.tasks.map((task: any) => [task.cardId, task.status, task.code]), [['first', 'canceled', 'CANCELED']])
  await submitted(await trial.submit(trial.main, 'first', randomUUID()))
  assert.equal(dispatched, 1)
})

test('canceling one job preserves other runs and ignores a late result while guarding resubmission', { timeout: 5_000 }, async () => {
  const lookupStarted = Promise.withResolvers<void>()
  const result = Promise.withResolvers<ScriptVideoGenerationStatus>()
  let launches = 0
  let lookups = 0
  const trial = await fixture({
    async startScriptVideoGeneration() { return { taskId: 500 + ++launches, status: 'processing' } },
    async getScriptVideoGeneration() { lookups++; lookupStarted.resolve(); return result.promise },
  })
  const one = await submitted(await trial.submit(trial.main, 'first', randomUUID()))
  const two = await submitted(await trial.submit(trial.main, 'second', randomUUID()))
  const foreign = await submitted(await trial.submit(trial.other, 'first', randomUUID()))
  const late = trial.status(one.taskId)
  try {
    await lookupStarted.promise
    assert.deepEqual(await cancelResult(await trial.cancel(trial.main, { cardId: 'first', jobIds: [one.jobId, two.jobId, foreign.jobId] })), {
      canceled: 1, upstreamUnconfirmed: 1,
    })
  } finally {
    result.resolve({ taskId: one.taskId, status: 'completed', stage: 'completed', videoUrl: '/static/videos/late.mp4' })
  }
  const lateResponse = await late
  assert.equal(lateResponse.status, 200)
  assert.equal(((await lateResponse.json()) as { data: { status: string } }).data.status, 'canceled')
  const current = (await trial.store.get(trial.projectId)).episodes[0]
  assert.deepEqual([current.cards[0].status, current.cards[0].videoUrl], ['ready', priorVideo])
  assert.equal(current.tasks.find((task: any) => task.id === one.jobId).status, 'canceled')
  assert.deepEqual([(await trial.store.getJob(trial.projectId, two.jobId)).status,
    (await trial.store.getJob(trial.projectId, foreign.jobId)).status], ['running', 'running'])
  const stopped = ((await (await trial.status(one.taskId)).json()) as { data: { status: string } }).data
  assert.equal(stopped.status, 'canceled')
  assert.equal(lookups, 1)

  const repeat = await trial.submit(trial.main, 'first', randomUUID())
  assert.equal(repeat.status, 409)
  assert.equal(((await repeat.json()) as { errorCode: string }).errorCode, 'SUBMISSION_UNKNOWN')
  assert.equal(launches, 3)
  await submitted(await trial.submit(trial.main, 'first', randomUUID(), true))
  assert.equal((await trial.store.getJob(trial.projectId, one.jobId)).code, 'SUBMISSION_UNKNOWN_ACKNOWLEDGED')
  assert.deepEqual(await cancelResult(await trial.cancel(trial.main, {})), { canceled: 2, upstreamUnconfirmed: 2 })
  assert.equal((await trial.store.getJob(trial.projectId, foreign.jobId)).status, 'running')
  assert.deepEqual(await cancelResult(await trial.cancel(trial.main, {})), { canceled: 0, upstreamUnconfirmed: 0 })
})

test('canceling the real enqueue reservation prevents the provider HTTP request', { timeout: 5_000 }, async t => {
  let fetches = 0
  const server = createServer((_request, response) => { fetches++; response.writeHead(500).end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const now = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({
    name: 'video-cancel', provider: 'volcengine', serviceType: 'video',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: 'test-only', model: JSON.stringify(['doubao-seedance-2-0-fast']), isActive: true, createdAt: now, updatedAt: now,
  }).returning({ id: schema.aiServiceConfigs.id }).get()
  const id = await generateVideo({
    configId: config.id, prompt: '测试画面', model: 'doubao-seedance-2-0-fast', duration: 5, aspectRatio: '16:9', resolution: '720p',
  }, {
    signal: new AbortController().signal,
    onTaskCreated(taskId) { assert.equal(cancelUnsubmittedVideoTask(taskId), true) },
  })
  while (isGenerationTaskActive(id)) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(fetches, 0)
  assert.equal(db.select({ status: schema.sysTask.status }).from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()?.status, 'canceled')
})
