import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ScriptVideoGenerationInput } from '../src/services/script-video-generation.js'
import type { ScriptVideoReferenceSettings } from '../src/services/script-video-reference-settings.js'

test('参考帧后台预处理、按时间替换、移除和恢复在预览、提交及无模型导出一致', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-frames-route-'))
  process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = root
  process.env.STORAGE_PATH = path.join(root, 'static')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const stores = new Set<InstanceType<typeof ScriptVideoStore>>()
  const getQueue = Object.getOwnPropertyDescriptor(ScriptVideoStore.prototype, 'queue')!.get!
  t.mock.getter(ScriptVideoStore.prototype, 'queue', function (this: InstanceType<typeof ScriptVideoStore>) {
    stores.add(this)
    return getQueue.call(this)
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const { db } = await import('../src/db/index.js')
  const store = new ScriptVideoStore(path.join(root, 'projects'))
  stores.add(store)
  t.after(async () => {
    await Promise.all([...stores].map(item => item.close()))
    db.$client.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  const videos = path.join(root, 'static/videos')
  await fs.mkdir(videos, { recursive: true })
  const ffmpeg = process.env.FFMPEG_BIN || createRequire(import.meta.url)('ffmpeg-static')
  execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=0x747474:s=160x90:r=12:d=2',
    '-vf', 'drawgrid=w=12:h=10:t=2:c=0x494949', '-c:v', 'libx264', path.join(videos, 'prior.mp4')])
  const videoUrl = '/static/videos/prior.mp4', newerUrl = '/static/videos/newer.mp4'
  await fs.copyFile(path.join(videos, 'prior.mp4'), path.join(videos, 'newer.mp4'))
  const { id } = await store.create('参考帧')
  const episodeId = await store.mutate(id, record => {
    const episode = record.project.episodes[0]
    episode.confirmed = true
    episode.confirmedScript = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
    const card = (id: string) => ({ id, title: id, scene: '外墙｜早晨', version: 2, status: 'draft', duration: 2,
      prompt: '小旗停步。', assetIds: [], shots: [{ id: id + '-1', duration: 2,
        camera: '平视固定', action: '小旗半抬右手扶住门闩。', dialogue: '无对白。' }] })
    episode.cards = [
      { ...card('prior'), status: 'ready', videoUrl, videoVersions: [{ url: videoUrl, duration: 2 }],
        ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' },
      { ...card('target'), opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' },
      card('after-gap'),
    ]
    return { documentChanged: true, result: episode.id }
  })
  const accepted: ScriptVideoGenerationInput[] = []
  const unused = () => { throw new Error('unexpected provider request') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
    reviewScriptVideoEpisode: unused, recoverVideoTask: unused,
    async getScriptVideoGeneration(taskId) { return { taskId, status: 'completed', stage: 'completed', videoUrl: '/static/videos/result.mp4' } },
    assertScriptVideoFormal() {},
    async startScriptVideoGeneration(input) {
      accepted.push(input)
      const { extractVideoReferenceFrame } = await import('../src/utils/video-reference-frame.js')
      const source = input.continuationSource!
      const imageUrl = await extractVideoReferenceFrame(source.videoUrl, source.manualSeconds!)
      assert.ok(imageUrl)
      return { taskId: 201, status: 'processing', lightingRanges: input.lightingRanges?.slice(), continuation: {
        previousCardId: source.previousCardId, previousVideoUrl: source.videoUrl, manualSeconds: source.manualSeconds,
        mode: 'reference', imageUrl,
      } }
    },
  })
  const base = '/projects/' + id + '/episodes/' + episodeId, framesRoute = '/cards/target/reference-frames'
  const post = (route: string, body: object) => app.request(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Script-Video-Session': '12345678-1234-4567-8234-123456789012' }, body: JSON.stringify(body) })
  async function read(route: string, body: object) {
    const response = await post(route, body)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).data
  }
  const settings = (value?: ScriptVideoReferenceSettings) => store.mutate(id, record => {
    const target = record.project.episodes[0].cards[1]
    if (value) target.referenceFrameSettings = value
    else delete target.referenceFrameSettings
    return { documentChanged: true, result: null }
  })
  const [auto, first] = await Promise.all([read(framesRoute, {}), read('/cards/prior/reference-frames', {})])
  assert.equal(first.tail.state, 'missing')
  assert.equal(first.tail.videoUrl, undefined)
  assert.equal(first.lighting[0].state, 'missing')
  assert.equal(first.lighting[0].videoUrl, undefined)
  assert.equal(auto.tail.state, 'ready')
  assert.equal(auto.lighting[0].state, 'ready')
  assert.equal(auto.tail.videoUrl, videoUrl)
  assert.equal(auto.tail.sourceLabel, '第 1 段')
  const gapRoute = '/cards/after-gap/reference-frames'
  async function assertEmptyGap() {
    const rows = await read(gapRoute, {})
    for (const row of [rows.tail, ...rows.lighting]) {
      assert.equal(row.state, 'missing')
      assert.equal(row.videoUrl, undefined, '第 2 段没有成片，第 3 段无可选来源')
      assert.equal(row.imageUrl, undefined)
      assert.equal(row.sourceLabel, undefined)
    }
    const final = await read('/final-prompt', { cardId: 'after-gap', cardVersion: 2 })
    assert.deepEqual(final.images, [])
    const delivery = await read('/continuations', { cardIds: ['after-gap'] })
    assert.deepEqual(delivery.continuations, {})
    assert.ok(delivery.lightingRanges['after-gap'].every((range: { imageUrl?: string }) => !range.imageUrl))
  }
  await assertEmptyGap()
  for (const kind of ['tail', 'lighting']) {
    const response = await post(gapRoute, { kind, ...(kind === 'lighting' && { startShot: 1 }), seconds: 0.25, expectedVideoUrl: videoUrl })
    assert.equal(response.status, 409)
  }
  await store.mutate(id, record => {
    const archivedChoice = { mode: 'manual', videoUrl, seconds: 0.25 }
    record.project.episodes[0].cards[2].referenceFrameSettings = { tail: archivedChoice, lighting: { '1': archivedChoice } }
    return { documentChanged: true, result: null }
  })
  await assertEmptyGap()
  const seek = { kind: 'tail', seconds: 0.25, expectedVideoUrl: videoUrl }
  const tail = (await read(framesRoute, seek)).candidate
  const light = (await read(framesRoute, { ...seek, kind: 'lighting', startShot: 1, seconds: 0.5 })).candidate
  assert.notEqual(tail.imageUrl, light.imageUrl)
  assert.equal((await post(framesRoute, { ...seek, expectedVideoUrl: newerUrl })).status, 409)
  assert.equal((await post(framesRoute, { ...seek, videoUrl: newerUrl })).status, 400)
  assert.equal((await post(framesRoute, { ...seek, seconds: 2 })).status, 422)
  await store.mutate(id, record => {
    const now = new Date().toISOString()
    record.jobs.push({ id: 'prior-remake', projectId: id, episodeId, cardId: 'prior', cardVersion: 2,
      action: 'video', status: 'queued', createdAt: now, updatedAt: now })
    return { result: null, recordChanged: true }
  })
  const waiting = await read(framesRoute, {})
  assert.deepEqual([waiting.tail.state, waiting.lighting[0].state], ['pending', 'pending'])
  assert.deepEqual([waiting.tail.videoUrl, waiting.lighting[0].videoUrl], [videoUrl, videoUrl])
  assert.deepEqual((await read(framesRoute, seek)).candidate, tail)
  await settings({ tail: { mode: 'off' }, lighting: { '1': { mode: 'off' } } })
  const off = await read(framesRoute, {})
  assert.equal(off.tail.state, 'off')
  assert.equal(off.lighting[0].state, 'off')
  assert.equal(off.lighting[0].videoUrl, videoUrl)
  assert.ok(!off.tail.imageUrl && !off.lighting[0].imageUrl)
  const exportedOff = await read('/continuations', { cardIds: ['target'] })
  assert.deepEqual(exportedOff.continuations, {})
  assert.ok(!exportedOff.lightingRanges.target[0].imageUrl)
  assert.match(exportedOff.lightingRanges.target[0].lighting, /散射光/u)
  const submit = () => post('/cards/target/video', { expectedCardVersion: 2, configId: 1,
    model: 'seedance2.5-ae-480p', aspectRatio: '16:9', resolution: '480p' })
  await settings({ tail: { mode: 'off' }, lighting: { '1': { mode: 'manual', videoUrl, seconds: 8 } } })
  const invalid = await submit()
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).errorCode, 'VALIDATION')
  assert.equal(accepted.length, 0)
  await store.mutate(id, record => {
    record.jobs.find(job => job.id === 'prior-remake')!.status = 'canceled'
    return { result: null, recordChanged: true }
  })
  await settings()
  assert.deepEqual(await read(framesRoute, {}), auto)
  await settings({ tail: { mode: 'manual', videoUrl, seconds: tail.seconds },
    lighting: { '1': { mode: 'manual', videoUrl, seconds: light.seconds } } })
  await store.mutate(id, record => {
    const prior = record.project.episodes[0].cards[0]
    prior.videoUrl = newerUrl
    prior.videoVersions.push({ url: newerUrl, duration: 2 })
    return { documentChanged: true, result: null }
  })
  const manual = await read(framesRoute, {})
  assert.deepEqual([manual.tail.imageUrl, manual.lighting[0].imageUrl], [tail.imageUrl, light.imageUrl])
  assert.equal(manual.tail.videoUrl, videoUrl)
  const preview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
  assert.deepEqual(new Set(preview.images.map((item: { url: string }) => item.url)), new Set([tail.imageUrl, light.imageUrl]))
  const exported = await read('/continuations', { cardIds: ['target'] })
  assert.equal(exported.continuations.target.imageUrl, tail.imageUrl)
  assert.equal(exported.lightingRanges.target[0].imageUrl, light.imageUrl)
  assert.equal((await post('/continuations', { cardIds: ['target'], configId: 123 })).status, 400)
  const submission = await submit()
  assert.equal(submission.status, 201, await submission.text())
  assert.equal(accepted.length, 1)
  assert.equal(accepted[0].continuationSource?.videoUrl, videoUrl)
  assert.equal(accepted[0].continuationSource?.manualSeconds, tail.seconds)
  assert.equal(accepted[0].lightingRanges?.[0]?.imageUrl, light.imageUrl)
  await settings({ tail: { mode: 'off' }, lighting: { '1': { mode: 'off' } } })
  assert.equal((await app.request('/projects/' + id + '/video/201')).status, 200)
  const finished = (await store.get(id)).episodes[0]
  const task = finished.tasks.find(item => item.taskId === 201)
  assert.equal(task?.continuation?.imageUrl, tail.imageUrl)
  assert.equal(task?.lightingRanges?.[0].imageUrl, light.imageUrl)
  assert.equal(finished.cards[1].status, 'ready')

  await store.mutate(id, record => {
    const target = record.project.episodes[0].cards[1]
    target.scene = ''
    target.opening = ''
    target.manuallyAdded = true
    delete target.referenceFrameSettings
    return { documentChanged: true, result: null }
  })
  const empty = await read(framesRoute, {})
  assert.deepEqual([empty.tail.state, empty.lighting[0].state], ['missing', 'missing'])
  assert.deepEqual([empty.tail.imageUrl, empty.lighting[0].imageUrl], [undefined, undefined])
  assert.deepEqual([empty.tail.videoUrl, empty.lighting[0].videoUrl], [newerUrl, newerUrl])
  const unselected = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
  assert.deepEqual(unselected.images, [])

  const manualTail = (await read(framesRoute, { ...seek, expectedVideoUrl: newerUrl })).candidate
  const manualStyle = (await read(framesRoute, { ...seek, expectedVideoUrl: newerUrl, kind: 'lighting', startShot: 1, seconds: 0.5 })).candidate
  await settings({ tail: { mode: 'manual', videoUrl: newerUrl, seconds: manualTail.seconds },
    lighting: { '1': { mode: 'manual', videoUrl: newerUrl, seconds: manualStyle.seconds } } })
  const selected = await read(framesRoute, {})
  assert.deepEqual([selected.tail.state, selected.lighting[0].state], ['ready', 'ready'])
  const manualPreview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
  assert.deepEqual(new Set(manualPreview.images.map((item: { url: string }) => item.url)), new Set([manualTail.imageUrl, manualStyle.imageUrl]))

  await store.mutate(id, record => {
    record.project.episodes[0].cards[1].shots = []
    return { documentChanged: true, result: null }
  })
  const freeformPreview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
  assert.match(freeformPreview.prompt, /全段「本片段」/u)
  assert.ok(freeformPreview.images.some((item: { url: string }) => item.url === manualStyle.imageUrl))
})
