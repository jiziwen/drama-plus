import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planScriptVideoLighting, prepareScriptVideoLighting, reviewScriptVideoLighting } from '../src/services/script-video-lighting.js'
import type { ScriptVideoJob, ScriptVideoProject } from '../src/services/script-video-store.js'

function fixture() {
  const cards = ['a', 'b', 'c', 'd'].map((id, i) => ({
    id, scene: '廊下（唯一空间）｜日间，散射光', version: 2, prompt: '', assetIds: [],
    shots: [{ camera: '平视', action: '她转身。', duration: 3 }, { camera: '过肩', action: '她停步。', duration: 1 }],
    status: i < 3 ? 'ready' : 'draft', videoUrl: i < 3 ? '/static/videos/task-' + i + '.mp4' : undefined,
  }))
  const tasks = cards.slice(0, 3).map((card, i) => ({
    id: 'job-' + i, cardId: card.id, taskId: i + 10, videoUrl: card.videoUrl,
    status: 'completed', cardVersion: 1, staleResult: false,
  }))
  const jobs = tasks.map(task => ({ ...task, action: 'video', episodeId: 'ep' })) as ScriptVideoJob[]
  const episode = { id: 'ep', script: '', confirmedScript: '', cards, tasks }
  const project = { id: 'p', title: '测试', episodeId: 'ep', revision: 1, assets: [], episodes: [episode] }
  const plan = () => planScriptVideoLighting(project as ScriptVideoProject, 'ep', jobs)
  return { episode, cards, tasks, jobs, plan }
}

test('only the selected ready result is a source, including a restored older version; newer unused and stale jobs are skipped', () => {
  const { plan, tasks, cards, jobs } = fixture()
  jobs[2].staleResult = true
  assert.equal(plan().d[0].source?.cardId, 'b')
  tasks[1].videoUrl = '/static/videos/other.mp4'
  assert.equal(plan().d[0].source?.cardId, 'a')
  cards[0].status = 'draft'
  assert.equal(plan().d[0].source, undefined)
})

test('inherit the original look across cameras; compare the actual adjacent ending on receipt, excluding other scenes', async () => {
  const { plan, tasks, cards, jobs } = fixture()
  const frame = async (url: string, start: number, end: number) => url + '#' + start + '-' + end
  const original = await prepareScriptVideoLighting(plan().b, frame)
  Object.assign(tasks[1], { lightingRanges: original.ranges })
  const next = await prepareScriptVideoLighting(plan().c, frame)
  assert.equal(next.ranges[0].imageUrl, original.ranges[0].imageUrl)
  assert.match(next.checks[0].reference, /task-1\.mp4#3-4$/u)
  assert.deepEqual(await reviewScriptVideoLighting('/new', next.checks, frame, async () => 'review'), [1])
  assert.deepEqual(await reviewScriptVideoLighting('/new', next.checks, frame, async () => 'unknown'), [])
  jobs[1].videoDuration = 8
  const resized = await prepareScriptVideoLighting(plan().c, frame)
  assert.equal(resized.ranges[0].imageUrl, original.ranges[0].imageUrl)
  assert.match(resized.checks[0].reference, /task-1\.mp4#6-8$/u)
  cards[2].scene = '大殿（唯一空间）｜夜间，烛光'
  assert.equal(plan().c[0].source, undefined)
  assert.equal(plan().c[0].previous, undefined)
})

test('a blank ending falls back within that scene and an unreadable render still permits text lighting', async () => {
  const { plan } = fixture()
  const input = plan().b
  const requests: number[] = []
  const { ranges, checks } = await prepareScriptVideoLighting(input, async (_, start) => {
    requests.push(start)
    return start === 0 ? '/static/videos/stable.jpg' : null
  })
  assert.deepEqual(requests, [3, 0])
  assert.equal(ranges[0].imageUrl, checks[0].reference)
  const fallback = await prepareScriptVideoLighting(input, async () => { throw new Error('media unavailable') })
  assert.equal(fallback.ranges[0].imageUrl, undefined)
  assert.match(fallback.ranges[0].lighting!, /散射光/u)
  assert.deepEqual(fallback.checks, [])
})
