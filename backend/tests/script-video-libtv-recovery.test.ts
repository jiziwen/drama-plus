import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('LibTV 结果待确认时保留原任务查询能力，恢复接口实时确认且不重新提交', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-libtv-recovery-'))
  Object.assign(process.env, {
    SQLITE_PATH: path.join(root, 'test.sqlite3'), HUOBAO_DATA_DIR: root, MYSQL_AUTO_IMPORT: 'false',
  })
  const { db, schema } = await import('../src/db/index.js')
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const stores = new Set<InstanceType<typeof ScriptVideoStore>>()
  const queueGetter = Object.getOwnPropertyDescriptor(ScriptVideoStore.prototype, 'queue')!.get!
  t.mock.getter(ScriptVideoStore.prototype, 'queue', function (this: InstanceType<typeof ScriptVideoStore>) {
    stores.add(this)
    return queueGetter.call(this)
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const store = new ScriptVideoStore(path.join(root, 'projects'))
  t.after(async () => {
    await Promise.all([...stores].map(item => item.close()))
    db.$client.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const project = await store.create('LibTV 原任务查询')
  const episodeId = project.episodeId
  const timestamp = new Date().toISOString()
  await store.mutate(project.id, record => {
    const episode = record.project.episodes[0]
    for (const taskId of [101, 102, 103]) {
      const id = `job-${taskId}`
      episode.tasks.push({ id, taskId, status: 'failed', code: 'SUBMISSION_UNKNOWN',
        error: 'LibTV 等待超时', ...(taskId !== 101 && { canRecover: true }) })
      record.jobs.push({ id, taskId, projectId: project.id, episodeId, action: 'video', status: 'failed',
        videoProvider: 'libtv', code: 'SUBMISSION_UNKNOWN', error: 'LibTV 等待超时',
        createdAt: timestamp, updatedAt: timestamp, ...(taskId !== 101 && { canRecover: true }) })
    }
    return { result: null, documentChanged: true }
  })
  let queried: number[] = [], recovered: number[] = [], starts = 0
  const unavailable = () => { throw new Error('不可调用其他生成服务') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unavailable, generateScriptVideoCards: unavailable, reviewScriptVideoEpisode: unavailable,
    reviseScriptVideoCard: unavailable, assertScriptVideoFormal: unavailable,
    async startScriptVideoGeneration() { starts++; return { taskId: 999, status: 'processing' } },
    async getScriptVideoGeneration(taskId) {
      queried.push(taskId)
      if (taskId === 103) return { taskId, status: 'completed', stage: 'completed', videoUrl: '/static/videos/original.mp4' }
      return { taskId, status: 'failed', stage: 'polling', code: taskId === 101 ? 'SUBMISSION_UNKNOWN' : 'VIDEO_FAILED',
        error: taskId === 101 ? 'LibTV 原任务仍待确认' : 'LibTV 平台已确认失败', ...(taskId === 101 && { canRecover: true }) }
    },
    async recoverVideoTask(taskId) { recovered.push(taskId) },
  })
  const base = `/projects/${project.id}`
  const first = await app.request(`${base}/video/101`)
  assert.equal(first.status, 200)
  assert.equal((await first.json() as any).data.canRecover, true)
  const synced = await store.get(project.id)
  assert.equal(synced.episodes[0].tasks[0].canRecover, true, '旧结果待确认任务也应补上服务端恢复能力')
  assert.equal((await store.getVideoJob(project.id, 101)).canRecover, true)
  queried = []
  const denied = await app.request(`${base}/video/102/recover`, { method: 'POST' })
  assert.equal(denied.status, 409, '已失效的旧恢复标志不能绕过服务端实时检查')
  assert.deepEqual(recovered, [])
  const restored = await app.request(`${base}/video/101/recover`, { method: 'POST' })
  assert.equal(restored.status, 200, await restored.clone().text())
  assert.deepEqual(recovered, [101])
  assert.ok(queried.includes(101), '恢复时必须实时查询后端能力，不只读取旧任务标志')
  assert.equal(starts, 0, '只能恢复原任务，不创建新付费提交')
  const active = await store.getVideoJob(project.id, 101)
  assert.equal(active.taskId, 101)
  assert.equal(active.status, 'running')
  const alreadyCompleted = await app.request(`${base}/video/103/recover`, { method: 'POST' })
  assert.equal(alreadyCompleted.status, 200)
  assert.equal((await alreadyCompleted.json() as any).data.status, 'completed')
  assert.equal((await store.getVideoJob(project.id, 103)).status, 'completed')
  assert.deepEqual(recovered, [101], '原任务已经完成时直接显示成片，不再启动恢复或生成')

  const { getScriptVideoGeneration } = await import('../src/services/script-video-generation.js')
  const validNode = { projectId: '01322532-e5de-42a4-9549-5248fb705309', nodeKey: 'original-node' }
  for (const [provider, errorCode, taskId, node, recoverable] of [
    ['libtv', 'poll_timeout', 'original-node', validNode, true],
    ['libtv', 'recovery_failed', 'original-node', validNode, true],
    ['libtv', 'generation_failed', 'original-node', validNode, false],
    ['libtv', 'submission_not_sent', 'original-node', validNode, false],
    ['libtv', 'submission_unknown', null, validNode, false],
    ['libtv', 'submission_unknown', 'another-node', validNode, false],
    ['libtv', 'submission_unknown', 'original-node', { ...validNode, projectId: '../bad-project' }, false],
    ['jimeng', 'poll_timeout', 'original-node', validNode, false],
  ] as const) {
    const saved = db.insert(schema.sysTask).values({ type: 'video', provider, status: 'failed', stage: 'polling',
      errorCode, errorMsg: '模拟查询失败', taskId, params: JSON.stringify({ libtv: node }), createdAt: timestamp, updatedAt: timestamp }).returning().get()
    const state = await getScriptVideoGeneration(saved.id)
    assert.equal(state.canRecover === true, recoverable, `${provider}/${errorCode}/${taskId}`)
    if (recoverable) assert.equal(state.code, 'SUBMISSION_UNKNOWN')
  }
})
