import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ScriptVideoGenerationStatus } from '../src/services/script-video-generation.js'

test('reopening an episode checks a timed-out original video and attaches its late result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-video-recovery-'))
  const oldPath = process.env.SQLITE_PATH
  const oldData = process.env.HUOBAO_DATA_DIR
  const oldImport = process.env.MYSQL_AUTO_IMPORT
  process.env.SQLITE_PATH = join(directory, 'tasks.sqlite3')
  process.env.HUOBAO_DATA_DIR = directory
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { db } = await import('../src/db/index.js')
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const { createScriptVideoRoutes, scriptVideoStore } = await import('../src/routes/script-video.js')
  const store = new ScriptVideoStore(join(directory, 'projects'))
  t.after(async () => {
    await store.close()
    await scriptVideoStore.close()
    db.$client.close()
    for (const [key, previous] of Object.entries({ SQLITE_PATH: oldPath, HUOBAO_DATA_DIR: oldData, MYSQL_AUTO_IMPORT: oldImport })) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
    await rm(directory, { recursive: true, force: true })
  })
  let project = await store.create('隔夜成片')
  const episode = project.episodes[0]
  episode.script = episode.confirmedScript = '甲推开门。'
  episode.confirmed = episode.outlineConfirmed = true
  episode.cards = [{ id: 'card-1', title: '开门', prompt: '甲推开门', duration: 5,
    shots: [], assetIds: [], status: 'draft', version: 1, manuallyAdded: true }]
  project = await store.update(project.id, project, project.revision)
  const taskId = 312
  let submissions = 0
  let state: ScriptVideoGenerationStatus = { taskId, status: 'failed', stage: 'polling', code: 'VIDEO_FAILED', error: 'Timeout' }
  const checkedOriginal: number[] = []
  const unused = () => { throw new Error('unexpected generation') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviewScriptVideoEpisode: unused,
    reviseScriptVideoCard: unused, assertScriptVideoFormal: () => 0, recoverVideoTask: unused,
    startScriptVideoGeneration: async () => { submissions++; return { taskId, status: 'processing' } },
    getScriptVideoGeneration: async (id, options) => {
      if (options?.resumeOriginal) checkedOriginal.push(id)
      return state
    },
  })
  const root = `/projects/${project.id}/episodes/${episode.id}`
  const post = (route: string, body: object) => app.request(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Script-Video-Session': session }, body: JSON.stringify(body),
  })
  const session = randomUUID()
  assert.equal((await post(`${root}/lock`, {})).status, 200)
  const started = await post(`${root}/cards/card-1/video`, { expectedCardVersion: 1, configId: 1, model: 'fixture', aspectRatio: '16:9', resolution: '480P' })
  assert.equal(started.status, 201, await started.clone().text())
  await app.request(`/projects/${project.id}/video/${taskId}`)
  assert.equal((await store.getVideoJob(project.id, taskId)).status, 'failed')
  checkedOriginal.length = 0

  state = { taskId, status: 'processing', stage: 'polling' }
  assert.equal((await app.request(root)).status, 200)
  assert.deepEqual(checkedOriginal, [taskId])
  assert.equal((await store.getVideoJob(project.id, taskId)).status, 'running')

  const videoUrl = '/static/videos/overnight.mp4'
  state = { taskId, status: 'completed', stage: 'completed', videoUrl }
  assert.equal((await app.request(`${root}/activity`)).status, 200)
  const { episode: reopened } = await store.episode(project.id, episode.id)
  assert.equal(reopened.cards[0].videoUrl, videoUrl)
  assert.equal(reopened.tasks[0].status, 'completed')
  assert.equal(reopened.tasks[0].error, undefined)
  assert.equal(submissions, 1)
})
