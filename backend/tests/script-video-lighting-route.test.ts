import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import type { ScriptVideoGenerationInput } from '../src/services/script-video-generation.js'

test('换机位沿用就绪的原版成片，出片记下跳光镜号，下一段继续用最初的光线基准', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lighting-route-'))
  process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = root
  process.env.STORAGE_PATH = path.join(root, 'static')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const { db, schema } = await import('../src/db/index.js')
  t.after(async () => { db.$client.close(); await fs.rm(root, { recursive: true, force: true }) })

  const videos = path.join(root, 'static/videos')
  await fs.mkdir(videos, { recursive: true })
  const ffmpeg = process.env.FFMPEG_BIN || createRequire(import.meta.url)('ffmpeg-static')
  for (const [name, base, grid] of [['dark', '0x272727', '0x525252'], ['bright', '0xbdbdbd', '0xd8d8d8']]) {
    execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=' + base + ':s=160x90:r=12:d=2',
      '-vf', 'drawgrid=w=12:h=10:t=2:c=' + grid, '-c:v', 'libx264', path.join(videos, name + '.mp4')])
  }

  const store = new ScriptVideoStore(path.join(root, 'projects'))
  const { id } = await store.create('光线测试')
  const episodeId = await store.mutate(id, record => {
    const episode = record.project.episodes[0]
    episode.confirmed = true
    episode.confirmedScript = '场景：外廊\n时间：早晨\n天气/环境：廊下散射光\n场景：书房\n时间：早晨\n天气/环境：烛光'
    const single = '外廊｜早晨', multi = '场景一：外廊｜早晨；切换场景二：书房｜早晨'
    const card = (id: string, scene: string, actions: string[]) => ({
      id, scene, title: id, prompt: '两人停步。', assetIds: [], duration: actions.length * 2,
      shots: actions.map((action, i) => ({ id: id + i, duration: 2, camera: '平视固定', action, dialogue: '无对白。' })),
      version: 2, status: 'draft',
    })
    episode.cards = [
      { ...card('one', single, ['站在廊下。']), status: 'ready', videoUrl: '/static/videos/dark.mp4' },
      card('two', single, ['同场切镜，看向窗边。']),
      card('three', multi, ['同场切镜。', '画面切入书房。', '拿起纸笔。']),
    ]
    const old = { id: 'restored', cardId: 'one', taskId: 101, cardVersion: 1, status: 'completed' as const }
    episode.tasks = [{ ...old, videoUrl: '/static/videos/dark.mp4' }]
    const now = new Date().toISOString()
    record.jobs.push({ ...old, action: 'video', baseDigest: 'previous', projectId: id, episodeId: episode.id, createdAt: now, updatedAt: now })
    return { result: episode.id, documentChanged: true }
  })

  const accepted: ScriptVideoGenerationInput[] = []
  const unused = () => { throw new Error('unexpected call outside the video generation route') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
    reviewScriptVideoEpisode: unused, recoverVideoTask: unused,
    assertScriptVideoFormal() {},
    startScriptVideoGeneration: async (input: ScriptVideoGenerationInput) => {
      accepted.push(input)
      return { taskId: 101 + accepted.length, status: 'processing', lightingRanges: input.lightingRanges?.slice() }
    },
    getScriptVideoGeneration: async (taskId: number) => ({ taskId, status: 'completed', videoUrl: '/static/videos/bright.mp4' }),
  })
  const episodeRoute = '/projects/' + id + '/episodes/' + episodeId
  const headers = { 'Content-Type': 'application/json', 'X-Script-Video-Session': randomUUID() }
  const projectFile = path.join(root, 'projects', id + '.json')
  const snapshot = await fs.readFile(projectFile, 'utf8')
  const finalPrompt = (body: object) => app.request(episodeRoute + '/final-prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const promptResponse = await finalPrompt({ cardId: 'two', cardVersion: 2 })
  assert.equal(promptResponse.status, 200)
  assert.equal(promptResponse.headers.get('Cache-Control'), 'no-store')
  const { data: preview } = await promptResponse.json()
  assert.equal(preview.source, 'preview')
  assert.match(preview.prompt, /用@图片1参考同场人物受光/u)
  assert.deepEqual(preview.images.map(({ name, index, tag }) => [name, index, tag]), [['外廊光线参考图', 1, '@图片1']])
  assert.equal(await fs.readFile(projectFile, 'utf8'), snapshot)
  assert.equal((await finalPrompt({ cardId: 'two', cardVersion: 1 })).status, 409)
  assert.equal(accepted.length, 0)
  assert.equal((await app.request(episodeRoute + '/lock', { method: 'POST', headers })).status, 200)
  async function submit(cardId: string) {
    const response = await app.request(episodeRoute + '/cards/' + cardId + '/video', {
      method: 'POST', headers, body: JSON.stringify({ expectedCardVersion: 2, configId: 1, model: 'seedance2.5-ae-480p', aspectRatio: '16:9', resolution: '480p' }),
    })
    assert.equal(response.status, 201, await response.text())
  }
  await submit('two')
  const anchor = accepted[0].lightingRanges?.[0]?.imageUrl
  assert.ok(anchor)
  assert.equal(preview.images[0].url, anchor)
  assert.equal(accepted[0].continuationSource, undefined)
  assert.equal((await app.request('/projects/' + id + '/video/102')).status, 200)
  const firstResult = (await store.get(id)).episodes[0]
  assert.deepEqual(firstResult.tasks.find(task => task.taskId === 102).lightingReviewShots, [1])
  assert.deepEqual(firstResult.cards.slice(0, 2).map(card => card.status), ['ready', 'ready'])
  const task = firstResult.tasks.find(task => task.taskId === 102)
  db.insert(schema.sysTask).values({
    id: 102, type: 'video', provider: 'aicost', model: 'seedance2.5-ae-480p', prompt: preview.prompt,
    params: JSON.stringify({ referenceImageUrls: [anchor] }), createdAt: task.createdAt, updatedAt: task.createdAt,
  }).run()
  const actual = await finalPrompt({ cardId: 'two', jobId: task.id })
  assert.equal(actual.status, 200)
  assert.deepEqual((await actual.json()).data, { ...preview, source: 'submitted' })
  assert.equal((await finalPrompt({ cardId: 'one', jobId: task.id })).status, 404)
  await submit('three')
  assert.deepEqual(accepted[1].lightingRanges?.map(r => [r.startShot, r.endShot, r.imageUrl, r.transitionIn]), [
    [1, 1, anchor, undefined], [2, 3, undefined, true],
  ])
})
