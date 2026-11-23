import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ScriptVideoGenerationInput } from '../src/services/script-video-generation.js'

test('任意片段手选全项目各集成片，自动来源仍限原相邻片段', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'all-episode-frames-'))
  Object.assign(process.env, { SQLITE_PATH: path.join(root, 'test.sqlite3'), HUOBAO_DATA_DIR: root,
    STORAGE_PATH: path.join(root, 'static'), MYSQL_AUTO_IMPORT: 'false' })
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const stores = new Set<InstanceType<typeof ScriptVideoStore>>()
  const getQueue = Object.getOwnPropertyDescriptor(ScriptVideoStore.prototype, 'queue')!.get!
  t.mock.getter(ScriptVideoStore.prototype, 'queue', function (this: InstanceType<typeof ScriptVideoStore>) {
    stores.add(this); return getQueue.call(this)
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const { scriptVideoOpeningImage } = await import('../src/services/script-video-generation.js')
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
    '-vf', 'drawgrid=w=12:h=10:t=2:c=0x494949', '-c:v', 'libx264', path.join(videos, 'before.mp4')])
  for (const name of ['old', 'future', 'self', 'historical', 'foreign', 'result'])
    await fs.copyFile(path.join(videos, 'before.mp4'), path.join(videos, name + '.mp4'))
  const url = (name: string) => '/static/videos/' + name + '.mp4'
  const { id } = await store.create('所有集手动选帧')
  const { episodeId, oldId, futureId } = await store.mutate(id, record => {
    const template = record.project.episodes[0]
    const card = (id: string, video?: string) => ({ id, title: id, scene: '外墙｜早晨', version: 2,
      status: video ? 'ready' : 'draft', ...(video && { videoUrl: video }), duration: 2,
      prompt: '小旗停步。', assetIds: [], shots: [{ id: id + '-1', duration: 2,
        camera: '平视固定', action: '小旗半抬右手扶住门闩。', dialogue: '无对白。' }] })
    template.number = 1
    template.confirmed = true
    template.confirmedScript = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
    template.cards = [card('old-source', url('old'))]
    const current = { ...structuredClone(template), id: 'current-episode', number: 2, title: '第二集', cards: [
      { ...card('before', url('before')), ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' },
      { ...card('target', url('self')), opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' },
      card('same-episode-history'),
      card('unrendered'),
      card('after-gap'),
    ] }
    current.tasks = [{ id: 'historical', cardId: 'same-episode-history', cardVersion: 1, status: 'completed',
      staleResult: true, videoUrl: url('historical'), duration: 2 }]
    const future = { ...structuredClone(template), id: 'future-episode', number: 3, title: '第三集',
      cards: [card('future-source', url('future')), card('missing-source', url('missing'))], tasks: [] }
    const empty = { ...structuredClone(template), id: 'empty-episode', number: 4, cards: [] }
    const later = { ...structuredClone(template), id: 'later-episode', number: 5, cards: [card('later-target')] }
    record.project.episodes.push(current, future, empty, later)
    return { documentChanged: true, result: { episodeId: current.id, oldId: template.id, futureId: future.id } }
  })
  const foreignProject = await store.create('外部项目不可作来源')
  await store.mutate(foreignProject.id, record => {
    record.project.episodes[0].cards = [{ id: 'foreign-source', title: '外部成片', version: 1,
      status: 'ready', videoUrl: url('foreign'), duration: 2, prompt: '外部', assetIds: [], shots: [] }]
    return { documentChanged: true, result: null }
  })
  const accepted: ScriptVideoGenerationInput[] = []
  const unused = () => { throw new Error('不应调用文本生成或真实视频服务') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
    reviewScriptVideoEpisode: unused, recoverVideoTask: unused, assertScriptVideoFormal() {},
    async getScriptVideoGeneration(taskId) {
      return { taskId, status: 'completed', stage: 'completed', videoUrl: url('result') }
    },
    async startScriptVideoGeneration(input) {
      accepted.push(input)
      const source = input.continuationSource!
      const imageUrl = await scriptVideoOpeningImage(source)
      assert.ok(imageUrl)
      return { taskId: 500 + accepted.length, status: 'processing', lightingRanges: input.lightingRanges?.slice(),
        continuation: { previousCardId: source.previousCardId, previousEpisodeId: source.sourceEpisodeId,
          previousTaskId: source.previousTaskId, previousVideoUrl: source.videoUrl,
          manualSeconds: source.manualSeconds, mode: 'reference', imageUrl } }
    },
  })
  const headers = { 'Content-Type': 'application/json', 'X-Script-Video-Session': '12345678-1234-4567-8234-123456789012' }
  const post = (route: string, body: object = {}, ep = episodeId) => app.request(`/projects/${id}/episodes/${ep}${route}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
  const read = async (route: string, body: object = {}, ep = episodeId) => {
    const response = await post(route, body, ep)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).data
  }
  const framesRoute = '/cards/target/reference-frames'
  const initial = await read(framesRoute)
  assert.deepEqual(initial.projectSources.map((source: any) => [source.sourceEpisodeId, source.cardId]), [
    [oldId, 'old-source'], [episodeId, 'before'], [episodeId, 'target'],
    [episodeId, 'same-episode-history'], [futureId, 'future-source'],
  ])
  assert.deepEqual(initial.previousPlayableSource, initial.projectSources[1])
  const afterGap = await read('/cards/after-gap/reference-frames')
  assert.deepEqual(afterGap.previousPlayableSource, initial.projectSources[3], '跳过未出片的上一段，也能定位到有历史成片的段')
  const later = await read('/cards/later-target/reference-frames', {}, 'later-episode')
  assert.deepEqual(later.previousPlayableSource, initial.projectSources[4], '上一集为空时继续跨集回退，并跳过不可读的成片')
  const first = await read('/cards/old-source/reference-frames', {}, oldId)
  assert.equal(first.previousPlayableSource, undefined, '开篇无上一段时不定位自己的成片或后续分集')
  assert.match(initial.projectSources[0].sourceLabel, /第\s*1\s*集.*第\s*1\s*段.*old-source/u)
  assert.equal(initial.tail.videoUrl, url('before'))
  assert.equal(initial.tail.sourceCardId, 'before')
  assert.equal(initial.lighting[0].videoUrl, url('before'))
  for (const source of initial.projectSources) {
    const candidate = (await read(framesRoute, { kind: 'tail', seconds: 0.25,
      sourceCardId: source.cardId, sourceEpisodeId: source.sourceEpisodeId, expectedVideoUrl: source.videoUrl })).candidate
    assert.equal(candidate.sourceEpisodeId, source.sourceEpisodeId)
    assert.equal(candidate.videoUrl, source.videoUrl)
    assert.ok(candidate.imageUrl)
  }
  await store.mutate(id, record => {
    for (const [sourceEpisodeId, taskId] of [[oldId, 301], [futureId, 302]] as const) {
      const episode = record.project.episodes.find(episode => episode.id === sourceEpisodeId)
      episode.cards.push({ ...structuredClone(episode.cards[0]), id: 'duplicate-source', title: '同名片段', videoUrl: url('old') })
      episode.tasks ||= []
      episode.tasks.push({ id: 'duplicate-' + taskId, cardId: 'duplicate-source', taskId,
        status: 'completed', videoUrl: url('old') })
    }
    const original = record.project.episodes.find(episode => episode.id === episodeId).cards[0]
    record.project.episodes.find(episode => episode.id === oldId).cards.push(structuredClone(original))
    return { documentChanged: true, result: null }
  })
  const afterDuplicate = await read(framesRoute)
  assert.equal(afterDuplicate.tail.sourceEpisodeId, episodeId, '自动尾帧仍定位真实相邻段，不能跳到同ID同视频的更早集')
  assert.equal(afterDuplicate.lighting[0].sourceEpisodeId, episodeId, '自动风格参考也保持原相邻集段归属')
  const duplicateSources = afterDuplicate.projectSources.filter((source: any) => source.cardId === 'duplicate-source')
  assert.deepEqual(duplicateSources.map((source: any) => source.sourceEpisodeId), [oldId, futureId],
    '两个分集具有相同片段ID与视频时，来源目录仍保留各自所属集')
  for (const source of duplicateSources) {
    const candidate = (await read(framesRoute, { kind: 'tail', seconds: 0.25,
      sourceCardId: source.cardId, sourceEpisodeId: source.sourceEpisodeId, expectedVideoUrl: source.videoUrl })).candidate
    assert.equal(candidate.sourceEpisodeId, source.sourceEpisodeId)
  }
  const wrongEpisode = await post(framesRoute, { kind: 'tail', seconds: 0.25,
    sourceCardId: 'duplicate-source', sourceEpisodeId: episodeId, expectedVideoUrl: url('old') })
  assert.equal(wrongEpisode.status, 409, '片段和视频必须属于明确选择的分集')
  const rejected = await post(framesRoute, { kind: 'tail', seconds: 0.25, sourceCardId: 'foreign-source',
    sourceEpisodeId: foreignProject.episodeId, expectedVideoUrl: url('foreign') })
  assert.equal(rejected.status, 409)
  const tail = (await read(framesRoute, { kind: 'tail', seconds: 0.25,
    sourceCardId: 'future-source', sourceEpisodeId: futureId, expectedVideoUrl: url('future') })).candidate
  const light = (await read(framesRoute, { kind: 'lighting', startShot: 1, seconds: 0.5,
    sourceCardId: 'old-source', sourceEpisodeId: oldId, expectedVideoUrl: url('old') })).candidate
  const choice = (frame: any) => ({ mode: 'manual', videoUrl: frame.videoUrl, seconds: frame.seconds,
    sourceCardId: frame.sourceCardId, sourceEpisodeId: frame.sourceEpisodeId })
  const patched = await app.request(`/projects/${id}/changes`, { method: 'PATCH', headers,
    body: JSON.stringify({ clientId: 'all-episode-picker', sequence: 1, loadedEpisodeIds: [episodeId], changes: [
      { target: 'card', episodeId, id: 'target', fields: { referenceFrameSettings: {
        tail: choice(tail), lighting: { '1': choice(light) },
      } } },
    ] }) })
  assert.equal(patched.status, 200, await patched.clone().text())
  const manual = await read(framesRoute)
  assert.deepEqual(manual.previousPlayableSource, initial.previousPlayableSource)
  assert.equal(manual.tail.imageUrl, tail.imageUrl)
  assert.equal(manual.tail.sourceEpisodeId, futureId)
  assert.match(manual.tail.sourceLabel, /第\s*3\s*集/u)
  assert.equal(manual.lighting[0].imageUrl, light.imageUrl)
  const exported = await read('/continuations', { cardIds: ['target'] })
  assert.equal(exported.continuations.target.imageUrl, tail.imageUrl)
  assert.equal(exported.continuations.target.previousEpisodeId, futureId)
  assert.equal(exported.lightingRanges.target[0].imageUrl, light.imageUrl)
  const preview = await read('/final-prompt', { cardId: 'target', cardVersion: 2 })
  assert.deepEqual(new Set(preview.images.map((image: any) => image.url)), new Set([tail.imageUrl, light.imageUrl]))
  const submit = () => post('/cards/target/video', { expectedCardVersion: 2, configId: 1,
    model: 'seedance2.5-ae-480p', aspectRatio: '16:9', resolution: '480p' })
  const futureCard = structuredClone((await store.get(id)).episodes.find(episode => episode.id === futureId).cards[0])
  const snapshot = store.episodeSnapshot.bind(store)
  let sourceDeleted = false
  const intercept = t.mock.method(store, 'episodeSnapshot', async (...args) => {
    const result = await snapshot(...args)
    if (!sourceDeleted && args[0] === id && args[1] === episodeId && args[2] === true) {
      sourceDeleted = true
      await store.mutateEpisode(id, futureId, record => {
        const episode = record.project.episodes.find(episode => episode.id === futureId)
        episode.cards = episode.cards.filter((card: any) => card.id !== 'future-source')
        return { documentChanged: true, result: null }
      })
    }
    return result
  })
  try {
    const race = await submit()
    assert.equal(race.status, 422, '读取后、提交前跨集手选来源消失，应在提交事务中重新核对')
    assert.equal(accepted.length, 0)
  } finally {
    intercept.mock.restore()
    await store.mutateEpisode(id, futureId, record => {
      record.project.episodes.find(episode => episode.id === futureId).cards.unshift(futureCard)
      return { documentChanged: true, result: null }
    })
  }
  const submitted = await submit()
  assert.equal(submitted.status, 201, await submitted.clone().text())
  assert.equal(accepted[0].continuationSource?.previousCardId, 'future-source')
  assert.equal(accepted[0].continuationSource?.sourceEpisodeId, futureId)
  const taskId = 501
  assert.equal((await app.request(`/projects/${id}/video/${taskId}`)).status, 200)
  const savedEpisode = (await store.get(id)).episodes.find(episode => episode.id === episodeId)
  assert.equal(savedEpisode.tasks.find((task: any) => task.taskId === taskId).staleResult, undefined)
  await store.mutateEpisode(id, futureId, record => {
    record.project.episodes.find(episode => episode.id === futureId).cards = []
    return { documentChanged: true, result: null }
  })
  const blocked = await submit()
  assert.equal(blocked.status, 422, await blocked.clone().text())
  assert.equal(accepted.length, 1, '来源被删除时不应提交新生成')
  await store.mutateEpisode(id, episodeId, record => {
    delete record.project.episodes.find(episode => episode.id === episodeId).cards[1].referenceFrameSettings
    return { documentChanged: true, result: null }
  })
  const restored = await read(framesRoute)
  assert.equal(restored.tail.videoUrl, url('before'))
  assert.equal(restored.lighting[0].videoUrl, url('before'))
})
