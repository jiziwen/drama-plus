import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { latestScriptVideoTaskUrls, officialScriptVideoUrl, selectScriptVideoPlayback } from '../src/services/script-video-versions.js'
import type { ScriptVideoReferenceSettings } from '../src/services/script-video-reference-settings.js'

test('相邻段因输入变化只保留历史成片时，下一段仍可明确手选参考帧', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'historical-reference-frames-'))
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
    '-vf', 'drawgrid=w=12:h=10:t=2:c=0x494949', '-c:v', 'libx264', path.join(videos, 'historical.mp4')])
  const historyUrl = '/static/videos/historical.mp4', missingUrl = '/static/videos/missing.mp4'
  const { id } = await store.create('历史成片选帧')
  const episodeId = await store.mutate(id, record => {
    const episode = record.project.episodes[0]
    episode.confirmed = true
    episode.confirmedScript = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
    const card = (id: string) => ({ id, title: id, scene: '外墙｜早晨', version: 2, status: 'draft', duration: 2,
      prompt: '小旗停步。', assetIds: [], shots: [{ id: id + '-1', duration: 2,
        camera: '平视固定', action: '小旗半抬右手扶住门闩。', dialogue: '无对白。' }] })
    episode.cards = [
      { ...card('prior'), ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' },
      { ...card('target'), opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' },
      card('after-gap'),
    ]
    const now = new Date().toISOString()
    episode.tasks = [{ id: 'historical-job', cardId: 'prior', cardVersion: 1, taskId: 101, duration: 2,
      status: 'completed', staleResult: true, videoUrl: historyUrl, createdAt: now }]
    record.jobs.push({ id: 'historical-job', projectId: id, episodeId: episode.id, cardId: 'prior', cardVersion: 1,
      taskId: 101, action: 'video', status: 'completed', staleResult: true, videoDuration: 2, createdAt: now, updatedAt: now })
    return { documentChanged: true, result: episode.id }
  })
  const unused = () => { throw new Error('读取参考帧不应调用模型或生成服务') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
    reviewScriptVideoEpisode: unused, recoverVideoTask: unused,
    getScriptVideoGeneration: unused, startScriptVideoGeneration: unused, assertScriptVideoFormal() {},
  })
  const base = '/projects/' + id + '/episodes/' + episodeId, framesRoute = '/cards/target/reference-frames'
  const headers = { 'Content-Type': 'application/json', 'X-Script-Video-Session': '12345678-1234-4567-8234-123456789012' }
  const post = (route: string, body: object = {}) => app.request(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
  async function read(route: string, body: object = {}) {
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

  await t.test('界面能播放的相邻历史视频成为手选来源，但不会自动充当正式成片', async () => {
    const episode = (await store.get(id)).episodes[0]
    const previous = episode.cards[0]
    assert.equal(previous.status, 'draft')
    assert.equal(previous.videoUrl, undefined)
    assert.equal(previous.videoVersions?.length || 0, 0)
    assert.equal(officialScriptVideoUrl(previous), undefined)
    assert.deepEqual(selectScriptVideoPlayback(previous, latestScriptVideoTaskUrls(episode.tasks).get(previous.id)), {
      kind: 'previous', url: historyUrl,
    })
    const frames = await read(framesRoute)
    for (const row of [frames.tail, frames.lighting[0]]) {
      assert.equal(row.state, 'missing')
      assert.equal(row.imageUrl, undefined)
      assert.equal(row.videoUrl, historyUrl, '历史成片可供手选，不能显示“暂无可选成片”')
      assert.equal(row.sourceLabel, '第 1 段')
    }
    const preview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
    assert.deepEqual(preview.images, [], '自动模式不接受尚未选中的过期历史视频')
    const exported = await read('/continuations', { cardIds: ['target'] })
    assert.deepEqual(exported.continuations, {})
    assert.ok(exported.lightingRanges.target.every((range: { imageUrl?: string }) => !range.imageUrl))
  })

  await t.test('历史成片按时间取帧并保存手选后，提示词预览和导出引用一致', async () => {
    const tail = (await read(framesRoute, { kind: 'tail', seconds: 0.25, expectedVideoUrl: historyUrl })).candidate
    const light = (await read(framesRoute, { kind: 'lighting', startShot: 1, seconds: 0.5, expectedVideoUrl: historyUrl })).candidate
    assert.equal(tail.videoUrl, historyUrl)
    assert.equal(light.videoUrl, historyUrl)
    assert.notEqual(tail.imageUrl, light.imageUrl)
    await settings({ tail: { mode: 'manual', videoUrl: historyUrl, seconds: tail.seconds },
      lighting: { '1': { mode: 'manual', videoUrl: historyUrl, seconds: light.seconds } } })
    const frames = await read(framesRoute)
    assert.deepEqual([frames.tail.state, frames.lighting[0].state], ['ready', 'ready'])
    assert.deepEqual([frames.tail.imageUrl, frames.lighting[0].imageUrl], [tail.imageUrl, light.imageUrl])
    const preview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
    assert.deepEqual(new Set(preview.images.map((item: { url: string }) => item.url)), new Set([tail.imageUrl, light.imageUrl]))
    const exported = await read('/continuations', { cardIds: ['target'] })
    assert.equal(exported.continuations.target.previousCardId, 'prior')
    assert.equal(exported.continuations.target.imageUrl, tail.imageUrl)
    assert.equal(exported.lightingRanges.target[0].imageUrl, light.imageUrl)
    assert.equal(officialScriptVideoUrl((await store.get(id)).episodes[0].cards[0]), undefined, '手选参考不应顺带把历史设为正式成片')
    await settings()
  })

  await t.test('正式视频和最新历史文件已丢失时，手选来源回退到相邻段仍可读取的历史', async () => {
    await settings()
    await store.mutate(id, record => {
      const episode = record.project.episodes[0]
      episode.cards[0].status = 'ready'
      episode.cards[0].videoUrl = missingUrl
      episode.cards[0].videoVersions = [{ url: missingUrl, duration: 2 }]
      const now = new Date().toISOString()
      episode.tasks.push({ id: 'missing-history', cardId: 'prior', cardVersion: 1, taskId: 102, duration: 2,
        status: 'completed', staleResult: true, videoUrl: '/static/videos/newest-missing.mp4', createdAt: now })
      record.jobs.push({ id: 'missing-history', projectId: id, episodeId, cardId: 'prior', cardVersion: 1,
        taskId: 102, action: 'video', status: 'completed', staleResult: true, videoDuration: 2, createdAt: now, updatedAt: now })
      return { documentChanged: true, result: null }
    })
    const frames = await read(framesRoute)
    for (const row of [frames.tail, frames.lighting[0]]) {
      assert.equal(row.imageUrl, undefined)
      assert.equal(row.videoUrl, historyUrl, '跳过丢失文件，找到该相邻段仍存在的历史视频')
      assert.equal(row.sourceLabel, '第 1 段')
    }
    const selected = await read(framesRoute, { kind: 'tail', seconds: 0.75, expectedVideoUrl: historyUrl })
    assert.equal(selected.candidate.videoUrl, historyUrl)
    assert.ok(selected.candidate.imageUrl)
  })

  await t.test('有历史成片的更早片段不能越过没有视频的相邻段充当手选来源', async () => {
    const rows = await read('/cards/after-gap/reference-frames')
    for (const row of [rows.tail, ...rows.lighting]) {
      assert.equal(row.videoUrl, undefined)
      assert.equal(row.imageUrl, undefined)
    }
  })

  await t.test('只有版本归档、没有当前视频和任务记录时仍可手选，自动参考不提升历史', async () => {
    await store.mutate(id, record => {
      const episode = record.project.episodes[0]
      const previous = episode.cards[0]
      previous.status = 'draft'
      delete previous.videoUrl
      previous.videoVersions = [{ url: historyUrl, duration: 2 }]
      episode.tasks = []
      record.jobs = []
      return { documentChanged: true, result: null }
    })
    const frames = await read(framesRoute)
    for (const row of [frames.tail, frames.lighting[0]]) {
      assert.equal(row.state, 'missing')
      assert.equal(row.imageUrl, undefined)
      assert.equal(row.videoUrl, historyUrl)
      assert.equal(row.sourceLabel, '第 1 段')
    }
    const selected = await read(framesRoute, { kind: 'lighting', startShot: 1, seconds: 0.5, expectedVideoUrl: historyUrl })
    assert.equal(selected.candidate.videoUrl, historyUrl)
    assert.ok(selected.candidate.imageUrl)
    const preview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
    assert.deepEqual(preview.images, [])
    const exported = await read('/continuations', { cardIds: ['target'] })
    assert.deepEqual(exported.continuations, {})
    assert.ok(exported.lightingRanges.target.every((range: { imageUrl?: string }) => !range.imageUrl))
    assert.equal(officialScriptVideoUrl((await store.get(id)).episodes[0].cards[0]), undefined)
  })

  await t.test('下一集首段可手选上一集末段仅存在于任务记录的历史，自动参考保持未选状态', async () => {
    const nextEpisodeId = await store.mutate(id, record => {
      const previous = record.project.episodes[0]
      const target = structuredClone(previous.cards[1])
      previous.cards = [previous.cards[0]]
      delete previous.cards[0].videoVersions
      const now = new Date().toISOString()
      previous.tasks = [{ id: 'cross-history', cardId: 'prior', cardVersion: 1, taskId: 103, duration: 2,
        status: 'completed', staleResult: true, videoUrl: historyUrl, createdAt: now }]
      record.jobs.push({ id: 'cross-history', projectId: id, episodeId, cardId: 'prior', cardVersion: 1,
        taskId: 103, action: 'video', status: 'completed', staleResult: true, videoDuration: 2, createdAt: now, updatedAt: now })
      const next = { ...structuredClone(previous), id: 'historical-next-episode', title: '下一集', number: 2, tasks: [], cards: [target] }
      record.project.episodes.push(next)
      return { documentChanged: true, result: next.id }
    })
    async function readNext(route: string, body: object = {}) {
      const response = await app.request('/projects/' + id + '/episodes/' + nextEpisodeId + route, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      assert.equal(response.status, 200, await response.clone().text())
      return (await response.json()).data
    }
    const frames = await readNext(framesRoute)
    for (const row of [frames.tail, frames.lighting[0]]) {
      assert.equal(row.state, 'missing')
      assert.equal(row.imageUrl, undefined)
      assert.equal(row.videoUrl, historyUrl)
      assert.equal(row.sourceLabel, '上一集 · 第 1 段')
    }
    const preview = await readNext('/final-prompt', { cardId: 'target', cardVersion: 2 })
    assert.deepEqual(preview.images, [])
    const exported = await readNext('/continuations', { cardIds: ['target'] })
    assert.deepEqual(exported.continuations, {})
    assert.ok(exported.lightingRanges.target.every((range: { imageUrl?: string }) => !range.imageUrl))
    const tail = (await readNext(framesRoute, { kind: 'tail', seconds: 0.25, expectedVideoUrl: historyUrl })).candidate
    const light = (await readNext(framesRoute, { kind: 'lighting', startShot: 1, seconds: 0.5, expectedVideoUrl: historyUrl })).candidate
    await store.mutate(id, record => {
      record.project.episodes.find(episode => episode.id === nextEpisodeId).cards[0].referenceFrameSettings = {
        tail: { mode: 'manual', videoUrl: historyUrl, seconds: tail.seconds },
        lighting: { '1': { mode: 'manual', videoUrl: historyUrl, seconds: light.seconds } },
      }
      return { documentChanged: true, result: null }
    })
    const selected = await readNext(framesRoute)
    assert.deepEqual([selected.tail.state, selected.lighting[0].state], ['ready', 'ready'])
    assert.deepEqual([selected.tail.imageUrl, selected.lighting[0].imageUrl], [tail.imageUrl, light.imageUrl])
    assert.equal(officialScriptVideoUrl((await store.get(id)).episodes[0].cards[0]), undefined)
  })
})
