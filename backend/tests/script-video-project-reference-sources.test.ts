import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { previousScriptVideoCard, previousScriptVideoRender } from '../src/services/script-video-predecessor.js'
import { scriptVideoReferenceSettings } from '../src/services/script-video-reference-settings.js'

const url = (name: string) => `/static/videos/${name}.mp4`
const card = (id: string, video?: string) => ({ id, title: id, duration: 3, shots: [], assetIds: [],
  prompt: '木门旁的灯火轻晃。', version: 1, status: video ? 'ready' : 'draft', ...(video && { videoUrl: video }) })

test('明确选帧可引用同项目任意集及历史成片，默认相邻来源不扩大', () => {
  const episodes = [
    { id: 'first', cards: [{ ...card('far', url('early')), videoVersions: [{ url: url('archived') }] }], tasks: [] },
    { id: 'previous', cards: [card('previous-last', url('adjacent'))], tasks: [] },
    { id: 'current', cards: [card('current-first'), card('target'), card('later', url('later'))], tasks: [] },
    { id: 'future', cards: [card('far', url('future'))], tasks: [
      { id: 'job-future', cardId: 'far', status: 'completed', videoUrl: url('future'), taskId: 88 },
    ] },
  ]
  const project = { episodes }
  assert.equal(previousScriptVideoCard(project, 'current', 'current-first')?.card.id, 'previous-last')
  assert.equal(previousScriptVideoCard(project, 'current', 'target')?.card.id, 'current-first')
  assert.equal(previousScriptVideoRender(project, 'current', 'target', url('archived')), undefined)
  assert.equal(previousScriptVideoRender(project, 'current', 'target', url('archived'), 'far')?.sourceEpisodeId, 'first')
  assert.equal(previousScriptVideoRender(project, 'current', 'target', url('later'), 'later', 'current')?.videoUrl, url('later'))
  assert.deepEqual(previousScriptVideoRender(project, 'current', 'target', url('future'), 'far', 'future'),
    { cardId: 'far', taskId: 88, videoUrl: url('future'), sourceEpisodeId: 'future' })
  assert.equal(previousScriptVideoRender(project, 'current', 'target', url('future'), 'far', 'first'), undefined,
    '同 cardId 的不同集必须按明确分集归属验证 URL')
  assert.equal(previousScriptVideoRender(project, 'current', 'missing', url('future'), 'far', 'future'), undefined)
  assert.equal(previousScriptVideoRender(project, 'current', 'target', 'https://external.test/video.mp4', 'far'), undefined)
  assert.equal(previousScriptVideoRender(project, 'current', 'target', url('unknown'), 'far'), undefined)
})

test('选帧来源分集标识与片段标识一同保存，旧设置兼容', () => {
  const choice = { mode: 'manual' as const, videoUrl: url('early'), seconds: 1.23456, sourceCardId: 'far', sourceEpisodeId: 'first' }
  assert.deepEqual(scriptVideoReferenceSettings({ tail: choice })?.tail, { ...choice, seconds: 1.235 })
  assert.deepEqual(scriptVideoReferenceSettings({ tail: { ...choice, sourceEpisodeId: undefined } })?.tail,
    { mode: 'manual', videoUrl: url('early'), seconds: 1.235, sourceCardId: 'far' })
  assert.throws(() => scriptVideoReferenceSettings({ tail: { ...choice, sourceCardId: undefined } }))
  assert.throws(() => scriptVideoReferenceSettings({ tail: { ...choice, sourceEpisodeId: '../another' } }))
})

test('分集局部保存和生成快照可使用远集手选来源，同时保持自动邻集与来源只读', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-reference-sources-'))
  Object.assign(process.env, { HUOBAO_DATA_DIR: root, SQLITE_PATH: path.join(root, 'test.sqlite3'), MYSQL_AUTO_IMPORT: 'false' })
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const store = new ScriptVideoStore(path.join(root, 'projects'))
  t.after(async () => { await store.close(); await fs.rm(root, { recursive: true, force: true }) })
  const { id } = await store.create('全项目手选来源')
  await store.mutate(id, record => {
    const base = record.project.episodes[0]
    const episode = (id: string, cards: ReturnType<typeof card>[]) => ({ ...structuredClone(base), id, cards })
    record.project.episodes = [
      episode('first', [card('far', url('early'))]),
      episode('previous', [card('previous-last', url('adjacent'))]),
      episode('current', [card('current-first'), card('target')]),
      episode('future', [card('far', url('future'))]),
      episode('unused', [card('unused', url('unused'))]),
    ]
    record.project.episodeId = 'current'
    const timestamp = new Date().toISOString()
    record.jobs.push(...['first', 'future'].map((episodeId, i) => ({ id: `job-${episodeId}`, projectId: id, episodeId,
      action: 'video' as const, status: 'completed' as const, cardId: 'far', taskId: 80 + i, createdAt: timestamp, updatedAt: timestamp })))
    return { result: null, documentChanged: true }
  })
  const settings = {
    tail: { mode: 'manual' as const, videoUrl: url('future'), seconds: 0.5, sourceCardId: 'far', sourceEpisodeId: 'future' },
    lighting: { '1': { mode: 'manual' as const, videoUrl: url('early'), seconds: 1, sourceCardId: 'far', sourceEpisodeId: 'first' } },
  }
  const save = (value: unknown) => store.applyChanges(id, { clientId: randomUUID(), sequence: 1,
    loadedEpisodeIds: ['current'], changes: [{ target: 'card', episodeId: 'current', id: 'target', fields: { referenceFrameSettings: value } }] })
  await save(settings)
  const initial = await store.get(id)
  const snapshot = await store.episodeSnapshot(id, 'current', true)
  assert.deepEqual(snapshot.project.episodes.map(ep => ep.id), ['first', 'previous', 'current', 'future'])
  assert.equal(previousScriptVideoCard(snapshot.project, 'current', 'current-first')?.card.id, 'previous-last')
  assert.equal(previousScriptVideoCard(snapshot.project, 'current', 'target')?.card.id, 'current-first')
  assert.deepEqual(snapshot.jobs.map(job => job.id), ['job-first', 'job-future'])
  assert.ok(previousScriptVideoRender(snapshot.project, 'current', 'target', url('future'), 'far', 'future'))
  await store.mutateEpisode(id, 'current', record => {
    record.project.episodes.find(ep => ep.id === 'first')!.title = '此修改不应写回来源集'
    record.jobs.find(job => job.id === 'job-first')!.error = '此修改不应写回来源任务'
    record.project.episodes.find(ep => ep.id === 'current')!.title = '当前集更新'
    return { result: null, documentChanged: true }
  }, true)
  const after = await store.get(id)
  assert.deepEqual(after.episodes.find(ep => ep.id === 'first'), initial.episodes.find(ep => ep.id === 'first'))
  assert.equal((await store.getJob(id, 'job-first')).error, undefined)
  assert.equal(after.episodes.find(ep => ep.id === 'current').title, '当前集更新')
  const legacy = structuredClone(settings)
  delete (legacy.tail as { sourceEpisodeId?: string }).sourceEpisodeId
  delete (legacy.lighting['1'] as { sourceEpisodeId?: string }).sourceEpisodeId
  await save(legacy)
  const legacySnapshot = await store.episodeSnapshot(id, 'current', true)
  assert.deepEqual(legacySnapshot.project.episodes.map(ep => ep.id), ['first', 'previous', 'current', 'future'],
    '旧的显式卡号通过本项目目录查到来源集，无需迁移旧手选数据')
  const full = await store.get(id)
  full.episodes.find(ep => ep.id === 'current').cards[1].referenceFrameSettings = settings
  await store.update(id, full, full.revision)
  await assert.rejects(save({ ...settings, tail: { ...settings.tail, videoUrl: url('not-from-source') } }),
    (error: any) => error.code === 'REFERENCE_FRAME_SOURCE_CHANGED')
  await assert.rejects(save({ ...settings, tail: { ...settings.tail, sourceEpisodeId: 'other-project-episode' } }),
    (error: any) => error.code === 'REFERENCE_FRAME_SOURCE_CHANGED')
  await store.mutate(id, record => {
    record.project.episodes.find(ep => ep.id === 'future')!.cards = []
    return { result: null, documentChanged: true }
  })
  await assert.rejects(save({ ...settings, tail: { ...settings.tail, seconds: 0.75 } }),
    (error: any) => error.code === 'REFERENCE_FRAME_SOURCE_CHANGED')
})
