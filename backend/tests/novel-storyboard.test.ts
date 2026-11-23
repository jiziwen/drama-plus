import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import type { NovelChapter, NovelCommand, NovelProject, NovelSegment } from '../src/services/novel-storyboard-types.js'
import type { ProjectModelOption, ProjectModelSelection } from '../src/services/project-model-options.js'

const chapterFields = { summary: '阿岚进仓调查。', visualStyle: '16:9 3D 漫剧', voices: [], screens: '' }
function segment(ending: string, combat = false): NovelSegment {
  return {
    scene: '仓房｜夜', cast: ['阿岚'], incoming: '从前一动作接入。', outgoing: '下一段查看暗处。',
    direction: '在仓房串联证据。', combat, shots: [
      { seconds: 15, camera: '中景固定', action: '阿岚举灯向内。', sound: '鞋踩木板。' },
      { seconds: 15, camera: '近景跟拍', action: ending, sound: '仓门响。' },
    ],
  }
}

test('小说分章、定时分镜、单章重生成与跨章资产出图', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'novel-storyboard-'))
  const previousPath = process.env.SQLITE_PATH
  process.env.SQLITE_PATH = join(temp, 'app.sqlite')
  t.after(async () => {
    if (previousPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousPath
    await rm(temp, { recursive: true, force: true })
  })
  const [{ createNovelStoryboardRoutes }, { FAST_PACE_INSTRUCTION, readNovelText, splitNovelChapters }, { db, schema }] =
    await Promise.all([
      import('../src/routes/novel-storyboard.js'),
      import('../src/services/novel-storyboard-agent.js'),
      import('../src/db/index.js'),
    ])

  const longText = '长河入海。'.repeat(2000)
  assert.equal(splitNovelChapters(longText).map(item => item.source).join(''), longText)
  assert.throws(() => splitNovelChapters('\u0000'))
  assert.equal(readNovelText(Uint8Array.of(0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2)), '第一章')

  const phases: string[] = []
  let failSegment = false
  let malformedOnce = false
  let hold = false
  let replan = false
  let usedTextModel: ProjectModelSelection | undefined
  const textSelection = { configId: 22, model: 'novel-writer' }
  const imageSelection = { configId: 23, model: 'selected-image' }
  const timestamp = new Date().toISOString()
  for (const config of [
    { id: 21, serviceType: 'text', name: '默认 LLM', model: '["novel-writer"]' },
    { id: 22, serviceType: 'text', name: '备用 LLM', model: '["novel-writer"]' },
    { id: 23, serviceType: 'image', name: '生图服务', model: '["first-image","selected-image"]' },
    { id: 24, serviceType: 'image', name: '停用服务', model: '["disabled-image"]', isActive: false },
    { id: 25, serviceType: 'image', name: '本地工作流', model: '["wf-z-image","wf-qwen-image"]', provider: 'comfyui' },
  ]) {
    db.insert(schema.aiServiceConfigs).values({
      provider: 'openai', baseUrl: 'http://localhost:9000', apiKey: 'fixture-secret', createdAt: timestamp, updatedAt: timestamp,
      ...config,
    }).run()
  }
  const app = createNovelStoryboardRoutes({
    createTextRunner: async selection => async ({ instructions, message, signal }) => {
      usedTextModel = selection
      const data = JSON.parse(message)
      if (hold) await delay(20_000, null, { signal })
      if (instructions.includes('一次提交整章的正式逐镜分镜')) {
        phases.push('draft:' + data.title)
        assert.equal(instructions.includes(FAST_PACE_INSTRUCTION), !data.notes)
        assert.equal(data.adaptationNotes, '保留故事主线')
        if (data.title.includes('第二章')) assert.equal(data.priorCut.shot.action, '阿岚推开仓门。')
        if (data.notes) assert.equal(data.nextCut.shot.action, '阿岚举灯向内。')
        if (data.repair) assert.match(data.repair, /原文的关键对白需要额外镜头/u)
        const fight = data.title.includes('第二章')
        assert.equal(instructions.includes('【fight-choreography/SKILL.md】'), fight)
        if (fight) assert.match(instructions, /【fight-choreography\/references\/12-02-ink.md】/u)
        assert.match(instructions, /允许切换景别和机位/u)
        if (failSegment) throw new Error('文字模型临时故障')
        const segments = [segment('阿岚望向墙角。', fight), segment('阿岚推开仓门。')]
        if (malformedOnce) {
          malformedOnce = false
          segments[0]!.shots[0]!.seconds = 13
        }
        return JSON.stringify({ ...chapterFields, segments })
      }
      if (instructions.includes('正在复核已经写出的')) {
        assert.match(instructions, /Screenplay Logic Optimizer/u)
        phases.push('review:' + data.title)
        const blocked = replan ? '原文的关键对白需要额外镜头。' : ''
        replan = false
        return JSON.stringify({ review: '承接清楚。', blocked, changes: [{ segment: 1, shot: 2, sound: '阿岚（低声）：“有人吗？”' }] })
      }
      assert.ok(instructions.includes('从这章最终采用的全部分镜提取'))
      assert.match(instructions, /人物美术精修/u)
      assert.match(data.storyboard.segments[0].shots[1].sound, /有人吗/u)
      phases.push('assets:' + data.title)
      return JSON.stringify({ assets: [
        { kind: 'character', name: data.title.includes('第一章') ? '阿岚' : '阿 岚', description: '深色外衣。', prompt: '深色外衣，3D 角色。', segments: [1] },
        ...(data.title.includes('第二章') ? [{ kind: 'creature', name: '墨兽', description: '水墨轮廓。', prompt: '水墨轮廓，3D。', segments: [1] }] : []),
      ] })
    },
    generateImage: async params => {
      assert.match(params.prompt, /生物设定图/u)
      assert.match(params.prompt, /自定义提示词/u)
      assert.deepEqual({ configId: params.configId, model: params.model }, imageSelection)
      const timestamp = new Date().toISOString()
      return db.insert(schema.sysTask).values({ type: 'image', status: 'processing',
        createdAt: timestamp, updatedAt: timestamp,
      }).returning({ id: schema.sysTask.id }).get().id
    },
  })
  const modelsResponse = await app.request('/models')
  assert.equal(modelsResponse.status, 200)
  const modelsBody = await modelsResponse.text()
  assert.doesNotMatch(modelsBody, /fixture-secret|localhost:9000/u)
  const modelOptions: ProjectModelOption[] = JSON.parse(modelsBody).data
  assert.deepEqual(modelOptions.filter(option => option.model === 'novel-writer').map(option => option.configId), [21, 22])
  assert.ok(modelOptions.some(option => option.kind === 'image' && option.model === 'selected-image'))
  assert.ok(modelOptions.some(option => option.model === 'wf-z-image'))
  assert.ok(!modelOptions.some(option => ['disabled-image', 'wf-qwen-image'].includes(option.model)))
  const form = new FormData()
  form.set('adaptationNotes', '保留故事主线')
  form.set('file', new File(['## 第一章 仓门\r\n阿岚推开仓门。\r\n## 第二章 墨影\r\n阿岚举灯向内，墨兽卷着水墨幻影扑来。'], '灯影.md'))
  const imported = await app.request('/', { method: 'POST', body: form })
  assert.equal(imported.status, 201)
  let project: NovelProject = (await imported.json()).data
  const projectPath = '/' + project.id
  assert.equal(project.pace, 'fast')
  assert.equal(project.models, undefined)
  assert.equal(project.adaptationNotes, '保留故事主线')
  assert.deepEqual(project.chapters.map(item => item.title), ['第一章 仓门', '第二章 墨影'])

  async function getProject() {
    project = (await (await app.request(projectPath)).json()).data
    return project
  }

  async function send(command: NovelCommand, status = 200, revision = project.revision) {
    const response = await app.request(projectPath + '/commands', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, revision }),
    })
    const json = await response.json()
    assert.equal(response.status, status, json.message)
    if (status === 200) project = json.data
  }

  async function waitFor(status: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      await getProject()
      if (project.job?.status !== 'running') break
      await delay(10)
    }
    assert.equal(project.job?.status, status, project.job?.error)
  }

  async function getChapter(number: number): Promise<NovelChapter> {
    return (await (await app.request(projectPath + '/chapters/' + number)).json()).data
  }

  await send({ action: 'chapter', chapter: 2 }, 400)
  await send({ action: 'selectModel', kind: 'text', selection: imageSelection }, 400)
  await send({ action: 'selectModel', kind: 'image', selection: { configId: 24, model: 'disabled-image' } }, 400)
  await send({ action: 'selectModel', kind: 'image', selection: { configId: 25, model: 'wf-qwen-image' } }, 400)
  await send({ action: 'selectModel', kind: 'text', selection: textSelection })
  await send({ action: 'selectModel', kind: 'image', selection: imageSelection })
  await getProject()
  assert.deepEqual(project.models, { text: textSelection, image: imageSelection })
  await send({ action: 'generate' })
  await waitFor('completed')
  assert.deepEqual(usedTextModel, textSelection)
  assert.deepEqual(project.chapters.map(item => item.version), [1, 1])
  assert.deepEqual(phases, ['draft:第一章 仓门', 'review:第一章 仓门', 'draft:第二章 墨影',
    'review:第二章 墨影', 'assets:第一章 仓门', 'assets:第二章 墨影'])
  const first = await getChapter(1)
  assert.equal(first.segmentCount, 2)
  assert.match((await getChapter(2)).storyboard!.segments[0].direction, /^8K 3D CG 写实/u)
  assert.doesNotMatch((await getChapter(2)).storyboard!.segments[1].direction, /^8K 3D CG 写实/u)
  assert.equal(first.storyboard?.segments[0].shots.reduce((sum, shot) => sum + shot.seconds, 0), 30)
  assert.equal(project.assetsCurrent, true)
  assert.equal(project.assets.length, 2)
  const person = project.assets.find(asset => asset.kind === 'character')!
  const creature = project.assets.find(asset => asset.kind === 'creature')!
  assert.deepEqual(person.appearances, [{ chapter: 1, segments: [1] }, { chapter: 2, segments: [1] }])

  await send({ action: 'image', assetId: creature.id, prompt: '自定义提示词' })
  await waitFor('completed')
  assert.equal(project.assets.find(asset => asset.id === creature.id)?.imageStatus, 'running')
  await send({ action: 'image', assetId: creature.id, prompt: '自定义提示词' }, 409)
  db.update(schema.sysTask).set({ status: 'completed', localPath: 'static/images/creature.png' })
    .where(eq(schema.sysTask.id, project.assets.find(asset => asset.id === creature.id)!.taskId!)).run()
  await getProject()
  assert.equal(project.assets.find(asset => asset.id === creature.id)?.image, '/static/images/creature.png')

  const oldRevision = project.revision
  await send({ action: 'pace', pace: 'normal' })
  await send({ action: 'chapter', chapter: 1, notes: '压短开场' }, 409, oldRevision)
  await send({ action: 'selectModel', kind: 'text', selection: null })
  assert.deepEqual(project.models, { image: imageSelection })
  failSegment = true
  phases.length = 0
  await send({ action: 'chapter', chapter: 1, notes: '压短开场' })
  await waitFor('failed')
  assert.equal(usedTextModel, undefined)
  assert.deepEqual(phases, ['draft:第一章 仓门'])
  assert.deepEqual(await getChapter(1), first)
  assert.equal(project.assetsCurrent, true)

  failSegment = false
  hold = true
  await send({ action: 'chapter', chapter: 1, notes: '压短开场' })
  const runningRevision = project.revision
  assert.equal((await app.request(projectPath, { method: 'DELETE' })).status, 409)
  await getProject()
  await send({ action: 'stop', jobId: project.job!.id }, 200, runningRevision)
  await waitFor('stopped')
  assert.deepEqual(await getChapter(1), first)
  hold = false

  phases.length = 0
  replan = true
  malformedOnce = true
  await send({ action: 'chapter', chapter: 1, notes: '压短开场' })
  await waitFor('completed')
  assert.deepEqual(phases, ['draft:第一章 仓门', 'draft:第一章 仓门', 'review:第一章 仓门',
    'draft:第一章 仓门', 'review:第一章 仓门', 'assets:第一章 仓门'])
  assert.deepEqual(project.chapters.map(item => item.version), [2, 1])
  assert.equal((await getChapter(1)).storyboard?.pace, 'normal')
  assert.equal(project.assets.find(asset => asset.kind === 'character')?.id, person.id)
  assert.equal(project.assets.find(asset => asset.id === creature.id)?.image, '/static/images/creature.png')

  const secondFile = new FormData()
  secondFile.set('file', new File(['第一章 新故事\n灯亮了。'], '另一部小说.txt'))
  const second = await app.request('/', { method: 'POST', body: secondFile })
  assert.equal(second.status, 201)
  const other: NovelProject = (await second.json()).data

  assert.equal((await app.request(projectPath, { method: 'DELETE' })).status, 200)
  assert.equal((await app.request(projectPath)).status, 404)
  assert.equal((await app.request(projectPath + '/chapters/1')).status, 404)
  assert.equal((await app.request(projectPath, { method: 'DELETE' })).status, 404)
  const directory = (await (await app.request('/')).json()).data
  assert.deepEqual(directory.map((item: { id: string }) => item.id), [other.id])
  assert.equal((await app.request('/' + other.id + '/chapters/1')).status, 200)
})

for (const limit of ['output', 'input'] as const) {
  test('整章' + (limit === 'output' ? '输出' : '输入') + '容量不足时分批覆盖原文，保持末镜与复核编号', async () => {
    const { novelStoryboardAgent } = await import('../src/services/novel-storyboard-agent.js')
    const sourceParts = ['阿岚举灯。', '阿岚推门。', '阿岚拿到账本。', '阿岚走出仓房。']
    const source = sourceParts.join('')
    const calls: string[] = []
    const writtenSource: string[] = []
    const reviewedSource: string[] = []
    const tooLong = () => Object.assign(new Error('maximum context length exceeded'), { statusCode: 413 })
    const agent = novelStoryboardAgent(async ({ instructions, message }) => {
      const data = JSON.parse(message)
      if (instructions.includes('一次提交整章的正式逐镜分镜')) {
        calls.push('whole')
        assert.equal(data.source, source)
        if (limit === 'input') throw tooLong()
        return '{"summary":"输出中途截断'
      }
      if (instructions.includes('当前只编排本章大纲')) {
        calls.push('plan')
        assert.deepEqual(data.sourceParts, sourceParts)
        assert.equal(data.source, undefined)
        return JSON.stringify({ ...chapterFields, segments: sourceParts.map((original, index) => ({
          sourceStart: index + 1, event: original, sourceClues: original, combat: false, fightDetails: '',
        })) })
      }
      if (instructions.includes('只写当前批次指定的视频编号')) {
        const { firstSegment, sections } = data
        calls.push('batch:' + firstSegment + '/' + sections.length)
        if (firstSegment === 1 && sections.length === 2) return '{"segments":['
        if (firstSegment > 1) assert.equal(data.previousFrame.shot.action, sourceParts[firstSegment - 2])
        writtenSource.push(data.source)
        return JSON.stringify({ segments: sections.map(({ event }: { event: string }) => segment(event)) })
      }
      assert.match(instructions, /正在复核已经写出的/u)
      const { firstSegment, segments } = data
      calls.push('review:' + firstSegment + '/' + segments.length)
      if (segments.length === 4) {
        assert.equal(data.source, source)
        throw tooLong()
      }
      if (firstSegment === 1) assert.equal(data.followingCut.shot.action, '阿岚举灯向内。')
      else assert.equal(data.precedingCut.shot.action, sourceParts[1])
      reviewedSource.push(data.source)
      return JSON.stringify({
        review: '本批通过', blocked: '', changes: [{ segment: firstSegment, shot: 2, sound: '复核后拟音' }],
      })
    }, new AbortController().signal, () => {})

    const result = await agent.storyboard({ title: '仓房', source, pace: 'fast', version: 1 })
    assert.deepEqual(calls, ['whole', 'plan', 'batch:1/2', 'batch:1/1', 'batch:2/1', 'batch:3/2',
      'review:1/4', 'review:1/2', 'review:3/2'])
    assert.equal(writtenSource.join(''), source)
    assert.equal(reviewedSource.join(''), source)
    assert.deepEqual(result.segments.map(item => item.shots.at(-1)?.action), sourceParts)
    assert.deepEqual(result.segments.map(item => item.shots.at(-1)?.sound), ['复核后拟音', '仓门响。', '复核后拟音', '仓门响。'])
  })
}
