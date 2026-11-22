import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { ScriptVideoGenerationInput } from '../src/services/script-video-generation.js'
import type { ScriptVideoReferenceSettings } from '../src/services/script-video-reference-settings.js'

test('下一集首段在选帧、预览、导出和视频提交中承接上一集末段', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cross-episode-frames-'))
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
    '-vf', 'drawgrid=w=12:h=10:t=2:c=0x494949', '-c:v', 'libx264', path.join(videos, 'prior.mp4')])
  for (const name of ['archived', 'newer', 'result', 'result-next']) await fs.copyFile(path.join(videos, 'prior.mp4'), path.join(videos, name + '.mp4'))
  const videoUrl = '/static/videos/prior.mp4', archivedUrl = '/static/videos/archived.mp4', newerUrl = '/static/videos/newer.mp4'
  const { id } = await store.create('跨集参考帧')
  const { priorId, episodeId } = await store.mutate(id, record => {
    const previous = record.project.episodes[0]
    const script = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
    const card = (id: string) => ({ id, title: id, scene: '外墙｜早晨', version: 2, status: 'draft', duration: 2,
      prompt: '小旗停步。', assetIds: [], shots: [{ id: id + '-1', duration: 2,
        camera: '平视固定', action: '小旗半抬右手扶住门闩。', dialogue: '无对白。' }] })
    previous.number = 1
    previous.confirmed = true
    previous.confirmedScript = script
    previous.cards = [
      { ...card('earlier'), status: 'ready', videoUrl: newerUrl },
      { ...card('prior-last'), status: 'ready', videoUrl,
        videoVersions: [{ url: archivedUrl, duration: 2 }, { url: videoUrl, duration: 2 }],
        ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' },
    ]
    const now = new Date().toISOString()
    previous.tasks = [{ id: 'prior-job', cardId: 'prior-last', cardVersion: 2, taskId: 101,
      status: 'completed', videoUrl, duration: 2, createdAt: now }]
    record.jobs.push({ id: 'prior-job', projectId: id, episodeId: previous.id, cardId: 'prior-last', cardVersion: 2,
      taskId: 101, action: 'video', status: 'completed', videoDuration: 2, createdAt: now, updatedAt: now })
    const next = { ...structuredClone(previous), id: 'next-episode', title: '第二集', number: 2, tasks: [], cards: [
      { ...card('next-first'), opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' }, card('next-second'),
    ] }
    record.project.episodes.push(next, { ...structuredClone(next), id: 'unrelated', title: '第三集', number: 3, cards: [] })
    return { documentChanged: true, result: { priorId: previous.id, episodeId: next.id } }
  })
  const accepted: ScriptVideoGenerationInput[] = []
  const unused = () => { throw new Error('不应调用文本生成或恢复服务') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
    reviewScriptVideoEpisode: unused, recoverVideoTask: unused, assertScriptVideoFormal() {},
    async getScriptVideoGeneration(taskId) {
      return { taskId, status: 'completed', stage: 'completed',
        videoUrl: taskId === 101 ? videoUrl : taskId === 501 ? '/static/videos/result.mp4' : '/static/videos/result-next.mp4' }
    },
    async startScriptVideoGeneration(input) {
      accepted.push(input)
      const source = input.continuationSource
      const imageUrl = source && await scriptVideoOpeningImage(source)
      assert.ok(source && imageUrl)
      return { taskId: 500 + accepted.length, status: 'processing', lightingRanges: input.lightingRanges?.slice(), continuation: {
        previousCardId: source.previousCardId, previousTaskId: source.previousTaskId, previousVideoUrl: source.videoUrl,
        ...(source.manualSeconds !== undefined && { manualSeconds: source.manualSeconds }), mode: 'reference', imageUrl,
      } }
    },
  })
  const base = '/projects/' + id + '/episodes/' + episodeId, framesRoute = '/cards/next-first/reference-frames'
  const headers = { 'Content-Type': 'application/json', 'X-Script-Video-Session': '12345678-1234-4567-8234-123456789012' }
  const post = (route: string, body: object) => app.request(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
  async function read(route: string, body: object = {}) {
    const response = await post(route, body)
    assert.equal(response.status, 200, await response.clone().text())
    return (await response.json()).data
  }
  const settings = (value?: ScriptVideoReferenceSettings) => store.mutate(id, record => {
    const target = record.project.episodes.find(episode => episode.id === episodeId).cards[0]
    if (value) target.referenceFrameSettings = value
    else delete target.referenceFrameSettings
    return { documentChanged: true, result: null }
  })
  const submit = () => post('/cards/next-first/video', { expectedCardVersion: 2, configId: 1,
    model: 'seedance2.5-ae-480p', aspectRatio: '16:9', resolution: '480p' })

  await t.test('分集上下文只加载相邻两集，并保持上一集文档和任务只读', async () => {
    const scoped = await store.episodeSnapshot(id, episodeId)
    const references = await store.episodeSnapshot(id, episodeId, true)
    assert.deepEqual(scoped.project.episodes.map(episode => episode.id), [episodeId])
    assert.deepEqual(references.project.episodes.map(episode => episode.id), [priorId, episodeId])
    assert.equal(references.episodeRevision, scoped.episodeRevision)
    assert.equal(references.jobs.find(job => job.id === 'prior-job')?.episodeId, priorId)
    const before = (await store.get(id)).episodes.find(episode => episode.id === priorId)
    await store.mutateEpisode(id, episodeId, record => {
      record.project.episodes.find(episode => episode.id === priorId).title = '不能被本集保存覆盖'
      record.jobs.find(job => job.id === 'prior-job')!.status = 'failed'
      record.project.episodes.find(episode => episode.id === episodeId).title = '第二集制作'
      return { documentChanged: true, result: null }
    }, true)
    assert.deepEqual((await store.get(id)).episodes.find(episode => episode.id === priorId), before)
    assert.equal((await store.listJobs(id, priorId)).find(job => job.id === 'prior-job')?.status, 'completed')
    assert.equal((await store.get(id)).episodes.find(episode => episode.id === episodeId).title, '第二集制作')
  })

  await t.test('自动尾帧与光线帧来自上一集最后一段，预览和导出一致', async () => {
    const frames = await read(framesRoute)
    assert.deepEqual([frames.tail.state, frames.lighting[0].state], ['ready', 'ready'])
    for (const row of [frames.tail, frames.lighting[0]]) {
      assert.equal(row.videoUrl, videoUrl)
      assert.match(row.sourceLabel, /上一集.*第 2 段/u)
      assert.ok(row.imageUrl)
    }
    const firstResponse = await app.request('/projects/' + id + '/episodes/' + priorId + '/cards/earlier/reference-frames', {
      method: 'POST', headers, body: '{}',
    })
    assert.equal(firstResponse.status, 200)
    assert.equal((await firstResponse.json()).data.tail.videoUrl, undefined)
    const preview = await read('/final-prompt', { cardId: 'next-first', cardVersion: 2 })
    assert.deepEqual(new Set(preview.images.map((item: { url: string }) => item.url)), new Set([frames.tail.imageUrl, frames.lighting[0].imageUrl]))
    const exported = await read('/continuations', { cardIds: ['next-first'] })
    assert.equal(exported.continuations['next-first'].previousCardId, 'prior-last')
    assert.equal(exported.continuations['next-first'].imageUrl, frames.tail.imageUrl)
    assert.equal(exported.lightingRanges['next-first'][0].imageUrl, frames.lighting[0].imageUrl)
  })

  await t.test('上一集末段排队时等待来源，手选旧成片、关闭与恢复均可跨集使用', async () => {
    store.queue.reserve(id, priorId, headers['X-Script-Video-Session'], 'remake-last', ['prior-last'])
    try {
      const waiting = await read(framesRoute)
      assert.deepEqual([waiting.tail.state, waiting.lighting[0].state], ['pending', 'pending'])
      assert.deepEqual([waiting.tail.videoUrl, waiting.lighting[0].videoUrl], [videoUrl, videoUrl])
      const blocked = await submit()
      assert.equal(blocked.status, 409)
      assert.equal((await blocked.json()).errorCode, 'CONTINUATION_PENDING')
      assert.equal(accepted.length, 0)
      const tail = (await read(framesRoute, { kind: 'tail', seconds: 0.25, expectedVideoUrl: videoUrl })).candidate
      const light = (await read(framesRoute, { kind: 'lighting', startShot: 1, seconds: 0.5, expectedVideoUrl: videoUrl })).candidate
      await settings({ tail: { mode: 'manual', videoUrl, seconds: tail.seconds },
        lighting: { '1': { mode: 'manual', videoUrl, seconds: light.seconds } } })
      await store.mutate(id, record => {
        const prior = record.project.episodes.find(episode => episode.id === priorId).cards[1]
        prior.videoUrl = newerUrl
        prior.videoVersions.push({ url: newerUrl, duration: 2 })
        return { documentChanged: true, result: null }
      })
      const manual = await read(framesRoute)
      assert.deepEqual([manual.tail.state, manual.lighting[0].state], ['ready', 'ready'])
      assert.deepEqual([manual.tail.imageUrl, manual.lighting[0].imageUrl], [tail.imageUrl, light.imageUrl])
      assert.equal(manual.tail.videoUrl, videoUrl, '上一集换成新成片后仍保留明确选择的旧版')
      await settings({ tail: { mode: 'off' }, lighting: { '1': { mode: 'off' } } })
      const off = await read(framesRoute)
      assert.deepEqual([off.tail.state, off.lighting[0].state], ['off', 'off'])
      const exported = await read('/continuations', { cardIds: ['next-first'] })
      assert.deepEqual(exported.continuations, {})
      assert.ok(!exported.lightingRanges['next-first'][0].imageUrl)
    } finally {
      store.queue.release(id, priorId, headers['X-Script-Video-Session'], 'remake-last')
    }
    await settings()
    const restored = await read(framesRoute)
    assert.deepEqual([restored.tail.state, restored.lighting[0].state], ['ready', 'ready'])
    assert.deepEqual([restored.tail.videoUrl, restored.lighting[0].videoUrl], [newerUrl, newerUrl])
  })

  await t.test('跨集同场切镜只沿用光线，换场或相邻末段无成片不回退到更早片段', async () => {
    const original = (await store.get(id)).episodes.find(episode => episode.id === episodeId).cards[0]
    await store.mutate(id, record => {
      record.project.episodes.find(episode => episode.id === episodeId).cards[0].opening = '同场切镜，重新构图。'
      return { documentChanged: true, result: null }
    })
    const cut = await read(framesRoute)
    assert.equal(cut.tail.imageUrl, undefined)
    assert.equal(cut.lighting[0].state, 'ready')
    await store.mutate(id, record => {
      const episode = record.project.episodes.find(episode => episode.id === episodeId)
      episode.cards[0].scene = '书房｜夜间'
      episode.confirmedScript = '场景：书房\n时间：夜间\n天气/环境：烛光'
      return { documentChanged: true, result: null }
    })
    const changed = await read(framesRoute)
    assert.deepEqual([changed.tail.imageUrl, changed.lighting[0].imageUrl], [undefined, undefined])
    const current = (await store.get(id)).episodes.find(episode => episode.id === priorId).cards[1]
    await store.mutate(id, record => {
      const episode = record.project.episodes.find(episode => episode.id === episodeId)
      episode.cards[0] = structuredClone(original)
      episode.confirmedScript = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
      const previous = record.project.episodes.find(episode => episode.id === priorId).cards[1]
      previous.status = 'draft'
      delete previous.videoUrl
      previous.videoVersions = []
      record.project.episodes.find(episode => episode.id === priorId).tasks = []
      return { documentChanged: true, result: null }
    })
    const missing = await read(framesRoute)
    assert.deepEqual([missing.tail.imageUrl, missing.lighting[0].imageUrl], [undefined, undefined])
    assert.deepEqual([missing.tail.videoUrl, missing.lighting[0].videoUrl], [undefined, undefined])
    await settings({ tail: { mode: 'manual', videoUrl: newerUrl, seconds: 0.25 },
      lighting: { '1': { mode: 'manual', videoUrl: newerUrl, seconds: 0.5 } } })
    const unrelated = await read(framesRoute)
    assert.deepEqual([unrelated.tail.imageUrl, unrelated.lighting[0].imageUrl], [undefined, undefined], '不能把上集倒数第二段误认成相邻来源')
    await store.mutate(id, record => {
      record.project.episodes.find(episode => episode.id === priorId).cards[1] = current
      return { documentChanged: true, result: null }
    })
    await settings()
  })

  await t.test('提交保存跨集参考来源，完成后正常成为本集成片且不改上一集', async () => {
    const before = (await store.get(id)).episodes.find(episode => episode.id === priorId)
    const submission = await submit()
    assert.equal(submission.status, 201, await submission.clone().text())
    assert.equal(accepted.length, 1)
    assert.equal(accepted[0].continuationSource?.previousCardId, 'prior-last')
    assert.equal(accepted[0].continuationSource?.videoUrl, newerUrl)
    assert.ok(accepted[0].lightingRanges?.[0].imageUrl)
    const completed = await app.request('/projects/' + id + '/video/501')
    assert.equal(completed.status, 200, await completed.clone().text())
    const project = await store.get(id)
    const episode = project.episodes.find(episode => episode.id === episodeId)
    assert.equal(episode.cards[0].status, 'ready')
    assert.equal(episode.cards[0].videoUrl, '/static/videos/result.mp4')
    const task = episode.tasks.find((item: { taskId?: number }) => item.taskId === 501)
    assert.equal(task.continuation.previousVideoUrl, newerUrl)
    assert.ok(task.lightingRanges[0].imageUrl)
    assert.equal(task.staleResult, undefined)
    assert.deepEqual(project.episodes.find(episode => episode.id === priorId), before)
  })

  await t.test('生成期间上一集切换成片会使本次结果进入历史，不覆盖本集已选成片', async () => {
    const submission = await submit()
    assert.equal(submission.status, 201, await submission.clone().text())
    assert.equal(accepted.length, 2)
    assert.equal(accepted[1].continuationSource?.videoUrl, newerUrl)
    await store.mutate(id, record => {
      record.project.episodes.find(episode => episode.id === priorId).cards[1].videoUrl = videoUrl
      return { documentChanged: true, result: null }
    })
    const completed = await app.request('/projects/' + id + '/video/502')
    assert.equal(completed.status, 200, await completed.clone().text())
    const episode = (await store.get(id)).episodes.find(episode => episode.id === episodeId)
    assert.equal(episode.cards[0].videoUrl, '/static/videos/result.mp4')
    const task = episode.tasks.find((item: { taskId?: number }) => item.taskId === 502)
    assert.equal(task.videoUrl, '/static/videos/result-next.mp4')
    assert.equal(task.staleResult, true)
  })

  await t.test('跨集来源视频未变但上一集末段脚本变化时，本集结果仍标为历史', async () => {
    const submission = await submit()
    assert.equal(submission.status, 201, await submission.clone().text())
    assert.equal(accepted.length, 3)
    assert.equal(accepted[2].continuationSource?.videoUrl, videoUrl)
    await store.mutate(id, record => {
      record.project.episodes.find(episode => episode.id === priorId).cards[1].shots[0].action = '小旗半抬右手扶住门闩，左手握住钥匙。'
      return { documentChanged: true, result: null }
    })
    const completed = await app.request('/projects/' + id + '/video/503')
    assert.equal(completed.status, 200, await completed.clone().text())
    const episode = (await store.get(id)).episodes.find(episode => episode.id === episodeId)
    assert.equal(episode.cards[0].videoUrl, '/static/videos/result.mp4')
    assert.equal(episode.tasks.find((item: { taskId?: number }) => item.taskId === 503).staleResult, true)
  })

  await t.test('首段提交自动核对上一集正在运行的任务，已出片即可续接提交', async () => {
    const refreshedProject = await store.create('跨集来源任务刷新')
    const refreshedId = refreshedProject.id
    const { sourceEpisodeId, nextEpisodeId } = await store.mutate(refreshedId, record => {
      const previous = record.project.episodes[0]
      previous.confirmed = true
      previous.confirmedScript = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
      const card = (id: string) => ({ id, title: id, scene: '外墙｜早晨', version: 2, status: 'draft', duration: 2,
        prompt: '小旗停步。', assetIds: [], shots: [{ id: id + '-1', duration: 2,
          camera: '平视固定', action: '小旗半抬右手扶住门闩。', dialogue: '无对白。' }] })
      previous.cards = [{ ...card('refresh-last'), ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' }]
      const next = { ...structuredClone(previous), id: 'refresh-next', title: '第二集', number: 2, tasks: [], cards: [
        { ...card('refresh-first'), opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' },
      ] }
      record.project.episodes.push(next)
      return { documentChanged: true, result: { sourceEpisodeId: previous.id, nextEpisodeId: next.id } }
    })
    let sourceCompleted = false
    const refreshedInputs: ScriptVideoGenerationInput[] = []
    const refreshApp = createScriptVideoRoutes(store, {
      generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
      reviewScriptVideoEpisode: unused, recoverVideoTask: unused, assertScriptVideoFormal() {},
      async getScriptVideoGeneration(taskId) {
        return taskId === 701 && sourceCompleted
          ? { taskId, status: 'completed', stage: 'completed', videoUrl }
          : { taskId, status: 'processing', stage: 'polling' }
      },
      async startScriptVideoGeneration(input) {
        refreshedInputs.push(input)
        const source = input.continuationSource
        if (!source) return { taskId: 701, status: 'processing' }
        const imageUrl = await scriptVideoOpeningImage(source)
        assert.ok(imageUrl)
        return { taskId: 702, status: 'processing', lightingRanges: input.lightingRanges?.slice(), continuation: {
          previousCardId: source.previousCardId, previousTaskId: source.previousTaskId,
          previousVideoUrl: source.videoUrl, mode: 'reference', imageUrl,
        } }
      },
    })
    const submitRefresh = (episodeId: string, cardId: string) => refreshApp.request('/projects/' + refreshedId + '/episodes/' + episodeId + '/cards/' + cardId + '/video', {
      method: 'POST', headers, body: JSON.stringify({ expectedCardVersion: 2, configId: 1,
        model: 'seedance2.5-ae-480p', aspectRatio: '16:9', resolution: '480p' }),
    })
    const sourceSubmission = await submitRefresh(sourceEpisodeId, 'refresh-last')
    assert.equal(sourceSubmission.status, 201, await sourceSubmission.clone().text())
    assert.equal((await store.listJobs(refreshedId, sourceEpisodeId))[0].status, 'running')
    sourceCompleted = true
    const nextSubmission = await submitRefresh(nextEpisodeId, 'refresh-first')
    assert.equal(nextSubmission.status, 201, await nextSubmission.clone().text())
    assert.equal(refreshedInputs.length, 2)
    assert.equal(refreshedInputs[1].continuationSource?.previousTaskId, 701)
    assert.equal(refreshedInputs[1].continuationSource?.videoUrl, videoUrl)
    assert.ok(refreshedInputs[1].lightingRanges?.[0].imageUrl)
    const previous = (await store.get(refreshedId)).episodes.find(episode => episode.id === sourceEpisodeId)
    assert.equal(previous.cards[0].status, 'ready')
    assert.equal(previous.cards[0].videoUrl, videoUrl)
    assert.equal(previous.tasks[0].status, 'completed')
    assert.equal((await store.listJobs(refreshedId, sourceEpisodeId))[0].status, 'completed')
  })

  await t.test('全项目同批出片先接纳上集重做，再将引用旧来源的下集结果标为历史', async () => {
    const simultaneousProject = await store.create('跨集同批出片')
    const simultaneousId = simultaneousProject.id
    const { sourceEpisodeId, nextEpisodeId } = await store.mutate(simultaneousId, record => {
      const previous = record.project.episodes[0]
      previous.confirmed = true
      previous.confirmedScript = '场景：外墙\n时间：早晨\n天气/环境：室外散射光'
      const card = (id: string) => ({ id, title: id, scene: '外墙｜早晨', version: 2, status: 'ready', duration: 2,
        prompt: '小旗停步。', assetIds: [], shots: [{ id: id + '-1', duration: 2,
          camera: '平视固定', action: '小旗半抬右手扶住门闩。', dialogue: '无对白。' }] })
      previous.cards = [{ ...card('simultaneous-last'), videoUrl, videoVersions: [{ url: videoUrl, duration: 2 }],
        ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' }]
      const next = { ...structuredClone(previous), id: 'simultaneous-next', title: '第二集', number: 2, tasks: [], cards: [
        { ...card('simultaneous-first'), videoUrl: '/static/videos/result.mp4', videoVersions: [{ url: '/static/videos/result.mp4', duration: 2 }],
          opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' },
      ] }
      record.project.episodes.push(next)
      return { documentChanged: true, result: { sourceEpisodeId: previous.id, nextEpisodeId: next.id } }
    })
    let completed = false
    const simultaneousApp = createScriptVideoRoutes(store, {
      generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviseScriptVideoCard: unused,
      reviewScriptVideoEpisode: unused, recoverVideoTask: unused, assertScriptVideoFormal() {},
      async getScriptVideoGeneration(taskId) {
        return completed
          ? { taskId, status: 'completed', stage: 'completed', videoUrl: taskId === 801 ? newerUrl : '/static/videos/result-next.mp4' }
          : { taskId, status: 'processing', stage: 'polling' }
      },
      async startScriptVideoGeneration(input) {
        const source = input.continuationSource
        if (!source) return { taskId: 801, status: 'processing' }
        assert.equal(source.videoUrl, videoUrl)
        const imageUrl = await scriptVideoOpeningImage(source)
        assert.ok(imageUrl)
        return { taskId: 802, status: 'processing', lightingRanges: input.lightingRanges?.slice(), continuation: {
          previousCardId: source.previousCardId, previousVideoUrl: source.videoUrl, mode: 'reference', imageUrl,
        } }
      },
    })
    const submitSimultaneous = (episodeId: string, cardId: string) => simultaneousApp.request('/projects/' + simultaneousId + '/episodes/' + episodeId + '/cards/' + cardId + '/video', {
      method: 'POST', headers, body: JSON.stringify({ expectedCardVersion: 2, configId: 1,
        model: 'seedance2.5-ae-480p', aspectRatio: '16:9', resolution: '480p' }),
    })
    // 先提交下集，使持久化任务顺序与剧情顺序相反。
    const nextSubmission = await submitSimultaneous(nextEpisodeId, 'simultaneous-first')
    assert.equal(nextSubmission.status, 201, await nextSubmission.clone().text())
    const sourceSubmission = await submitSimultaneous(sourceEpisodeId, 'simultaneous-last')
    assert.equal(sourceSubmission.status, 201, await sourceSubmission.clone().text())
    assert.deepEqual((await store.listJobs(simultaneousId)).map(job => job.taskId), [802, 801])
    completed = true
    const refreshed = await simultaneousApp.request('/projects/' + simultaneousId)
    assert.equal(refreshed.status, 200, await refreshed.clone().text())
    const project = (await refreshed.json()).data
    const previous = project.episodes.find((episode: { id: string }) => episode.id === sourceEpisodeId)
    const next = project.episodes.find((episode: { id: string }) => episode.id === nextEpisodeId)
    assert.equal(previous.cards[0].videoUrl, newerUrl)
    assert.equal(previous.tasks.find((task: { taskId?: number }) => task.taskId === 801).staleResult, undefined)
    assert.equal(next.cards[0].videoUrl, '/static/videos/result.mp4')
    const stale = next.tasks.find((task: { taskId?: number }) => task.taskId === 802)
    assert.equal(stale.status, 'completed')
    assert.equal(stale.videoUrl, '/static/videos/result-next.mp4')
    assert.equal(stale.staleResult, true)
  })
})
