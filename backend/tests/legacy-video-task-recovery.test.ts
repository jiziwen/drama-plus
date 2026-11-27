import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'

test('legacy task reads resume only the displayed video tasks by their original IDs', { timeout: 8000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'legacy-video-task-recovery-'))
  const env = {
    SQLITE_PATH: path.join(root, 'tasks.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: path.join(root, 'static'),
    MYSQL_AUTO_IMPORT: 'false',
  }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  const { db, schema } = await import('../src/db/index.js')
  t.after(async () => {
    db.$client.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const { default: taskRoutes } = await import('../src/routes/tasks.js')
  const { default: episodeRoutes } = await import('../src/routes/episodes.js')
  const baseUrl = 'https://video-provider.example.test'
  const queried: string[] = []
  t.mock.method(globalThis, 'fetch', async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(request))
    assert.equal(url.origin, baseUrl)
    assert.equal(init?.method, 'GET')
    const key = url.pathname.match(/^\/v2\/query\/video_generation\/([^/]+)$/u)?.[1]
    assert.ok(key, url.pathname)
    queried.push(key)
    return Response.json({ task: { id: key, status: 'failed', error: '上游已确认失败' } })
  })

  const recordedAt = new Date(Date.now() - 60 * 60_000).toISOString()
  const times = { createdAt: recordedAt, updatedAt: recordedAt }
  const config = db.insert(schema.aiServiceConfigs).values({
    serviceType: 'video', provider: 'minimax', name: 'fixture', baseUrl, apiKey: 'fixture', model: '["MiniMax-H3"]', ...times,
  }).returning().get()
  const drama = db.insert(schema.dramas).values({ title: '原视频任务', ...times }).returning().get()
  const episode = (number: number) => db.insert(schema.episodes).values({
    dramaId: drama.id, episodeNumber: number, title: '分集', ...times,
  }).returning().get().id
  const storyboard = (episodeId: number, storyboardNumber: number) => db.insert(schema.storyboards)
    .values({ episodeId, storyboardNumber, ...times }).returning().get().id
  const firstEpisode = episode(1)
  const first = storyboard(firstEpisode, 1)
  const second = storyboard(firstEpisode, 2)
  const third = storyboard(episode(2), 1)
  const seed = (taskId: string, storyboardId: number, type = 'video', errorCode = 'poll_timeout') =>
    db.insert(schema.sysTask).values({
      type, dramaId: drama.id, storyboardId, provider: 'minimax', configId: config.id, configBaseUrl: baseUrl,
      taskId, stage: 'polling', status: 'failed', errorCode, errorMsg: '查询中断', ...times,
    }).returning().get().id
  const historical = seed('historical', first)
  const current = seed('current', first)
  const episodeTask = seed('episode', second)
  const terminal = seed('terminal', storyboard(firstEpisode, 3), 'video', 'generation_failed')
  const image = seed('image', first, 'image')
  const otherEpisode = seed('other-episode', third)
  const read = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
  const waitForStatus = async (id: number, errorCode: string) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && read(id).errorCode !== errorCode) await delay(5)
    assert.equal(read(id).errorCode, errorCode)
  }

  assert.equal((await taskRoutes.request('/')).status, 200)
  assert.deepEqual(queried, [])
  assert.equal((await taskRoutes.request(`/?type=video&storyboard_id=${first}`)).status, 200)
  await waitForStatus(current, 'generation_failed')
  assert.deepEqual(queried, ['current'])
  assert.equal((await episodeRoutes.request(`/${firstEpisode}/generation-tasks`)).status, 200)
  await waitForStatus(episodeTask, 'generation_failed')
  assert.deepEqual(queried, ['current', 'episode'])
  assert.equal((await taskRoutes.request(`/${otherEpisode}`)).status, 200)
  await waitForStatus(otherEpisode, 'generation_failed')
  assert.deepEqual(queried, ['current', 'episode', 'other-episode'])
  assert.equal(read(historical).errorCode, 'poll_timeout')
  assert.equal(read(image).errorCode, 'poll_timeout')
  assert.equal(read(terminal).errorCode, 'generation_failed')
})
