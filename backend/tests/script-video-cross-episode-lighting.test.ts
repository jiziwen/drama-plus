import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildScriptVideoEpisodeLightingPlan } from '../src/services/script-video-lighting-plan.js'
import { planScriptVideoLighting, prepareScriptVideoLighting, previousScriptVideoRender } from '../src/services/script-video-lighting.js'
import type { ScriptVideoJob, ScriptVideoProject } from '../src/services/script-video-store.js'

function fixture() {
  const card = (id: string) => ({
    id, scene: '外廊｜早晨', version: 2, prompt: '', assetIds: ['porch'], status: 'draft',
    shots: [{ camera: '中景固定', action: '人物扶住门闩。', duration: 2 },
      { camera: '近景固定', action: '人物在廊下停步。', duration: 2 }],
  })
  const script = '场次：1-01\n场景：外廊\n时间：早晨\n天气/环境：廊下散射光'
  const prior = { ...card('prior'), status: 'ready', videoUrl: '/static/videos/prior.mp4',
    videoVersions: [{ url: '/static/videos/prior.mp4', duration: 4 }] }
  const target = card('target'), next = card('next')
  const before = { id: 'before', script: '', confirmedScript: script, cards: [prior], tasks: [] as any[] }
  const after = { id: 'after', script: '', confirmedScript: script.replace('1-01', '2-01'), cards: [target, next], tasks: [] as any[] }
  const project: ScriptVideoProject = { id: 'project', title: '跨集衔接', revision: 1, episodeId: after.id,
    assets: [{ id: 'porch', name: '外廊', kind: 'scene' }], episodes: [before, after] }
  const jobs: ScriptVideoJob[] = []
  const plan = () => planScriptVideoLighting(project, after.id, jobs)
  return { project, before, after, prior, target, next, jobs, plan }
}

test('下一集开场从上一集末段重取光线，独立剧本的场次编号不影响同场衔接', async () => {
  const { project, after, prior, plan } = fixture()
  const ranges = buildScriptVideoEpisodeLightingPlan(project, after.id)
  assert.equal(ranges.prior[0].sceneKey, ranges.target[0].sceneKey)
  assert.equal(plan().target[0].source?.cardId, prior.id)
  const prepared = await prepareScriptVideoLighting(plan().target, async (url, start, end) => {
    assert.deepEqual([url, start, end], [prior.videoUrl, 2, 4])
    return '/static/videos/prior-light.jpg'
  })
  assert.equal(prepared.ranges[0].imageUrl, '/static/videos/prior-light.jpg')
  assert.equal(prepared.checks[0].reference, '/static/videos/prior-light.jpg')
  assert.equal(plan().next[0].source, undefined, '本集第一段尚无成片，第二段不能越过它引用上一集')
})

test('跨集换场、换时段、次日、天气和光源变化不继承旧光线', () => {
  for (const scene of ['书房｜早晨', '外廊｜深夜', '外廊｜次日早晨', '外廊｜早晨，大雨', '外廊｜早晨，烛光']) {
    const { after, target, plan } = fixture()
    target.scene = scene
    after.confirmedScript = ''
    assert.equal(plan().target[0].source, undefined, scene)
  }
  const { target, plan } = fixture()
  target.shots[0].action = '廊下灯火骤然亮起。'
  assert.equal(plan().target[0].source, undefined)
})

test('各集重用场号时独立读取天气，同名不同戏不误接', () => {
  const { after, plan } = fixture()
  after.confirmedScript = '场次：1-01\n场景：外廊\n时间：早晨\n天气/环境：大雨，光线昏暗'
  const range = plan().target[0]
  assert.equal(range.source, undefined)
  assert.match(range.range.lighting!, /大雨/u)
  assert.doesNotMatch(range.range.lighting!, /散射光/u)
})

test('上一集末镜中的实际光源变化连续传到下一集，开场新光变仍建立新基准', () => {
  const { prior, target, plan } = fixture()
  prior.shots.push({ camera: '近景固定', action: '廊下灯火骤然熄灭。', duration: 2 },
    { camera: '近景固定', action: '人物在廊下停步。', duration: 2 })
  prior.videoVersions[0].duration = 8
  assert.equal(plan().target[0].source?.cardId, prior.id)
  assert.match(plan().target[0].range.lighting!, /灯火骤然熄灭/u)
  target.shots[0].action = '廊下灯火骤然亮起。'
  assert.equal(plan().target[0].source, undefined)
})

test('相邻上一集为空或末段没有成片时，不向更早段或集寻找光线', () => {
  const { project, before, prior, plan } = fixture()
  before.cards.push({ ...prior, id: 'unrendered', status: 'draft', videoUrl: '', videoVersions: [] })
  assert.equal(plan().target[0].source, undefined)
  before.cards.pop()
  project.episodes.splice(1, 0, { id: 'empty', cards: [], tasks: [], script: '' })
  assert.equal(plan().target[0].source, undefined)
})

test('上一集末段重做或排队时等待新成片，过期版本任务不阻塞', () => {
  const { project, before, after, prior, jobs, plan } = fixture()
  const now = new Date().toISOString()
  jobs.push({ id: 'remake', projectId: project.id, episodeId: before.id, cardId: prior.id,
    cardVersion: prior.version, action: 'video', status: 'running', createdAt: now, updatedAt: now })
  assert.equal(plan().target[0].pendingCardId, prior.id)
  assert.equal(plan().target[0].source, undefined)
  jobs[0].cardVersion--
  assert.equal(plan().target[0].source?.cardId, prior.id)
  assert.equal(planScriptVideoLighting(project, after.id, [], new Set([prior.id])).target[0].pendingCardId, prior.id)
})

test('跨集手选允许上一集末段的历史成片，关闭后保留光线文字及自动恢复来源', async () => {
  const { project, before, after, prior, target, plan } = fixture()
  const archived = '/static/videos/archived.mp4'
  before.tasks.push({ id: 'old', taskId: 10, cardId: prior.id, status: 'completed', videoUrl: archived })
  assert.equal(previousScriptVideoRender(project, after.id, target.id, archived)?.cardId, prior.id)
  Object.assign(target, { referenceFrameSettings: { lighting: { '1': { mode: 'manual', videoUrl: archived, seconds: 0.5 } } } })
  const prepared = await prepareScriptVideoLighting(plan().target, async () => assert.fail('不应自动取帧'), async (url, seconds) => {
    assert.deepEqual([url, seconds], [archived, 0.5])
    return '/static/videos/manual.jpg'
  })
  assert.equal(prepared.ranges[0].imageUrl, '/static/videos/manual.jpg')
  Object.assign(target, { referenceFrameSettings: { lighting: { '1': { mode: 'off' } } } })
  assert.equal(plan().target[0].source, undefined)
  assert.equal(plan().target[0].automaticSource?.cardId, prior.id)
  assert.match(plan().target[0].range.lighting!, /散射光/u)
  Object.assign(target, { referenceFrameSettings: {} })
  assert.equal(plan().target[0].source?.cardId, prior.id)
})
