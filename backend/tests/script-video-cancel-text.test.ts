import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate, setTimeout } from 'node:timers/promises'
import { test } from 'node:test'

test('canceling script-video text jobs aborts work, preserves committed content and permits a new job', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'drama-text-cancel-'))
  const keys = ['HUOBAO_DATA_DIR', 'SQLITE_PATH', 'MYSQL_AUTO_IMPORT'] as const
  const previous = keys.map(key => [key, process.env[key]] as const)
  Object.assign(process.env, {
    HUOBAO_DATA_DIR: directory, SQLITE_PATH: join(directory, 'test.sqlite3'), MYSQL_AUTO_IMPORT: 'false',
  })
  t.after(async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const store = new ScriptVideoStore(join(directory, 'projects'))
  const project = await store.create('文字编排取消')
  const production = { coreRhythm: '旧节奏', characters: [] }
  const original = {
    id: 'card-1', title: '开门', summary: '原分镜', duration: 12, prompt: '原提示词', version: 1, status: 'draft',
    assetIds: [], combat: false,
    shots: [{ duration: 12, camera: '中景', action: '甲推开门。', dialogue: '' }],
  }
  Object.assign(project.episodes[0], {
    script: '甲推开门。', confirmedScript: '甲推开门。', confirmed: true, outlineConfirmed: true,
    cards: [original], production,
  })
  await store.update(project.id, project, project.revision)
  const before = await store.get(project.id)
  const lateCard = { ...original, title: '迟到的结果', prompt: '取消后不应保存' }
  const lateOutline = { cards: [lateCard], skillReads: [], attempts: 1 }
  const actions = ['outline', 'storyboard', 'revisions', 'review'] as const
  const gates = Object.fromEntries(actions.map(action => [action, {
    started: Promise.withResolvers<AbortSignal>(), release: Promise.withResolvers<void>(),
  }])) as Record<typeof actions[number], { started: ReturnType<typeof Promise.withResolvers<AbortSignal>>; release: ReturnType<typeof Promise.withResolvers<void>> }>
  const delayed = async (action: typeof actions[number], signal?: AbortSignal) => {
    assert.ok(signal)
    gates[action].started.resolve(signal)
    await gates[action].release.promise
  }
  let fresh = false
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: async ({ signal }) => {
      if (!fresh) await delayed('outline', signal)
      return lateOutline
    },
    generateScriptVideoCards: async ({ signal }, _runner, options) => {
      const progress = { phase: 'generating' as const, completed: 1, total: 1 }
      const checkpoint = { cards: [lateCard], production }
      await options?.onProgress?.(progress, checkpoint)
      await delayed('storyboard', signal)
      await assert.rejects(async () => options?.onProgress?.(progress, checkpoint), { name: 'AbortError' })
      return { ...lateOutline, production }
    },
    reviseScriptVideoCard: async ({ signal }) => {
      await delayed('revisions', signal)
      return { card: lateCard, summary: '取消后不应出现', skillReads: [], attempts: 1 }
    },
    reviewScriptVideoEpisode: async ({ signal }) => {
      await delayed('review', signal)
      return { passed: true, issues: [], continuityReview: '取消后不应出现' }
    },
    assertScriptVideoFormal: () => 0,
    startScriptVideoGeneration: async () => { throw new Error('video must not start') },
    getScriptVideoGeneration: async () => { throw new Error('video must not be queried') },
    recoverVideoTask: async () => { throw new Error('video must not be recovered') },
  })
  const session = randomUUID()
  const projectPath = `/projects/${project.id}`
  const episodePath = `${projectPath}/episodes/${project.episodeId}`
  const post = (path: string, body?: object, owner = session) => app.request(path, {
    method: 'POST', headers: { 'X-Script-Video-Session': owner, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  assert.equal((await post(`${episodePath}/lock`, {})).status, 200)

  await store.mutate(project.id, ({ jobs }) => {
    const timestamp = new Date().toISOString()
    jobs.push({ id: 'queued-outline', projectId: project.id, episodeId: project.episodeId,
      action: 'outline', status: 'queued', createdAt: timestamp, updatedAt: timestamp })
    return { result: null }
  })
  const queued = await post(`${projectPath}/jobs/queued-outline/cancel`)
  assert.equal(queued.status, 200)
  assert.equal(((await queued.json()) as any).data.status, 'canceled')

  for (const action of actions) {
    const response = await post(`${episodePath}/${action}`, action === 'revisions' ? { cardId: original.id, instruction: '调整构图' } : {})
    assert.equal(response.status, 201)
    const { id } = ((await response.json()) as any).data
    const signal = await gates[action].started.promise
    const jobs = ((await (await app.request(`${projectPath}/jobs?episodeId=${project.episodeId}`)).json()) as any).data
    assert.equal(jobs.find((job: any) => job.id === id).status, 'running')
    const path = `${projectPath}/jobs/${id}/cancel`
    assert.equal(signal.aborted, false)
    const canceled = await post(path, undefined, randomUUID())
    assert.equal(canceled.status, 200)
    const stopped = ((await canceled.json()) as any).data
    assert.equal(stopped.status, 'canceled')
    assert.equal(stopped.code, 'CANCELED')
    assert.equal(signal.aborted, true)
    assert.deepEqual(((await (await post(path)).json()) as any).data, stopped)

    // These substitutes deliberately return a late result even though their signal was aborted.
    gates[action].release.resolve()
    await setImmediate()
    assert.deepEqual(await store.getJob(project.id, id), stopped)
    assert.deepEqual(await store.get(project.id), before)
  }

  fresh = true
  const response = await post(`${episodePath}/outline`, {})
  assert.equal(response.status, 201)
  const { id } = ((await response.json()) as any).data
  let completed = await store.getJob(project.id, id)
  for (let attempt = 0; completed.status !== 'completed' && attempt < 50; attempt++) {
    await setTimeout(10)
    completed = await store.getJob(project.id, id)
  }
  assert.equal(completed.status, 'completed')
  assert.deepEqual(((await (await post(`${projectPath}/jobs/${id}/cancel`)).json()) as any).data, completed)
  assert.equal((await store.get(project.id)).episodes[0].cards[0].title, lateCard.title)
})
