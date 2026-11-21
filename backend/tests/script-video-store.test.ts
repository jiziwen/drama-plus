import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { OUTLINE_DURATION_POLICY, ScriptVideoStore, ScriptVideoStoreError } from '../src/services/script-video-store'
import { getScriptVideoStylePreset } from '../src/services/script-video-style'
import type { ScriptVideoGenerationStatus } from '../src/services/script-video-generation'

const STYLE = { id: 'custom' as const, name: '夜色写实', prefix: '  冷色原文\r\n\r\n声音规则  \r\n' }
const STYLE_TWO = { id: 'custom' as const, name: '暖色质感', prefix: '暖色原文\n\n灯光规则\n' }

async function fixture(run: (store: ScriptVideoStore, directory: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'script-video-store-'))
  const store = new ScriptVideoStore(dir)
  try { await run(store, dir) } finally { await store.close(); rmSync(dir, { recursive: true, force: true }) }
}

test('persists isolated projects and episodes across store instances', async () => fixture(async (store, dir) => {
  const a = await store.create('甲'), b = await store.create('乙')
  a.assets.push({ id: 'asset-1', name: '角色_一', kind: 'character', image: '/static/uploads/a.png' })
  a.episodes[0].script = '原始剧本\n完整内容'
  const saved = await store.update(a.id, a, a.revision)
  const restarted = new ScriptVideoStore(dir)
  assert.deepEqual(await restarted.get(a.id), saved)
  assert.equal((await restarted.get(b.id)).episodes[0].script, '')
  assert.equal((await restarted.list()).length, 2)
  await assert.rejects(store.get('../escape'), (e: unknown) => e instanceof ScriptVideoStoreError && e.status === 400)
}))

test('conflicting writes cannot overwrite and client cannot forge tasks, status or video URL', async () => fixture(async store => {
  const p = await store.create('剧目')
  p.episodes[0].cards = [{ id: 'card-1', prompt: '画面', shots: [], assetIds: [], version: 200, status: 'ready', videoUrl: '/fake.mp4' }]
  p.episodes[0].tasks = [{ status: 'completed', videoUrl: '/fake.mp4' }]
  const one = await store.update(p.id, p, p.revision)
  assert.equal(one.episodes[0].cards[0].status, 'draft')
  assert.equal(one.episodes[0].cards[0].version, 1)
  assert.equal(one.episodes[0].cards[0].videoUrl, undefined)
  assert.deepEqual(one.episodes[0].tasks, [])
  const same = structuredClone(one), other = structuredClone(one)
  same.title = '修改一'; other.title = '修改二'
  const result = await Promise.allSettled([store.update(p.id, same, one.revision), store.update(p.id, other, one.revision)])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(result.filter(r => r.status === 'rejected' && r.reason instanceof ScriptVideoStoreError && r.reason.status === 409).length, 1)
  const current = await store.get(p.id)
  assert.equal(current.revision, one.revision + 1)
  assert.ok(['修改一', '修改二'].includes(current.title))
}))

test('rejects nonlocal images without modifying saved data', async () => fixture(async store => {
  const project = await store.create('未改动')
  for (const image of ['blob:bad', 'data:image/png;base64,AA==', 'https://example.test/a.png', '/static/%2e%2e/secret']) {
    const edited = structuredClone(project)
    edited.assets = [{ id: 'a', name: '角色', kind: 'character', image }]
    await assert.rejects(store.update(project.id, edited, project.revision), ScriptVideoStoreError)
    assert.deepEqual(await store.get(project.id), project)
  }
}))

test('分集独立保存角色造型备注，旧客户端省略字段时沿用原值', async () => fixture(async store => {
  const project = await store.create('造型备注')
  const [episode] = project.episodes
  project.episodes.push({ ...episode, id: 'episode-2', number: 2 })
  episode.characterAppearanceNotes = ' 真人用咖妃，小剧场用咖妃_3DQ版。 '
  const saved = await store.update(project.id, project, project.revision)
  assert.equal(saved.episodes[0].characterAppearanceNotes, '真人用咖妃，小剧场用咖妃_3DQ版。')
  assert.equal(saved.episodes[1].characterAppearanceNotes, undefined)
  const olderClient = structuredClone(saved)
  delete olderClient.episodes[0].characterAppearanceNotes
  const preserved = await store.update(project.id, olderClient, saved.revision)
  assert.equal(preserved.episodes[0].characterAppearanceNotes, saved.episodes[0].characterAppearanceNotes)
  const invalid = structuredClone(preserved)
  invalid.episodes[0].characterAppearanceNotes = '造'.repeat(1501)
  await assert.rejects(store.update(project.id, invalid, preserved.revision), ScriptVideoStoreError)
}))

test('video duration preferences survive older clients and leave the storyboard version intact', async () => fixture(async store => {
  const project = await store.create('生成时长')
  project.episodes[0].cards = ['a', 'b', 'c'].map(id => ({ id, duration: 30, shots: [], assetIds: [], prompt: '' }))
  const first = await store.update(project.id, project, project.revision)
  first.episodes[0].videoDurations = { a: 12, b: 8, c: 31, deleted: 5 }
  const adjusted = await store.update(project.id, first, first.revision)
  assert.deepEqual(adjusted.episodes[0].videoDurations, { a: 12, b: 8 })
  assert.deepEqual(adjusted.episodes[0].cards.map((card: any) => [card.duration, card.version]), [[30, 1], [30, 1], [30, 1]])

  delete adjusted.episodes[0].videoDurations
  adjusted.episodes[0].cards.splice(1, 1)
  const preserved = await store.update(project.id, adjusted, adjusted.revision)
  assert.deepEqual(preserved.episodes[0].videoDurations, { a: 12 })

  preserved.episodes[0].videoDurations = {}
  assert.equal((await store.update(project.id, preserved, preserved.revision)).episodes[0].videoDurations, undefined)
}))

test('editing an unused project asset preserves completed and pending card versions', async () => fixture(async store => {
  const project = await store.create('修改未引用素材')
  const [episode] = project.episodes
  const shown = { id: 'shown', name: '灯笼', kind: 'prop', image: '/static/uploads/shown.png' }
  const unused = { id: 'unused', name: '长剑', kind: 'prop', image: '/static/uploads/unused.png' }
  project.assets = [shown, unused]
  episode.cards = [voiceCard('shown', shown, '无对白。'), voiceCard('unused', unused, '无对白。')]
  await store.update(project.id, project, project.revision)
  const videoUrl = '/static/videos/already-generated.mp4'
  await store.mutate(project.id, ({ project }) => {
    Object.assign(project.episodes[0].cards[0], { status: 'ready', videoUrl })
    return { result: null, documentChanged: true }
  })
  const current = await store.get(project.id)
  current.assets[1].image = '/static/uploads/unused-new.png'
  const saved = await store.update(project.id, current, current.revision)
  const [readyCard, changedCard] = saved.episodes[0].cards
  assert.deepEqual([readyCard.status, readyCard.version, readyCard.videoUrl], ['ready', 1, videoUrl])
  assert.equal(changedCard.version, 2)
  saved.assets[0].image = '/static/uploads/shown-new.png'
  const changed = await store.update(project.id, saved, saved.revision)
  assert.deepEqual([changed.episodes[0].cards[0].status, changed.episodes[0].cards[0].videoUrl], ['draft', videoUrl])
}))

test('restores a missing card result only from a successful current-version job', async () => fixture(async store => {
  const project = await store.create('恢复已生成状态')
  const [episode] = project.episodes
  const asset = { id: 'lamp', name: '灯笼', kind: 'prop', image: '/static/uploads/lamp.png' }
  project.assets = [asset]
  episode.cards = ['matching', 'edited', 'stale'].map(id => voiceCard(id, asset, '无对白。'))
  await store.update(project.id, project, project.revision)
  const time = new Date().toISOString()
  await store.mutate(project.id, ({ project, jobs }) => {
    const episode = project.episodes[0]
    episode.cards[1].version++
    for (const [index, card] of episode.cards.entries()) {
      const common = { id: `completed-${card.id}`, taskId: index + 1, cardId: card.id,
        cardVersion: 1, status: 'completed' as const, staleResult: index === 2, createdAt: time }
      episode.tasks.push({ ...common, videoUrl: `/static/videos/${card.id}.mp4` })
      jobs.push({ ...common, projectId: project.id, episodeId: episode.id, action: 'video', updatedAt: time })
    }
    return { result: null, documentChanged: true }
  })
  const { cards } = (await store.get(project.id)).episodes[0]
  assert.deepEqual(cards.map((card: { status: string; videoUrl?: string }) => [card.status, card.videoUrl]), [
    ['ready', '/static/videos/matching.mp4'],
    ['draft', undefined],
    ['draft', undefined],
  ])
}))

test('角色声音安全持久化，声音变更使分镜版本失效，非法资产拒绝保存', async () => fixture(async store => {
  const project = await store.create('角色声音')
  project.assets = [{id:'a',name:'角色',kind:'character',image:'/static/uploads/a.png',voiceAudio:{url:'/static/uploads/voice.wav',name:'原声.wav',mimeType:'audio/wav',duration:3}}]
  // Legacy delivery without a dialogue field still sends a selected character's voice.
  project.episodes[0].modelName = 'doubao-seedance-2-0-260128'
  project.episodes[0].modelProvider = 'volcengine'
  project.episodes[0].cards = [{id:'card-1',prompt:'@角色',shots:[],assetIds:['a'],status:'draft',version:1}]
  const saved = await store.update(project.id, project, project.revision)
  assert.deepEqual((await store.get(project.id)).assets[0].voiceAudio, project.assets[0].voiceAudio)
  const changed = structuredClone(saved)
  changed.assets[0].voiceAudio.url = '/static/uploads/new.wav'
  const newer = await store.update(project.id, changed, saved.revision)
  assert.ok(newer.episodes[0].cards[0].version > saved.episodes[0].cards[0].version)
  for (const patch of [
    {kind:'scene'}, {voiceAudio:{url:'/static/uploads/../bad.wav',name:'坏文件'}},
    {voiceAudio:{url:'https://example.test/a.wav',name:'坏文件'}},
    {voiceAudio:{url:'/static/uploads/a.wav',name:'x'.repeat(256)}},
    {voiceAudio:{url:'/static/uploads/a.wav',name:'x',duration:-1}},
    {voiceAudio:{url:'/static/uploads/a.wav',name:'x',extra:'x'}},
    {voiceMode:'automatic'},
    {kind:'scene',voiceAudio:undefined,voiceMode:'model'},
  ]) {
    const invalid = structuredClone(newer)
    invalid.assets[0] = {...invalid.assets[0], ...patch}
    await assert.rejects(store.update(project.id, invalid, newer.revision), ScriptVideoStoreError)
    assert.deepEqual(await store.get(project.id), JSON.parse(JSON.stringify(newer)))
  }
}))

function voiceAsset(id: string, name: string) {
  return { id, name, kind: 'character', image: `/static/uploads/${id}.png`,
    voiceAudio: { url: `/static/uploads/${id}.wav`, name: `${name}.wav` } }
}

function voiceCard(id: string, asset: { id: string; name: string }, dialogue: string) {
  const action = `@${asset.name}站在门边。`
  return { id, title: id, duration: 5, version: 1, status: 'draft', assetIds: [asset.id],
    prompt: `镜头 01（0–5秒）\n画面与动作：${action}\n对白／音效：${dialogue}`,
    shots: [{ id: `${id}-shot`, duration: 5, camera: '中景', action, dialogue }] }
}

test('更新角色声音设置只让实际声音来源变动的未出片分镜升版', async () => fixture(async store => {
  const project = await store.create('只更新受影响的分镜')
  const lead = voiceAsset('lead', '阿宁')
  const other = { id: 'other', name: '小禾', kind: 'character', image: '/static/uploads/other.png', voiceMode: 'model' as const }
  project.assets = [lead, other]
  const episode = project.episodes[0]
  episode.modelName = 'seedance2.5-ae-480p'
  episode.modelProvider = 'aicost'
  episode.cards = [
    voiceCard('dialogue', lead, '@阿宁：“我回来了。”'),
    voiceCard('inner', lead, '@阿宁（OS）：“该走了。”'),
    voiceCard('visual-only', lead, '无对白。'),
    voiceCard('unrelated', other, '@小禾：“轮到我了。”'),
    voiceCard('ready', lead, '@阿宁：“别等我了。”'),
    voiceCard('ready-model', other, '@小禾（OS）：“别等我了。”'),
  ]
  await store.update(project.id, project, project.revision)
  await store.mutate(project.id, ({ project, jobs }) => {
    const episode = project.episodes[0]
    for (const [index, card] of episode.cards.slice(4).entries()) {
      const taskId = 521 + index
      const task = { id: `completed-${card.id}`, taskId, cardId: card.id, cardVersion: card.version, status: 'completed' as const,
        videoUrl: `/static/videos/task-${taskId}.mp4`, createdAt: new Date().toISOString() }
      Object.assign(card, { status: 'ready', videoUrl: task.videoUrl })
      episode.tasks.push(task)
      jobs.push({ ...task, projectId: project.id, episodeId: episode.id, action: 'video', updatedAt: task.createdAt })
    }
    return { result: null, documentChanged: true }
  })

  const before = await store.get(project.id)
  const changed = structuredClone(before)
  changed.assets[0].voiceAudio.url = '/static/uploads/lead-new.wav'
  const saved = await store.update(project.id, changed, before.revision)
  const previousCards = before.episodes[0].cards
  const cards = saved.episodes[0].cards
  for (const index of [0, 1]) {
    assert.equal(cards[index].version, previousCards[index].version + 1)
    assert.equal(cards[index].status, 'draft')
  }
  for (const index of [2, 3, 4, 5]) {
    assert.equal(cards[index].version, previousCards[index].version)
    assert.equal(cards[index].status, previousCards[index].status)
    assert.equal(cards[index].videoUrl, previousCards[index].videoUrl)
  }
  assert.equal(cards[4].status, 'ready')
  assert.equal(cards[4].videoUrl, '/static/videos/task-521.mp4')
  assert.deepEqual(saved.episodes[0].tasks, before.episodes[0].tasks)

  const modeChange = structuredClone(saved)
  modeChange.assets[0].voiceMode = 'model'
  modeChange.assets[0].voiceAudio.name = '重命名.wav'
  modeChange.assets[1].voiceMode = 'reference'
  const savedMode = await store.update(project.id, modeChange, saved.revision)
  assert.deepEqual((await store.get(project.id)).assets, modeChange.assets)
  const modeCards = (await store.episode(project.id, episode.id)).episode.cards
  assert.equal(modeCards[3].version, cards[3].version + 1)
  assert.equal(modeCards[3].status, 'draft')
  for (const index of [0, 1, 2, 4, 5]) {
    assert.equal(modeCards[index].version, cards[index].version)
    assert.equal(modeCards[index].status, cards[index].status)
    assert.equal(modeCards[index].videoUrl, cards[index].videoUrl)
  }
  assert.equal(modeCards[5].status, 'ready')
  assert.equal(modeCards[5].videoUrl, '/static/videos/task-522.mp4')
  assert.deepEqual(savedMode.episodes[0].tasks, saved.episodes[0].tasks)

  // Restoring the default via a small collaboration write updates only the
  // affected unfinished speaker, keeping completed clips and silent cards.
  const savedImplicit = await store.applyChanges(project.id, { clientId: 'voice-editor', sequence: 1,
    changes: [{ target: 'asset', id: other.id, unset: ['voiceMode'] }], loadedEpisodeIds: [episode.id] })
  assert.equal(savedImplicit.project.assets[1].voiceMode, undefined)
  assert.deepEqual(savedImplicit.episodes[0].cards, modeCards.map((card: any) =>
    card.id === 'unrelated' ? { ...card, version: card.version + 1 } : card))

  const savedWithAudio = await store.applyChanges(project.id, { clientId: 'voice-editor', sequence: 2,
    changes: [{ target: 'asset', id: lead.id, fields: { voiceMode: 'reference' } }], loadedEpisodeIds: [episode.id] })
  assert.equal(savedWithAudio.project.assets[0].voiceMode, 'reference')
  assert.deepEqual(savedWithAudio.episodes, savedImplicit.episodes)
}))

test('保存旧风格提示词时只清除前缀标题和多余尾部空行，保留预设原文和手改正文', async () => fixture(async store => {
  const style = getScriptVideoStylePreset('cool')!
  const project = await store.create('风格', style)
  const body = '←承上：开门\n\n镜头 01（0–3秒）\n画面与动作：角色开门\n\n\n手写保留空行'
  project.episodes[0].cards = [{ id:'card-1', prompt:style.prefix + '\n' + body, shots:[{id:'s',action:'开门'}], assetIds:[], status:'draft', version:1 }]
  const saved = await store.update(project.id, project, project.revision)
  const prompt = saved.episodes[0].cards[0].prompt
  assert.equal(saved.settings.stylePreset.prefix, style.prefix)
  assert.ok(!prompt.startsWith('冷色调'))
  assert.ok(prompt.includes('全局核心要求复核确认'))
  assert.ok(prompt.endsWith(body))
  assert.doesNotMatch(prompt, /(?:\r?\n){3,}←承上/)
  const edit = structuredClone(saved)
  edit.episodes[0].cards[0].shots[0].action = '关门'
  edit.episodes[0].cards[0].prompt = style.prefix + '\n' + body
  edit.episodes[0].cards[0].promptNeedsSync = false
  const modified = await store.update(saved.id, edit, saved.revision)
  assert.equal(modified.episodes[0].cards[0].promptNeedsSync, true)
}))

test('读取旧存档时规范当前提示词而不改磁盘及历史', async () => fixture(async (store, directory) => {
  const style = getScriptVideoStylePreset('cool')!
  const project = await store.create('旧项目', style)
  project.episodes[0].cards = [{id:'c',prompt:'正文',shots:[],assetIds:[],status:'draft',version:1}]
  const saved = await store.update(project.id, project, project.revision)
  const legacy = join(directory, 'legacy')
  mkdirSync(legacy)
  const filename = join(legacy, project.id + '.json')
  const record = { project: saved, jobs: [] }
  const oldPrompt = style.prefix + '\n←承上：保留正文'
  record.project.episodes[0].cards[0].prompt = oldPrompt
  record.project.episodes[0].generationsHistory = [{cards:[{prompt:oldPrompt}]}]
  writeFileSync(filename, JSON.stringify(record))
  const before = readFileSync(filename, 'utf8')
  const migrated = new ScriptVideoStore(legacy)
  for (const retrieved of [await migrated.get(saved.id), (await migrated.list())[0]]) {
    assert.ok(!retrieved.episodes[0].cards[0].prompt.startsWith('冷色调'))
    assert.ok(retrieved.episodes[0].cards[0].prompt.endsWith('←承上：保留正文'))
    assert.equal(retrieved.episodes[0].generationsHistory[0].cards[0].prompt, oldPrompt)
    assert.equal(retrieved.revision, saved.revision)
  }
  assert.equal(readFileSync(filename, 'utf8'), before)
}))

test('interrupted AI jobs fail on restart and do not alter project', async () => fixture(async (store, dir) => {
  const project = await store.create('中断任务')
  const now = new Date().toISOString()
  await store.mutate(project.id, record => { record.jobs.push({ id: 'job-1', projectId: project.id, episodeId: project.episodeId, action: 'storyboard', status: 'running', createdAt: now, updatedAt: now, resumeKey:'private-digest', progress:{phase:'generating',completed:1,total:2}, checkpoint:{cards:[{id:'private-content'} as any]} }); return { result: null } })
  const restarted = new ScriptVideoStore(dir)
  const job = await restarted.getJob(project.id, 'job-1')
  assert.equal(job.status, 'failed')
  assert.equal(job.code, 'INTERRUPTED')
  assert.deepEqual(job.progress, {phase:'generating',completed:1,total:2})
  assert.equal(job.checkpoint, undefined)
  const privateState = await restarted.mutate(project.id, record => ({result: record.jobs[0].checkpoint}))
  assert.equal(privateState?.cards[0].id, 'private-content')
  assert.deepEqual(await restarted.get(project.id), project)
}))

test('server mutation failure leaves confirmed state untouched', async () => fixture(async store => {
  const project = await store.create('保留原文')
  await assert.rejects(store.mutate(project.id, record => { record.project.episodes[0].script = '不应写入'; throw new Error('模拟生成失败') }))
  assert.deepEqual(await store.get(project.id), project)
}))

test('新大纲的时长规则由服务端维护，确认时校验并兼容旧稿', async () => fixture(async store => {
  let project = await store.create('大纲规则')
  const ep = project.episodes[0]
  ep.cards = [{id:'c1',duration:20,shots:[],assetIds:[],prompt:''},{id:'c2',duration:8,shots:[],assetIds:[],prompt:''}]
  ep.outlineConfirmed = true
  ep.outlineDurationPolicy = '30-except-tail-v1'
  project = await store.update(project.id, project, project.revision)
  assert.equal(project.episodes[0].outlineDurationPolicy, undefined)
  assert.equal(project.episodes[0].outlineConfirmed, true)
  await store.mutate(project.id, record => {
    record.project.episodes[0].outlineDurationPolicy = '30-except-tail-v1'
    record.project.episodes[0].outlineConfirmed = false
    return { result:null, documentChanged:true }
  })
  project = await store.get(project.id)
  const forged = structuredClone(project)
  delete forged.episodes[0].outlineDurationPolicy
  forged.episodes[0].outlineConfirmed = true
  forged.episodes[0].cards[0].duration = 31
  await assert.rejects(store.update(project.id, forged, project.revision), (e:any) => e.code === 'OUTLINE_DURATION' && /重新编排/.test(e.message))
  const draft = structuredClone(project)
  draft.episodes[0].outlineDurationPolicy = 'different'
  const savedDraft = await store.update(project.id, draft, project.revision)
  assert.equal(savedDraft.episodes[0].outlineDurationPolicy, '30-except-tail-v1')
  const fixed = structuredClone(savedDraft)
  fixed.episodes[0].cards[0].duration = 20
  fixed.episodes[0].outlineConfirmed = true
  const confirmed = await store.update(project.id, fixed, savedDraft.revision)
  assert.equal(confirmed.episodes[0].outlineConfirmed, true)
  assert.equal(confirmed.episodes[0].cards[0].duration, 20)
  assert.equal(confirmed.episodes[0].cards[1].duration, 8)
}))


test('server video state is authoritative and interrupted paid submissions cannot be silently retried', async () => fixture(async (store, dir) => {
  const project = await store.create('视频')
  project.episodes[0].cards = [{ id: 'card-1', prompt: '画面', shots: [], assetIds: [], version: 1, status: 'draft' }]
  const saved = await store.update(project.id, project, project.revision)
  const now = new Date().toISOString()
  await store.mutate(project.id, record => {
    const episode = record.project.episodes[0]
    episode.tasks.push({ id: 'video-known', status: 'processing' }, { id: 'video-unknown', status: 'processing' })
    record.jobs.push({ id: 'video-known', projectId: project.id, episodeId: episode.id, action: 'video', status: 'running', taskId: 12, createdAt: now, updatedAt: now })
    record.jobs.push({ id: 'video-unknown', projectId: project.id, episodeId: episode.id, action: 'video', status: 'queued', createdAt: now, updatedAt: now })
    return { result: null, documentChanged: true }
  })
  const restarted = new ScriptVideoStore(dir)
  assert.equal((await restarted.getJob(project.id, 'video-known')).status, 'running')
  const unknown = await restarted.getJob(project.id, 'video-unknown')
  assert.equal(unknown.status, 'failed')
  assert.equal(unknown.code, 'SUBMISSION_UNKNOWN')
  const latest = await restarted.get(project.id)
  assert.equal(latest.episodes[0].tasks[1].code, 'SUBMISSION_UNKNOWN')
  assert.ok(latest.revision > saved.revision)
}))

// Real Hono endpoints, with delayed provider calls to expose races deterministically.
test('AI and paid video jobs reject stale writes and prevent duplicate submission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'script-video-routes-'))
  const previousDb = process.env.SQLITE_PATH, previousData = process.env.HUOBAO_DATA_DIR
  process.env.SQLITE_PATH = join(dir, 'test.sqlite3'); process.env.HUOBAO_DATA_DIR = dir
  try {
    const { createScriptVideoRoutes } = await import('../src/routes/script-video')
    const store = new ScriptVideoStore(join(dir, 'projects'))
    let project = await store.create('并发测试', STYLE)
    project.episodes[0].script = project.episodes[0].confirmedScript = '甲推开门。'
    const appearanceNotes = '甲沿用便服。'
    project.episodes[0].characterAppearanceNotes = appearanceNotes
    project.episodes[0].confirmed = true
    project.episodes[0].outlineConfirmed = true
    const oldProduction = { stylePreset: STYLE_TWO, coreRhythm: '旧节奏', characters: [{ name: '甲', appearance: '甲', voice: '原音' }] }
    const newProduction = { stylePreset: STYLE, coreRhythm: '新节奏', characters: [{ name: '甲', appearance: '甲', voice: '原音' }] }
    project.episodes[0].production = oldProduction
    project.episodes[0].cards = [{ id: 'card-1', title: '开门', prompt: '甲推开门', duration: 3, shots: [{ id: 's1', duration: 3, camera: '中景', action: '甲推开门', dialogue: '' }], assetIds: [], status: 'draft', version: 1 }]
    project = await store.update(project.id, project, project.revision)
    const episodeId = project.episodeId
    let finishOutline!: (value: any) => void, outlineCalls = 0
    const outline = new Promise(resolve => { finishOutline = resolve })
    let finishVideo!: (value: any) => void, starts = 0
    const video = new Promise(resolve => { finishVideo = resolve })
    let revisionSource = '', revisionProduction: any, revisionStyle: any, outlineStyle: any, outlineNotes: string | undefined, recovered = 0
    let videoState: any = { taskId: 123, status: 'failed', stage: 'delivery_failed', code: 'DELIVERY_FAILED', error: '保存失败' }
    let reviewCalls = 0
    const dependencies: any = {
      generateScriptVideoOutline: (input: any) => { outlineCalls++; outlineStyle = input.stylePreset; outlineNotes = input.characterAppearanceNotes; return outline },
      generateScriptVideoCards: async ({ outline }: any) => ({ cards: outline.map((card: any) => ({ ...card, prompt: 'AI更新后的提示词' })), production: newProduction, skillReads: [], attempts: 1 }),
      reviewScriptVideoEpisode: async ({ cards, script }: any) => {
        assert.equal(script, '甲推开门。')
        reviewCalls++
        return { passed: false, issues: [{ cardId: cards[0].id, message: '请核对开门方向' }], continuityReview: '开门方向存在歧义' }
      },
      reviseScriptVideoCard: async ({ card, production, stylePreset }: any) => { revisionSource = card.prompt; revisionProduction = production; revisionStyle = stylePreset; return { card: { ...card, prompt: '候选' }, summary: '调整', skillReads: [], attempts: 1 } },
      assertScriptVideoFormal: ({ production }: any) => { if (!production) throw new Error('missing production') },
      startScriptVideoGeneration: () => { starts++; return starts === 1 ? video : Promise.resolve({ taskId: 124, status: 'processing' }) },
      getScriptVideoGeneration: async (taskId: number) => ({ ...videoState, taskId }),
      recoverVideoTask: async () => { recovered++ },
    }
    const app = createScriptVideoRoutes(store, dependencies)
    const session = randomUUID()
    const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': session }
    const post = (path: string, body: unknown) => app.request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const deleteProject = (id: string) => app.request(`http://localhost/projects/${id}`, { method: 'DELETE', headers })
    const root = `/projects/${project.id}/episodes/${episodeId}`
    assert.equal((await post(`${root}/lock`, {})).status, 200)
    const createdWithStyle = await post('/projects', { title: '通过接口创建', stylePreset: STYLE })
    assert.equal(createdWithStyle.status, 201)
    const disposable = ((await createdWithStyle.json()) as any).data
    assert.deepEqual(disposable.settings.stylePreset, STYLE)
    const deleted = await deleteProject(disposable.id)
    assert.equal(deleted.status, 200)
    assert.deepEqual(((await deleted.json()) as any).data, { id: disposable.id })
    assert.equal((await deleteProject(disposable.id)).status, 404)
    assert.deepEqual((await store.list()).map(item => item.id), [project.id])
    assert.equal((await post('/projects', { title: '错误风格', stylePreset: { id: 'custom' } })).status, 400)
    assert.equal((await post(`${root}/validate`, {})).status, 200)
    await store.mutate(project.id, record => { record.project.episodes[0].cards[0].promptNeedsSync = true; return { result: null, documentChanged: true } })
    const unsynced = await post(`${root}/validate`, {})
    assert.equal(unsynced.status, 422)
    assert.equal(((await unsynced.json()) as any).errorCode, 'PROMPT_NEEDS_SYNC')
    const unsyncedVideo = await post(`${root}/cards/card-1/video`, { expectedCardVersion: 1, configId: 1, model: 'm', aspectRatio: '16:9', resolution: '720P' })
    assert.equal(unsyncedVideo.status, 422)
    assert.equal(starts, 0)
    await store.mutate(project.id, record => { record.project.episodes[0].cards[0].promptNeedsSync = false; return { result: null, documentChanged: true } })
    assert.equal((await post(`${root}/validate`, { cardIds: ['missing'] })).status, 404)
    const presets = await app.request('http://localhost/style-presets')
    assert.equal(presets.status, 200)
    const presetRows = ((await presets.json()) as any).data
    assert.deepEqual(presetRows.map((row: any) => row.id), ['cool', 'warm'])
    assert.ok(presetRows.every((row: any) => typeof row.prefix === 'string' && row.prefix.length > 0))
    const started = await post(`${root}/outline`, { stylePreset: STYLE_TWO })
    assert.equal(started.status, 201)
    const jobId = ((await started.json()) as any).data.id
    const duplicateAI = await post(`${root}/outline`, {})
    assert.equal(duplicateAI.status, 409)
    assert.equal(((await duplicateAI.json()) as any).errorCode, 'AI_ACTIVE')
    const activeOutlineDeletion = await deleteProject(project.id)
    assert.equal(activeOutlineDeletion.status, 409)
    assert.equal(((await activeOutlineDeletion.json()) as any).errorCode, 'PROJECT_BUSY')
    for (let i = 0; i < 100 && !outlineCalls; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(outlineCalls, 1)
    assert.deepEqual(outlineStyle, STYLE)
    assert.equal(outlineNotes, appearanceNotes)
    let changed = await store.get(project.id)
    changed.episodes[0].cards[0].summary = '生成期间编辑的分镜'
    changed = await store.update(changed.id, changed, changed.revision, session)
    finishOutline({ cards: [{ id: 'fake', title: '过期内容', duration: 30 }], skillReads: [], attempts: 1 })
    let job = await store.getJob(project.id, jobId)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(job.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); job = await store.getJob(project.id, jobId) }
    assert.equal(job.code, 'STALE')
    assert.equal((job.result as any).cards[0].title, '过期内容')
    assert.equal((await store.get(project.id)).episodes[0].cards[0].id, 'card-1')
    assert.equal((await store.get(project.id)).episodes[0].cards[0].summary, '生成期间编辑的分镜')
    changed = await store.get(project.id)
    changed.episodes[0].script = '用户已更新剧本'
    changed = await store.update(changed.id, changed, changed.revision, session)
    const reviseResponse = await post(`${root}/revisions`, { cardId: 'card-1', instruction: '更清楚', sourcePrompt: '未经采用的候选' })
    assert.equal(reviseResponse.status, 201)
    const revisionId = ((await reviseResponse.json()) as any).data.id
    let revision = await store.getJob(project.id, revisionId)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(revision.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); revision = await store.getJob(project.id, revisionId) }
    assert.equal(revision.status, 'completed')
    assert.equal(revisionSource, '未经采用的候选')
    assert.deepEqual(revisionProduction, oldProduction)
    assert.deepEqual(revisionStyle, STYLE_TWO)
    assert.equal((revision.result as any).card.prompt, '候选')
    assert.ok((await store.get(project.id)).episodes[0].cards[0].prompt.endsWith('甲推开门'))
    const videoBody = { expectedCardVersion: changed.episodes[0].cards[0].version, configId: 1, model: 'configured-model', aspectRatio: '16:9', resolution: '720P' }
    const first = post(`${root}/cards/card-1/video`, videoBody)
    for (let i = 0; i < 100 && starts === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(starts, 1)
    const duplicate = await post(`${root}/cards/card-1/video`, videoBody)
    assert.equal(duplicate.status, 409)
    assert.equal(starts, 1)
    const activeVideoDeletion = await deleteProject(project.id)
    assert.equal(activeVideoDeletion.status, 409)
    assert.equal(((await activeVideoDeletion.json()) as any).errorCode, 'PROJECT_BUSY')
    finishVideo({ taskId: 123, status: 'processing' })
    assert.equal((await first).status, 201)
    const failed = await app.request(`http://localhost/projects/${project.id}/video/123`)
    assert.equal(((await failed.json()) as any).data.code, 'DELIVERY_FAILED')
    const blocked = await post(`${root}/cards/card-1/video`, videoBody)
    assert.equal(blocked.status, 409)
    assert.equal(((await blocked.json()) as any).errorCode, 'DELIVERY_FAILED')
    const recovery = await post(`/projects/${project.id}/video/123/recover`, {})
    assert.equal(recovery.status, 200)
    assert.equal(recovered, 1)
    videoState = { taskId: 123, status: 'completed', stage: 'complete', videoUrl: '/static/result.mp4' }
    const latest = await store.get(project.id)
    latest.episodes[0].cards[0].prompt = '用户修改后的画面'
    await store.update(project.id, latest, latest.revision, session)
    const poll = await app.request(`http://localhost/projects/${project.id}/video/123`)
    assert.equal(poll.status, 200)
    const result = await store.get(project.id)
    assert.ok(result.episodes[0].cards[0].prompt.endsWith('用户修改后的画面'))
    assert.equal(result.episodes[0].cards[0].videoUrl, undefined)
    assert.equal(result.episodes[0].tasks[0].status, 'completed')
    const storyboardResponse = await post(`${root}/storyboard`, {})
    assert.equal(storyboardResponse.status, 201)
    const storyboardId = ((await storyboardResponse.json()) as any).data.id
    let storyboard = await store.getJob(project.id, storyboardId)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(storyboard.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); storyboard = await store.getJob(project.id, storyboardId) }
    assert.equal(storyboard.status, 'completed')
    let afterStoryboard = await store.get(project.id)
    assert.equal(afterStoryboard.episodes[0].tasks.length, 1)
    assert.equal(afterStoryboard.episodes[0].tasks[0].taskId, 123)
    assert.equal(afterStoryboard.episodes[0].generationsHistory.length, 1)
    assert.ok(afterStoryboard.episodes[0].generationsHistory[0].cards[0].prompt.endsWith('用户修改后的画面'))
    assert.equal(afterStoryboard.episodes[0].generationsHistory[0].sourceScript, '甲推开门。')
    assert.deepEqual(afterStoryboard.episodes[0].generationsHistory[0].production, oldProduction)
    assert.deepEqual(afterStoryboard.episodes[0].production, newProduction)
    assert.equal(afterStoryboard.episodes[0].cards[0].promptNeedsSync, false)
    assert.ok(afterStoryboard.episodes[0].cards[0].prompt.endsWith('AI更新后的提示词'))
    assert.equal(afterStoryboard.episodes[0].script, '用户已更新剧本')
    assert.equal(reviewCalls, 0)
    const manualReview = await post(`${root}/review`, {})
    assert.equal(manualReview.status, 201)
    const reviewId = ((await manualReview.json()) as any).data.id
    let reviewJob = await store.getJob(project.id, reviewId)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(reviewJob.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); reviewJob = await store.getJob(project.id, reviewId) }
    assert.equal(reviewCalls, 1)
    assert.equal(reviewJob.status, 'completed')
    assert.deepEqual((reviewJob.result as any).issues, [{ cardId: 'card-1', message: '请核对开门方向', segmentNumber: 1 }])
    assert.deepEqual(await store.get(project.id), afterStoryboard)
    // A stale-shaped client snapshot cannot clear server-owned history or tasks.
    const clientSnapshot = structuredClone(afterStoryboard)
    clientSnapshot.episodes[0].generationsHistory = []
    delete clientSnapshot.episodes[0].production
    clientSnapshot.episodes[0].tasks = []
    afterStoryboard = await store.update(project.id, clientSnapshot, clientSnapshot.revision, session)
    assert.equal(afterStoryboard.episodes[0].generationsHistory.length, 1)
    assert.equal(afterStoryboard.episodes[0].tasks.length, 1)
    assert.deepEqual(afterStoryboard.episodes[0].production, newProduction)

    const secondVideo = await post(`${root}/cards/card-1/video`, { ...videoBody, expectedCardVersion: afterStoryboard.episodes[0].cards[0].version })
    assert.equal(secondVideo.status, 201)
    const newOutline = await post(`${root}/outline`, {})
    assert.equal(newOutline.status, 201)
    const outlineId = ((await newOutline.json()) as any).data.id
    let outlineJob = await store.getJob(project.id, outlineId)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(outlineJob.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); outlineJob = await store.getJob(project.id, outlineId) }
    assert.equal(outlineJob.status, 'completed')
    const afterOutline = await store.get(project.id)
    assert.equal(afterOutline.episodes[0].tasks.length, 2)
    assert.equal(afterOutline.episodes[0].generationsHistory.length, 2)
    assert.ok(afterOutline.episodes[0].generationsHistory[1].cards[0].prompt.endsWith('AI更新后的提示词'))
    assert.deepEqual(afterOutline.episodes[0].generationsHistory[1].production, newProduction)
    assert.equal(afterOutline.episodes[0].production, undefined)
    assert.equal(afterOutline.episodes[0].cards[0].id, 'fake')
    assert.equal(afterOutline.episodes[0].outlineDurationPolicy, '30-except-tail-v1')
    assert.equal((await post(`${root}/review`, {})).status, 422)
    assert.equal(reviewCalls, 1)
    await store.mutate(project.id, record => {
      const ep = record.project.episodes[0]
      ep.outlineConfirmed = true
      ep.cards = [{id:'out-of-range',duration:31},{id:'tail',duration:5}]
      return { result:null, documentChanged:true }
    })
    const rejectedStoryboard = await post(`${root}/storyboard`, {})
    assert.equal(rejectedStoryboard.status, 422)
    assert.equal(((await rejectedStoryboard.json()) as any).errorCode, 'OUTLINE_DURATION')
    await store.mutate(project.id, record => {
      record.project.episodes[0].cards = structuredClone(afterOutline.episodes[0].cards)
      record.project.episodes[0].outlineConfirmed = false
      return { result:null, documentChanged:true }
    })
    const { assertScriptVideoFormal } = await import('../src/services/script-video-types')
    const strictApp = createScriptVideoRoutes(store, { ...dependencies, assertScriptVideoFormal })
    const incomplete = await strictApp.request(`http://localhost${root}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(incomplete.status, 422)
    assert.equal(((await incomplete.json()) as any).errorCode, 'FORMAL_INCOMPLETE')
    const lateVideo = await app.request(`http://localhost/projects/${project.id}/video/124`)
    assert.equal(lateVideo.status, 200)
    afterStoryboard = await store.get(project.id)
    assert.equal(afterStoryboard.episodes[0].tasks[1].status, 'completed')
    assert.equal(afterStoryboard.episodes[0].cards[0].videoUrl, undefined)
    const oldRevision = await post(`${root}/revisions`, { cardId: 'fake', instruction: '调整', sourcePrompt: '旧稿提示词' })
    assert.equal(oldRevision.status, 201)
    const oldRevisionId = ((await oldRevision.json()) as any).data.id
    let oldRevisionJob = await store.getJob(project.id, oldRevisionId)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(oldRevisionJob.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); oldRevisionJob = await store.getJob(project.id, oldRevisionId) }
    assert.equal(oldRevisionJob.status, 'completed')
    assert.equal(revisionStyle, undefined)
    let legacy = await store.create('无效大纲')
    legacy.episodes[0].script = legacy.episodes[0].confirmedScript = '原始剧本'
    legacy.episodes[0].confirmed = true
    legacy.episodes[0].cards = [{id:'old',duration:12,shots:[],assetIds:[],prompt:''}]
    legacy = await store.update(legacy.id, legacy, legacy.revision)
    const invalidApp = createScriptVideoRoutes(store, { ...dependencies,
      generateScriptVideoOutline: async () => ({cards:[{id:'one',duration:31},{id:'two',duration:8}],skillReads:[],attempts:1}),
    })
    assert.equal((await post(`/projects/${legacy.id}/episodes/${legacy.episodeId}/lock`, {})).status, 200)
    const invalidResponse = await invalidApp.request(`http://localhost/projects/${legacy.id}/episodes/${legacy.episodeId}/outline`, {method:'POST',headers,body:'{}'})
    assert.equal(invalidResponse.status, 201)
    const invalidId = ((await invalidResponse.json()) as any).data.id
    let invalidJob = await store.getJob(legacy.id, invalidId)
    for (let i = 0; i < 100 && !['completed','failed'].includes(invalidJob.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); invalidJob = await store.getJob(legacy.id, invalidId) }
    assert.equal(invalidJob.status, 'failed')
    assert.equal(invalidJob.code, 'OUTLINE_DURATION')
    const oldSaved = await store.get(legacy.id)
    assert.equal(oldSaved.episodes[0].cards[0].id, 'old')
    assert.equal(oldSaved.episodes[0].outlineDurationPolicy, undefined)
    let partial = await store.create('逐段断点')
    partial.settings.autoSelectCharacterBases = ['王禄']
    partial.episodes[0].script = partial.episodes[0].confirmedScript = '两段剧本'
    partial.episodes[0].confirmed = partial.episodes[0].outlineConfirmed = true
    partial.episodes[0].cards = [
      {id:'segment-a',duration:30,shots:[],assetIds:[],prompt:''},
      {id:'segment-b',duration:10,shots:[],assetIds:[],prompt:''},
    ]
    partial = await store.update(partial.id, partial, partial.revision)
    const attempts: Array<{model:string;resumed:number;autoSelectCharacterBases?:string[]}> = []
    const checkpointProduction = { coreRhythm:'连续', characters:[] }
    const partialApp = createScriptVideoRoutes(store, { ...dependencies,
      generateScriptVideoCards: async ({outline, model, autoSelectCharacterBases}:any, _runner:any, options:any) => {
        attempts.push({model,resumed:options.checkpoint?.cards.length || 0,autoSelectCharacterBases})
        const firstCard = {...outline[0],shots:[{duration:30}],prompt:'已验证第一段'}
        await options.onProgress({phase:'generating',completed:1,total:2,currentCardId:'segment-b'}, {production:checkpointProduction,cards:[firstCard]})
        if (attempts.length < 5) throw Object.assign(new Error('第 2 段超时'), {name:'ScriptVideoAIError',code:'MODEL_TIMEOUT',issues:[]})
        await options.onProgress({phase:'validating',completed:2,total:2}, {production:checkpointProduction,cards:[firstCard,{...outline[1],shots:[{duration:10}],prompt:'第二段'}]})
        return {cards:[firstCard,{...outline[1],shots:[{duration:10}],prompt:'第二段'}],production:checkpointProduction,skillReads:[],attempts:1}
      },
    })
    const partialRoot = `/projects/${partial.id}/episodes/${partial.episodeId}`
    assert.equal((await post(`${partialRoot}/lock`, {})).status, 200)
    const runPartial = async (model:string, autoSelectCharacterBases?:string[]) => {
      const response = await partialApp.request(`http://localhost${partialRoot}/storyboard`, {method:'POST',headers,body:JSON.stringify({configId:1,model,autoSelectCharacterBases})})
      assert.equal(response.status, 201)
      const createdJob = ((await response.json()) as any).data
      assert.equal(createdJob.checkpoint, undefined)
      assert.equal(createdJob.resumeKey, undefined)
      let state = await store.getJob(partial.id, createdJob.id)
      for (let i = 0; i < 100 && !['completed','failed'].includes(state.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); state = await store.getJob(partial.id, createdJob.id) }
      return state
    }
    const firstPartial = await runPartial('model-a')
    assert.equal(firstPartial.code, 'MODEL_TIMEOUT')
    assert.deepEqual(firstPartial.progress, {phase:'generating',completed:1,total:2,currentCardId:'segment-b'})
    assert.equal(firstPartial.checkpoint, undefined)
    const publicOne = ((await (await partialApp.request(`http://localhost/projects/${partial.id}/jobs/${firstPartial.id}`)).json()) as any).data
    const publicList = ((await (await partialApp.request(`http://localhost/projects/${partial.id}/jobs`)).json()) as any).data
    assert.equal(publicOne.checkpoint, undefined)
    assert.equal(publicOne.resumeKey, undefined)
    assert.equal(publicOne.progress.completed, 1)
    assert.ok(publicList.every((item:any) => item.checkpoint === undefined && item.resumeKey === undefined))
    assert.equal((await store.get(partial.id)).revision, partial.revision)
    assert.equal((await store.get(partial.id)).episodes[0].cards[0].prompt, '')
    const staleResume = await partialApp.request(`http://localhost${partialRoot}/storyboard`, {method:'POST',headers,body:JSON.stringify({model:'changed-model',resumeFromJobId:firstPartial.id})})
    assert.equal(staleResume.status, 409)
    assert.equal(((await staleResume.json()) as any).errorCode, 'RESUME_MISMATCH')
    assert.equal(attempts.length, 1)
    let appearanceChanged = await store.get(partial.id)
    appearanceChanged.episodes[0].characterAppearanceNotes = '甲改穿外套。'
    appearanceChanged = await store.update(partial.id, appearanceChanged, appearanceChanged.revision, session)
    const changedAppearanceResume = await partialApp.request(`http://localhost${partialRoot}/storyboard`, {method:'POST',headers,body:JSON.stringify({configId:1,model:'model-a',resumeFromJobId:firstPartial.id})})
    assert.equal(changedAppearanceResume.status, 409)
    assert.equal(((await changedAppearanceResume.json()) as any).errorCode, 'RESUME_MISMATCH')
    assert.equal(attempts.length, 1)
    appearanceChanged.episodes[0].characterAppearanceNotes = ''
    await store.update(partial.id, appearanceChanged, appearanceChanged.revision, session)
    const invalidList = await partialApp.request(`http://localhost${partialRoot}/storyboard`, {method:'POST',headers,body:JSON.stringify({autoSelectCharacterBases:['  ']})})
    assert.equal(invalidList.status, 400)
    const changedWhitelist = await runPartial('model-a', ['张三'])
    assert.equal(changedWhitelist.code, 'MODEL_TIMEOUT')
    const changedModel = await runPartial('model-b')
    assert.equal(changedModel.code, 'MODEL_TIMEOUT')
    const changedSource = await store.get(partial.id)
    changedSource.episodes[0].script = '用户修改了剧本'
    await store.update(partial.id, changedSource, changedSource.revision, session)
    const changedInput = await runPartial('model-a')
    assert.equal(changedInput.code, 'MODEL_TIMEOUT')
    const restored = await store.get(partial.id)
    restored.episodes[0].script = '两段剧本'
    await store.update(partial.id, restored, restored.revision, session)
    const resumed = await runPartial('model-a')
    assert.equal(resumed.status, 'completed')
    assert.deepEqual(attempts, [
      {model:'model-a',resumed:0,autoSelectCharacterBases:['王禄']},
      {model:'model-a',resumed:0,autoSelectCharacterBases:['张三']},
      {model:'model-b',resumed:0,autoSelectCharacterBases:['王禄']},
      {model:'model-a',resumed:0,autoSelectCharacterBases:['王禄']},
      {model:'model-a',resumed:1,autoSelectCharacterBases:['王禄']},
    ])
    assert.equal((await store.get(partial.id)).episodes[0].cards[0].prompt, '已验证第一段')
    const listedJobs = await store.listJobs(partial.id)
    assert.ok(listedJobs.every(item => item.checkpoint === undefined && item.resumeKey === undefined))

    // Simulate losing the process after reserving the second repair, before the first
    // valid card can be saved. Restart must never trigger a new model request itself.
    const persisted = Promise.withResolvers<void>()
    const interruptedApp = createScriptVideoRoutes(store, { ...dependencies,
      generateScriptVideoCards: async (_input, _runner, options) => {
        await options!.onProgress!({ phase: 'repairing', completed: 0, total: 2, repairAttempts: 2 }, {
          cards: [], repairAttempts: 2, candidate: { cards: [null, null], production: checkpointProduction },
        })
        persisted.resolve()
        return new Promise<never>(() => {})
      },
    })
    const endpoint = `http://localhost${partialRoot}/storyboard`
    const postOptions = (body: unknown) => ({method:'POST', headers, body:JSON.stringify(body)})
    const crash = await interruptedApp.request(endpoint, postOptions({model:'restart-test'}))
    const { data: crashed } = await crash.json() as any
    await persisted.promise
    const restarted = new ScriptVideoStore(store.directory)
    const stopped = await restarted.getJob(partial.id, crashed.id)
    assert.equal(stopped.code, 'INTERRUPTED')
    assert.equal(stopped.progress?.repairAttempts, 2)
    assert.equal(stopped.progress?.completed, 0)
    let manualCalls = 0
    const restartedApp = createScriptVideoRoutes(restarted, { ...dependencies,
      generateScriptVideoCards: async (input, _runner, options) => {
        manualCalls++
        assert.equal(options!.checkpoint?.repairAttempts, 2)
        assert.equal(options!.checkpoint?.cards.length, 0)
        assert.deepEqual(options!.checkpoint?.candidate?.cards, [null, null])
        const draft = await dependencies.generateScriptVideoCards(input)
        const [opening, ending] = draft.cards
        return { ...draft, cards: [
          opening, { ...ending, duration: 30, shots: [{ duration: 30 }] },
          { ...ending, id: 'extended-dialogue', duration: 5, shots: [{ duration: 5 }], prompt: '原台词自然收束' },
        ] }
      },
    })
    assert.equal(manualCalls, 0)
    assert.equal((await restartedApp.request(`http://localhost${partialRoot}/lock`, postOptions({}))).status, 200)
    const continued = await restartedApp.request(endpoint, postOptions({model:'restart-test', resumeFromJobId:crashed.id}))
    assert.equal(continued.status, 201)
    const { data: accepted } = await continued.json() as any
    let finished = await restarted.getJob(partial.id, accepted.id)
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(finished.status); i++) { await new Promise(resolve => setTimeout(resolve, 10)); finished = await restarted.getJob(partial.id, accepted.id) }
    assert.equal(finished.status, 'completed')
    assert.equal(manualCalls, 1)
    assert.equal(finished.progress?.total, 3)
    assert.equal(finished.progress?.completed, 3)
    assert.deepEqual((finished.result as any).timing, {segments:3, seconds:65})
    const retimedEpisode = (await restarted.get(partial.id)).episodes[0]
    assert.deepEqual(retimedEpisode.cards.map((card: any) => card.duration), [30, 30, 5])
    assert.equal(retimedEpisode.outlineDurationPolicy, OUTLINE_DURATION_POLICY)
    assert.equal(retimedEpisode.generationsHistory.at(-1).cards.length, 2)

    // A previous release asked for a timing decision before producing any card.
    // A normal retry from the confirmed outline may now send a different default prompt.
    const oldDefault = '保持原有分段边界，超时请求确认'
    const newDefault = '压缩次要动作，台词说不完时自动调整时长'
    const received: string[] = []
    const timingApp = createScriptVideoRoutes(restarted, { ...dependencies,
      generateScriptVideoCards: async (input, _runner, options) => {
        received.push(input.systemPrompt!)
        if (input.systemPrompt === oldDefault) {
          await options!.onProgress!({phase:'generating', completed:0, total:input.outline.length, repairAttempts:0}, {
            cards: [], attempts:1, repairAttempts:0, partialRaw:{cards:[]},
          })
          throw Object.assign(new Error('请确认时长处理方式'), {name:'ScriptVideoAIError', code:'USER_INPUT_REQUIRED'})
        }
        assert.equal(options!.checkpoint, undefined)
        return dependencies.generateScriptVideoCards(input)
      },
    })
    for (const systemPrompt of [oldDefault, newDefault]) {
      const response = await timingApp.request(endpoint, postOptions({systemPrompt}))
      assert.equal(response.status, 201)
      const {data} = await response.json() as any
      let job = await restarted.getJob(partial.id, data.id)
      for (let i = 0; i < 100 && !['completed', 'failed'].includes(job.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        job = await restarted.getJob(partial.id, data.id)
      }
      if (systemPrompt === oldDefault) assert.equal(job.code, 'USER_INPUT_REQUIRED')
      else assert.equal(job.status, 'completed')
    }
    assert.deepEqual(received, [oldDefault, newDefault])

    const { db, schema } = await import('../src/db/index')
    const now = new Date().toISOString()
    const [aicost, other] = db.insert(schema.aiServiceConfigs).values([
      { serviceType: 'text', provider: 'openai', name: 'AICost fixture', baseUrl: 'https://www.aicost.me/v1', apiKey: 'fixture', model: '["model-a"]', priority: 1000, createdAt: now, updatedAt: now },
      { serviceType: 'text', provider: 'openai', name: 'Other fixture', baseUrl: 'https://api.302.ai/v1', apiKey: 'fixture', model: '["model-a"]', createdAt: now, updatedAt: now },
    ]).returning({ id: schema.aiServiceConfigs.id }).all()
    const batchSizes: Array<number | undefined> = []
    const batchedApp = createScriptVideoRoutes(restarted, { ...dependencies,
      generateScriptVideoCards: async (input, _runner, options) => {
        batchSizes.push(options?.batchSize)
        return dependencies.generateScriptVideoCards(input)
      },
    })
    for (const configId of [aicost.id, other.id, undefined]) {
      const response = await batchedApp.request(endpoint, postOptions({ configId, model: 'model-a' }))
      assert.equal(response.status, 201)
      const { data } = await response.json() as any
      let job = await restarted.getJob(partial.id, data.id)
      for (let i = 0; i < 100 && !['completed', 'failed'].includes(job.status); i++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        job = await restarted.getJob(partial.id, data.id)
      }
      assert.equal(job.status, 'completed')
    }
    assert.deepEqual(batchSizes, [1, undefined, 1])
  } finally {
    if (previousDb === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = previousDb
    if (previousData === undefined) delete process.env.HUOBAO_DATA_DIR; else process.env.HUOBAO_DATA_DIR = previousData
    rmSync(dir, { recursive: true, force: true })
  }
})


test('changing only shot reference bindings or JSON key order does not require rewriting the prompt', async () => fixture(async store => {
  const project = await store.create('更新镜头素材引用')
  const lead = voiceAsset('lead', '阿宁')
  project.assets = [lead]
  const card = voiceCard('card-1', lead, '@阿宁：“我回来了。”')
  const { id, duration, camera, action, dialogue } = card.shots[0]
  project.episodes[0].cards = [{
    ...card,
    openingAssetIds: [lead.id],
    shots: [{ id, duration, camera, action, dialogue, visualAssetIds: [lead.id], speakerAssetIds: [lead.id] }],
  }]
  const before = await store.update(project.id, project, project.revision)
  const incoming = structuredClone(before)
  const changed = incoming.episodes[0].cards[0]
  delete changed.openingAssetIds
  changed.shots = [{ dialogue, action, camera, duration, id }]
  const after = await store.update(project.id, incoming, incoming.revision)
  const saved = after.episodes[0].cards[0]
  assert.equal(saved.prompt, before.episodes[0].cards[0].prompt)
  assert.equal(saved.promptNeedsSync, false)
  assert.equal(saved.version, before.episodes[0].cards[0].version + 1)

  const withAudio = await store.get(project.id)
  const owner = randomUUID()
  await store.acquireEpisodeLease(project.id, project.episodeId, owner, false)
  const savedAudio = await store.updateCharacterVoice(project.id, project.episodeId, lead.id, owner,
    'voiceAudio', withAudio.assets[0].voiceAudio, { url: '/static/uploads/new-voice.wav', name: '新音频.wav' })
  assert.equal(savedAudio.episodes[0].cards[0].prompt, saved.prompt)
  assert.equal(savedAudio.episodes[0].cards[0].promptNeedsSync, false)
}))

test('changed shots require prompt resynchronization even if a client forges the flag', async () => fixture(async store => {
  const project = await store.create('修改镜头')
  project.episodes[0].cards = [{ id: 'card-1', prompt: '旧提示词', shots: [{ id: 's1', action: '开门' }], assetIds: [] }]
  let saved = await store.update(project.id, project, project.revision)
  saved.episodes[0].cards[0].shots[0].action = '关门'
  saved.episodes[0].cards[0].promptNeedsSync = false
  saved = await store.update(project.id, saved, saved.revision)
  assert.equal(saved.episodes[0].cards[0].promptNeedsSync, true)
  saved.episodes[0].cards[0].promptNeedsSync = false
  saved = await store.update(project.id, saved, saved.revision)
  assert.equal(saved.episodes[0].cards[0].promptNeedsSync, true)
  saved.episodes[0].cards[0].prompt = '不完整的修改'
  saved.episodes[0].cards[0].promptNeedsSync = true
  saved = await store.update(project.id, saved, saved.revision)
  assert.equal(saved.episodes[0].cards[0].promptNeedsSync, true)
  saved.episodes[0].cards[0].promptNeedsSync = false
  saved = await store.update(project.id, saved, saved.revision)
  assert.equal(saved.episodes[0].cards[0].promptNeedsSync, true)
  saved.episodes[0].cards[0].prompt = '关门的新提示词'
  saved.episodes[0].cards[0].promptNeedsSync = false
  saved = await store.update(project.id, saved, saved.revision)
  assert.equal(saved.episodes[0].cards[0].promptNeedsSync, false)
}))


test('style snapshots persist, validate strictly and preserve existing settings and formal content', async () => fixture(async (store, dir) => {
  let project = await store.create('风格项目', STYLE)
  assert.deepEqual(project.settings.stylePreset, STYLE)
  project.settings.extra = '继续保留'
  project.episodes[0].cards = [{ id: 'card-1', prompt: '既有提示词', shots: [{id: 's1', action: '开门'}], assetIds: [], status: 'draft', version: 1 }]
  project.episodes[0].production = { stylePreset: STYLE, visualSpecs: '原风格' }
  project = await store.update(project.id, project, project.revision)
  const oldCard = structuredClone(project.episodes[0].cards[0])
  const newVersion = structuredClone(project)
  newVersion.settings = { stylePreset: STYLE_TWO }
  project = await store.update(project.id, newVersion, newVersion.revision)
  assert.equal(project.settings.extra, '继续保留')
  assert.deepEqual(project.settings.stylePreset, STYLE_TWO)
  assert.equal((await new ScriptVideoStore(dir).get(project.id)).episodes[0].production.stylePreset.prefix, STYLE.prefix)
  assert.deepEqual(project.episodes[0].production.stylePreset, STYLE)
  assert.deepEqual(project.episodes[0].cards[0], oldCard)
  for (const invalid of [null, { ...STYLE, id: 'unknown' }, { ...STYLE, name: '' }, { ...STYLE, prefix: '' }, { ...STYLE, prefix: 'x'.repeat(20001) }, { ...STYLE, extra: 'unexpected' }]) {
    const attempt = structuredClone(project)
    attempt.settings.stylePreset = invalid
    await assert.rejects(store.update(project.id, attempt, attempt.revision), ScriptVideoStoreError)
    assert.deepEqual((await store.get(project.id)).settings.stylePreset, STYLE_TWO)
  }
  await assert.rejects(store.create('坏风格', null as any), ScriptVideoStoreError)
}))

test('legacy prompts get asset markers and closed-mouth OS cues without rewriting the speech or history', async () => fixture(async (store, directory) => {
  const project = await store.create('引用旧稿')
  const legacy = join(directory, 'legacy')
  mkdirSync(legacy)
  const recordFile = join(legacy, project.id + '.json')
  const record = { project, jobs: [] }
  record.project.assets = [
    {id:'base',name:'顾凌天',kind:'character',image:'/static/base.png'},
    {id:'robe',name:'顾凌天_龙袍',kind:'character',image:'/static/robe.png'},
    {id:'bowl',name:'毒酒碗',kind:'prop',image:'/static/bowl.png'},
  ]
  const raw = '镜头侧拍顾凌天。毒酒碗落地。\n对白／音效：顾凌天_龙袍(OS)：“顾凌天。”'
  record.project.episodes[0].cards = [{id:'c', prompt:raw, assetIds:['robe'], shots:[], status:'ready', version:7,
    promptVersions:[{prompt:raw, assetIds:['robe']}] }]
  writeFileSync(recordFile, JSON.stringify(record))
  const disk = readFileSync(recordFile,'utf8')
  const card = (await new ScriptVideoStore(legacy).get(project.id)).episodes[0].cards[0]
  assert.equal(card.prompt,'镜头侧拍@顾凌天_龙袍。@毒酒碗落地。\n对白／音效：@顾凌天_龙袍（内心 OS，角色闭口，嘴唇不动，不对口型）：“顾凌天。”')
  assert.deepEqual(card.assetIds,['robe','bowl'])
  assert.equal(card.status,'ready')
  assert.equal(card.version,7)
  assert.equal(card.promptVersions[0].prompt,raw)
  assert.equal(readFileSync(recordFile,'utf8'),disk)
}))

test('confirmed video rejections repair stale unknown failures on status and retry, while genuine unknowns require acknowledgement', async () => fixture(async (store, directory) => {
  const previousDb = process.env.SQLITE_PATH, previousData = process.env.HUOBAO_DATA_DIR
  process.env.SQLITE_PATH = join(directory, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = directory
  try {
    const { createScriptVideoRoutes } = await import('../src/routes/script-video')
    const project = await store.create('视频重试')
    const priorTasks = [
      { taskId: 11, id: 'prior-status', cardId: 'status-card' },
      { taskId: 12, id: 'prior-retry', cardId: 'retry-card' },
      { taskId: 13, id: 'prior-unknown', cardId: 'unknown-card' },
    ]
    await store.mutate(project.id, record => {
      const episode = record.project.episodes[0]
      episode.script = episode.confirmedScript = '甲推开门。'
      episode.confirmed = true
      const now = new Date().toISOString()
      for (const prior of priorTasks) {
        episode.cards.push({ id: prior.cardId, version: 1, prompt: '甲推开门。', shots: [], assetIds: [] })
        episode.tasks.push({ ...prior, status: 'failed', code: 'SUBMISSION_UNKNOWN', error: '旧错误' })
        record.jobs.push({
          ...prior, projectId: project.id, episodeId: episode.id, action: 'video', status: 'failed',
          code: 'SUBMISSION_UNKNOWN', error: '旧错误', createdAt: now, updatedAt: now,
        })
      }
      return { result: null, documentChanged: true }
    })

    let submitted = 0
    const message = '当前模型在 AICost 没有可用渠道，可更换视频模型后重试。'
    const app = createScriptVideoRoutes(store, {
      assertScriptVideoFormal: () => {},
      getScriptVideoGeneration: async (taskId: number) => {
        if (taskId === 13) throw new Error('本地状态暂不可用')
        return { taskId, status: 'failed', stage: 'submitting', code: 'VIDEO_FAILED', error: message }
      },
      startScriptVideoGeneration: async () => ({ taskId: 20 + ++submitted, status: 'processing' }),
    } as any)
    const base = `http://localhost/projects/${project.id}`
    const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': randomUUID() }
    assert.equal((await app.request(`${base}/episodes/${project.episodeId}/lock`, { method: 'POST', headers })).status, 200)
    const submit = (cardId: string, confirmRetryAfterUnknown?: boolean) =>
      app.request(`${base}/episodes/${project.episodeId}/cards/${cardId}/video`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedCardVersion: 1, configId: 1, model: 'aicost-model', aspectRatio: '16:9', resolution: '720P', confirmRetryAfterUnknown }),
      })
    const poll = await app.request(`${base}/video/11`)
    assert.equal(poll.status, 200)
    assert.deepEqual([(await store.getJob(project.id, 'prior-status')).code, submitted], ['VIDEO_FAILED', 0])
    assert.equal((await store.get(project.id)).episodes[0].tasks[0].error, message)

    assert.equal((await submit('retry-card')).status, 201)
    assert.equal((await store.getJob(project.id, 'prior-retry')).code, 'VIDEO_FAILED')
    assert.deepEqual([(await store.get(project.id)).episodes[0].tasks[1].error, submitted], [message, 1])

    const blocked = await submit('unknown-card')
    assert.equal(blocked.status, 409)
    const error = await blocked.json() as any
    assert.equal(error.errorCode, 'SUBMISSION_UNKNOWN')
    assert.match(error.message, /重复计费/)
    assert.doesNotMatch(error.message, /核对服务商/)
    assert.equal(submitted, 1)
    assert.equal((await submit('unknown-card', true)).status, 201)
    assert.equal((await store.getJob(project.id, 'prior-unknown')).code, 'SUBMISSION_UNKNOWN_ACKNOWLEDGED')
    assert.equal((await store.get(project.id)).episodes[0].tasks[2].code, 'SUBMISSION_UNKNOWN_ACKNOWLEDGED')
  } finally {
    if (previousDb === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousDb
    if (previousData === undefined) delete process.env.HUOBAO_DATA_DIR
    else process.env.HUOBAO_DATA_DIR = previousData
  }
}))

test('only a new manual production card can submit a free-form prompt without formal validation', async () => fixture(async (store, directory) => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  const { ScriptVideoAIError } = await import('../src/services/script-video-types')
  const { getScriptVideoStylePreset, scriptVideoPromptStylePrefix } = await import('../src/services/script-video-style')
  const project = await store.create('手动片段')
  const episode = project.episodes[0]
  const card = { id: 'formal', duration: 5, shots: [], assetIds: [], prompt: '薄雾掠过城门。' }
  episode.script = episode.confirmedScript = '远处有一座城门。'
  episode.confirmed = episode.outlineConfirmed = true
  episode.stage = 'production'
  episode.cards = [{ ...card, manuallyAdded: true }]
  const baseline = await store.update(project.id, project, project.revision)
  assert.equal(baseline.episodes[0].cards[0].manuallyAdded, undefined)

  baseline.episodes[0].cards = [
    { ...baseline.episodes[0].cards[0], manuallyAdded: true },
    { ...card, id: 'manual', manuallyAdded: true, promptNeedsSync: true },
    { ...card, id: 'empty', manuallyAdded: true, prompt: ' ' },
    { ...card, id: 'style-only', manuallyAdded: true, prompt: scriptVideoPromptStylePrefix(getScriptVideoStylePreset('cool')!) },
  ]
  const saved = await store.update(project.id, baseline, baseline.revision)
  assert.equal(saved.episodes[0].cards[0].manuallyAdded, undefined)
  const manual = saved.episodes[0].cards[1]
  assert.equal(manual.manuallyAdded, true)
  assert.equal(manual.promptNeedsSync, false)
  delete manual.manuallyAdded
  await store.update(project.id, saved, saved.revision)

  const restarted = new ScriptVideoStore(directory)
  const current = await restarted.get(project.id)
  assert.equal(current.episodes[0].cards[1].manuallyAdded, true)
  let formalChecks = 0
  const submitted: string[] = []
  const app = createScriptVideoRoutes(restarted, {
    assertScriptVideoFormal() { formalChecks++; throw new ScriptVideoAIError('FORMAL_REQUIRED', '正式分镜必须通过校验') },
    async startScriptVideoGeneration({ card: submittedCard }: { card: { id: string } }) {
      submitted.push(submittedCard.id)
      return { taskId: 501, status: 'processing' }
    },
  } as any)
  const base = `http://localhost/projects/${project.id}/episodes/${episode.id}`
  const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': randomUUID() }
  assert.equal((await app.request(`${base}/lock`, { method: 'POST', headers })).status, 200)
  const submit = (id: string) => app.request(`${base}/cards/${id}/video`, { method: 'POST', headers,
    body: JSON.stringify({ expectedCardVersion: current.episodes[0].cards.find((item: { id: string }) => item.id === id).version,
      configId: 1, model: 'test-video', aspectRatio: '16:9', resolution: '720p', manuallyAdded: true }),
  })
  assert.equal((await (await submit('formal')).json() as any).errorCode, 'FORMAL_REQUIRED')
  assert.equal((await (await submit('empty')).json() as any).errorCode, 'PROMPT_REQUIRED')
  assert.equal((await (await submit('style-only')).json() as any).errorCode, 'PROMPT_REQUIRED')
  assert.equal((await submit('manual')).status, 201)
  assert.equal(formalChecks, 1)
  assert.deepEqual(submitted, ['manual'])
}))

test('video submission defaults to model voices and requires audio for opted-out roles', async () => fixture(async store => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  let project = await store.create('对白与心声音频')
  const episodeId = project.episodeId
  const dialogue = '@阿宁：“我来了。”；@小禾（OS）：“她总算来了。”；音效：风吹树叶。'
  project.assets = [
    { id: 'a', name: '阿宁', kind: 'character', image: '/static/uploads/a.png', voiceMode: 'reference' },
    { id: 'b', name: '小禾', kind: 'character', image: '/static/uploads/b.png' },
    { id: 'c', name: '阿川', kind: 'character', image: '/static/uploads/c.png' },
  ]
  const episode = project.episodes[0]
  episode.script = episode.confirmedScript = '阿宁说话，小禾心想，阿川没有出声。'
  episode.confirmed = episode.outlineConfirmed = true
  episode.cards = [{
    id: 'c1', title: '碰面', duration: 5, assetIds: ['a', 'b', 'c'], status: 'draft', version: 1,
    prompt: `镜头 01（0–5秒）\n画面与动作：@阿宁问候，@小禾和@阿川静立。\n对白／音效：${dialogue}`,
    shots: [{ duration: 5, dialogue }],
  }, voiceCard('unbound', project.assets[2], '巡夜人（OS）：“有人来过。”')]
  project = await store.update(project.id, project, project.revision)
  let submitted = 0
  const app = createScriptVideoRoutes(store, {
    assertScriptVideoFormal: () => {},
    startScriptVideoGeneration: async () => { submitted++; return { taskId: 501, status: 'processing' } },
  } as any)
  const root = `http://localhost/projects/${project.id}/episodes/${episodeId}`
  const session = randomUUID()
  const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': session }
  assert.equal((await app.request(`${root}/lock`, { method: 'POST', headers })).status, 200)
  const submit = (cardId = 'c1') => app.request(`${root}/cards/${cardId}/video`, { method: 'POST', headers, body: JSON.stringify({
    expectedCardVersion: project.episodes[0].cards.find((card: { id: string }) => card.id === cardId)!.version,
    configId: 1, model: 'test-video', aspectRatio: '16:9', resolution: '720p',
  }) })

  const rejected = await submit()
  assert.equal(rejected.status, 422)
  const { errorCode, message } = await rejected.json() as { errorCode: string; message: string }
  assert.equal(errorCode, 'VOICE_REFERENCE_REQUIRED')
  assert.match(message, /阿宁.*上传角色参考音频/u)
  assert.doesNotMatch(message, /小禾|阿川|音效/u)
  const unbound = await submit('unbound')
  assert.equal(unbound.status, 422)
  assert.match((await unbound.json() as { message: string }).message, /巡夜人/u)
  assert.equal(submitted, 0)
  assert.deepEqual(await store.listJobs(project.id), [])
  assert.deepEqual((await store.get(project.id)).episodes[0].tasks, [])

  project.assets[0].voiceAudio = { url: '/static/uploads/a.wav', name: '阿宁.wav' }
  project = await store.update(project.id, project, project.revision, session)
  assert.equal((await submit()).status, 201)
  assert.equal(submitted, 1)
}))

test('in-flight renders ignore other model selections and only their own audio change makes them historic', async () => fixture(async store => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  const project = await store.create('出片时核对各自音频')
  const lead = voiceAsset('lead', '阿宁')
  const other = { id: 'other', name: '小禾', kind: 'character', image: '/static/uploads/other.png', voiceMode: 'model' as const }
  project.assets = [lead, other]
  const episode = project.episodes[0]
  episode.script = episode.confirmedScript = '阿宁说：“我回来了。”小禾想：“轮到我了。”'
  episode.confirmed = episode.outlineConfirmed = true
  episode.modelName = 'seedance2.5-ae-480p'
  episode.modelProvider = 'aicost'
  const scene = '院落（唯一空间）'
  episode.cards = [
    { ...voiceCard('changed', lead, '@阿宁：“我回来了。”'), scene, ending: '阿宁站在门边。下一段从本段尾帧继续。' },
    { ...voiceCard('continued', lead, '无对白。'), scene, opening: '同一镜头续接上一段尾帧，阿宁站在门边。' },
    voiceCard('independent', other, '@小禾（OS）：“轮到我了。”'),
  ]
  await store.update(project.id, project, project.revision)

  let nextTaskId = 530
  const complete = new Set<number>()
  let continuedFrom: number | undefined
  const app = createScriptVideoRoutes(store, {
    assertScriptVideoFormal: () => {},
    startScriptVideoGeneration: async ({ continuationSource }: { continuationSource?: { previousTaskId: number } }) => {
      continuedFrom = continuationSource?.previousTaskId
      return { taskId: ++nextTaskId, status: 'processing' }
    },
    getScriptVideoGeneration: async (taskId: number) => complete.has(taskId)
      ? { taskId, status: 'completed', stage: 'complete', videoUrl: `/static/videos/task-${taskId}.mp4` }
      : { taskId, status: 'processing', stage: 'polling' },
  } as any)
  const base = `http://localhost/projects/${project.id}`
  const root = `${base}/episodes/${episode.id}`
  const session = randomUUID()
  const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': session }
  assert.equal((await app.request(`${root}/lock`, { method: 'POST', headers })).status, 200)
  const submit = async (id: string) => {
    const current = await store.get(project.id)
    const card = current.episodes[0].cards.find((item: { id: string }) => item.id === id)!
    const response = await app.request(`${root}/cards/${id}/video`, { method: 'POST', headers, body: JSON.stringify({
      expectedCardVersion: card.version, configId: 1, model: episode.modelName, aspectRatio: '16:9', resolution: '480P',
    }) })
    const payload = await response.json() as { data: { taskId: number } }
    assert.equal(response.status, 201, JSON.stringify(payload))
    return payload.data.taskId
  }
  const finish = async (taskId: number) => {
    complete.add(taskId)
    assert.equal((await app.request(`${base}/video/${taskId}`)).status, 200)
  }

  const originalTask = await submit('changed')
  await finish(originalTask)
  const changedTask = await submit('changed')
  const independentTask = await submit('independent')
  const before = await store.get(project.id)
  const changed = structuredClone(before)
  changed.assets[0].voiceAudio.url = '/static/uploads/lead-new.wav'
  changed.assets.push({ id: 'unreferenced', name: '石碑', kind: 'prop', image: '/static/uploads/unreferenced.png' })
  // The user can switch models while earlier paid tasks are still processing.
  changed.episodes[0].modelName = 'jimeng-seedance-2.5'
  changed.episodes[0].modelProvider = 'jimeng'
  changed.episodes[0].resolution = '720P'
  const saved = await store.update(project.id, changed, before.revision, session)
  assert.deepEqual(saved.episodes[0].cards.map((card: { version: number }) => card.version),
    before.episodes[0].cards.map((card: { version: number }) => card.version))

  await finish(changedTask)
  await finish(independentTask)
  const result = (await store.get(project.id)).episodes[0]
  assert.equal(result.cards[0].status, 'ready')
  assert.equal(result.cards[0].videoUrl, `/static/videos/task-${originalTask}.mp4`)
  const historical = result.tasks.find((task: { taskId: number }) => task.taskId === changedTask)
  assert.equal(historical.status, 'completed')
  assert.equal(historical.videoUrl, `/static/videos/task-${changedTask}.mp4`)
  assert.equal(historical.staleResult, true)
  assert.equal(result.cards[2].status, 'ready')
  assert.equal(result.cards[2].videoUrl, `/static/videos/task-${independentTask}.mp4`)
  await submit('continued')
  assert.equal(continuedFrom, originalTask)

  const beforeLegacy = await store.get(project.id)
  beforeLegacy.assets = beforeLegacy.assets.filter(asset => asset.id !== 'unreferenced')
  beforeLegacy.episodes[0].modelName = episode.modelName
  beforeLegacy.episodes[0].modelProvider = episode.modelProvider
  beforeLegacy.episodes[0].resolution = '480P'
  await store.update(project.id, beforeLegacy, beforeLegacy.revision, session)
  const legacyTask = await submit('independent')
  await store.mutate(project.id, ({ project, jobs }) => {
    const job = jobs.find(item => item.taskId === legacyTask)!
    assert.equal(job.videoDigestVersion, 7)
    // Captured from the previous release for this exact legacy fixture.
    job.baseDigest = '6f050eae23c54670cc11d634a05d6095509d45a8ca0913f4a359b7732ab55ab8'
    job.videoDigestVersion = 4
    // An unset mode used the same model voice source under version 4.
    delete project.assets[1].voiceMode
    return { result: null, documentChanged: true }
  })
  await finish(legacyTask)
  const legacy = (await store.get(project.id)).episodes[0]
  assert.equal(legacy.cards[2].status, 'ready')
  assert.equal(legacy.cards[2].videoUrl, `/static/videos/task-${legacyTask}.mp4`)
}))

test('video submission uses only the saved current predecessor for a matching handoff', async () => fixture(async (store) => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  const project = await store.create('跨段尾帧')
  const scene = '院落（唯一空间）'
  const shot = { duration: 5, camera: '近景，平视，固定', action: '小旗半抬右手扶住门闩。', dialogue: '' }
  const card = { version: 1, duration: 5, scene, assetIds: [], shots: [shot], prompt: '全段 5 秒。' }
  await store.mutate(project.id, ({ project }) => {
    const episode = project.episodes[0]
    episode.script = episode.confirmedScript = '小旗抬手扶住门闩。'
    episode.confirmed = true
    episode.cards = [
      { ...card, id: 'prior', shots: [{ ...shot, duration: 2.5 }, { ...shot, duration: 2.5 }],
        ending: '小旗半抬右手扶住门闩。下一段从本段尾帧继续。' },
      { ...card, id: 'next', opening: '同一镜头续接上一段尾帧，小旗半抬右手扶住门闩。' },
      { ...card, id: 'cut', scene: '书房（唯一空间）', opening: '切场，书房里旁人正在等待。' },
    ]
    return { result: null, documentChanged: true }
  })
  const complete = new Set<number>()
  const submitted: Array<{ cardId: string; duration?: number; source?: unknown }> = []
  const continuation = { previousCardId: 'prior', previousTaskId: 31, imageUrl: '/static/videos/prior_tail.jpg', mode: 'first-frame' }
  const app = createScriptVideoRoutes(store, {
    assertScriptVideoFormal: () => {},
    getScriptVideoGeneration: async (taskId: number, options?: { finalShotNumber?: number }) => complete.has(taskId)
      ? { taskId, status: 'completed', stage: 'completed', videoUrl: `/static/videos/task-${taskId}.mp4`,
        ...(taskId === 31 && options?.finalShotNumber === 2 && { finalShotRange: { shotStartSeconds: 5, shotEndSeconds: 9 } }) }
      : { taskId, status: 'processing', stage: 'polling' },
    startScriptVideoGeneration: async ({ card, duration, continuationSource }: any) => {
      submitted.push({ cardId: card.id, source: continuationSource, ...(duration === undefined ? {} : { duration }) })
      return { taskId: 30 + submitted.length, status: 'processing', ...(continuationSource && {
        continuation: { ...continuation, previousTaskId: continuationSource.previousTaskId },
      }) }
    },
  } as any)
  const base = `http://localhost/projects/${project.id}`
  const episode = `${base}/episodes/${project.episodeId}`
  const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': randomUUID() }
  assert.equal((await app.request(`${episode}/lock`, { method: 'POST', headers })).status, 200)
  const submit = (id: string, duration?: number) => app.request(`${episode}/cards/${id}/video`, { method: 'POST', headers,
    body: JSON.stringify({ expectedCardVersion: 1, configId: 1, model: 'test-video', aspectRatio: '16:9', resolution: '720p', duration }) })

  assert.equal((await (await submit('next')).json() as any).errorCode, 'CONTINUATION_REQUIRED')
  assert.equal((await submit('prior', 9)).status, 201)
  assert.equal((await (await submit('next')).json() as any).errorCode, 'CONTINUATION_PENDING')
  assert.equal((await submit('cut')).status, 201)
  assert.deepEqual(submitted, [{ cardId: 'prior', duration: 9, source: undefined }, { cardId: 'cut', source: undefined }])

  complete.add(31)
  const accepted = await submit('next')
  assert.equal(accepted.status, 201, await accepted.clone().text())
  assert.deepEqual((await accepted.json() as any).data.continuation, continuation)
  assert.deepEqual(submitted.at(-1)?.source, { previousCardId: 'prior', previousTaskId: 31, videoUrl: '/static/videos/task-31.mp4',
    shotStartSeconds: 5, shotEndSeconds: 9 })
  await app.request(`${base}/video/31`)
  complete.add(33)
  await app.request(`${base}/video/33`)
  const saved = (await store.get(project.id)).episodes[0]
  assert.equal(saved.cards[0].duration, 5)
  assert.equal(saved.tasks.find((task: any) => task.cardId === 'prior').duration, 9)
  assert.equal(saved.tasks.find((task: any) => task.cardId === 'cut').duration, 5)
  assert.equal(saved.cards[1].videoUrl, '/static/videos/task-33.mp4')
  assert.deepEqual(saved.tasks.find((task: any) => task.cardId === 'next').continuation, continuation)

  const otherTab = randomUUID()
  store.queue.reserve(project.id, project.episodeId, otherTab, 'quote-predecessor', ['prior'])
  assert.equal((await (await submit('next')).json() as any).errorCode, 'CONTINUATION_PENDING')
  store.queue.release(project.id, project.episodeId, otherTab, 'quote-predecessor')

  assert.equal((await submit('prior', 8)).status, 201)
  assert.equal((await (await submit('next')).json() as any).errorCode, 'CONTINUATION_PENDING')
  complete.add(34)
  assert.equal((await submit('next')).status, 201)
  assert.deepEqual(submitted.at(-1)?.source, { previousCardId: 'prior', previousTaskId: 34, videoUrl: '/static/videos/task-34.mp4',
    shotStartSeconds: 4, shotEndSeconds: 8 })

  // The official choice can return to an older render while a dependent job runs.
  await store.mutate(project.id, ({ project }) => {
    project.episodes[0].cards[0].videoUrl = '/static/videos/task-31.mp4'
    return { result: null, documentChanged: true }
  })
  complete.add(35)
  await app.request(`${base}/video/35`)
  const restored = (await store.get(project.id)).episodes[0]
  assert.equal(restored.cards[1].videoUrl, '/static/videos/task-33.mp4')
  assert.equal(restored.tasks.find((task: any) => task.taskId === 35).staleResult, true)
  assert.equal((await submit('next')).status, 201)
  assert.deepEqual(submitted.at(-1)?.source, { previousCardId: 'prior', previousTaskId: 31, videoUrl: '/static/videos/task-31.mp4',
    shotStartSeconds: 5, shotEndSeconds: 9 })
  complete.add(36)
  await app.request(`${base}/video/36`)

  await store.mutate(project.id, ({ project }) => {
    Object.assign(project.episodes[0].cards[0], { version: 2, status: 'draft', videoUrl: undefined })
    return { result: null, documentChanged: true }
  })
  assert.equal((await (await submit('next')).json() as any).errorCode, 'CONTINUATION_REQUIRED')
  assert.equal(submitted.length, 6)
}))

test('presence allows concurrent editors and expiration never blocks field saves; legacy whole PUT still needs its revision', async t => fixture(async store => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  let project = await store.create('协作项目', STYLE)
  const first = project.episodeId, second = 'episode-2'
  project.episodes.push({ ...project.episodes[0], id: second, number: 2, cards: [], script: 'other episode' })
  project.episodes[0].cards.push({ id: 'c', prompt: '镜头', assetIds: [], shots: [{ id: 's', camera: '固定', duration: 2 }] })
  project = await store.update(project.id, project, project.revision)
  const app = createScriptVideoRoutes(store)
  const request = (url: string, method = 'GET', session?: string, body?: unknown) => app.request(url, {
    method, headers: { 'Content-Type': 'application/json', ...(session && { 'X-Script-Video-Session': session }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const base = '/projects/' + project.id
  const a = randomUUID(), b = randomUUID()
  const lock = (session: string) => request(base + '/episodes/' + first + '/lock', 'POST', session)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  assert.deepEqual((await Promise.all([lock(a), lock(b)])).map(r => r.status), [200, 200])
  assert.deepEqual((await (await request(base + '/episode-locks', 'GET', a)).json() as any).data, { [first]: { expiresAt: now + 30_000 } })
  now += 31_000
  assert.deepEqual((await (await request(base + '/episode-locks', 'GET', b)).json() as any).data, {})
  const directory = (await (await request('/projects?view=summary')).json() as any).data
  assert.deepEqual(Object.keys(directory[0]).sort(), ['id', 'revision', 'title'])
  const summary = (await (await request(base + '?view=summary')).json() as any).data
  assert.deepEqual(summary.episodes.map((ep: any) => ep.cardCount), [1, 0])
  for (const ep of summary.episodes) assert.ok(!('script' in ep) && !('cards' in ep))
  const patch = (clientId: string, sequence: number, changes: any[], loadedEpisodeIds?: string[]) =>
    request(base + '/changes', 'PATCH', clientId, { clientId, sequence, changes, loadedEpisodeIds })
  const set = (id: string, fields: Record<string, unknown>) => ({ target: 'episode', id, fields })
  const [one, two] = await Promise.all([patch(a, 1, [set(first, { script: '甲脚本' })]), patch(b, 1, [set(first, { title: '乙标题' })])])
  assert.equal(one.status, 200)
  assert.equal(two.status, 200)
  const changed = await patch(a, 2, [set(first, { script: '新脚本' }), { target: 'card', episodeId: first, id: 'c', fields: { prompt: '新分镜' } }], [first, second])
  const ack = (await changed.json() as any).data
  assert.equal(ack.sequence, 2)
  assert.deepEqual(ack.episodes.map((ep: any) => ep.id), [first, second])
  assert.equal(ack.episodes[0].title, '乙标题')
  assert.ok(ack.episodes[0].cards[0].prompt.endsWith('新分镜'))
  const duplicate = await patch(a, 1, [set(first, { script: '过时重放' })])
  assert.equal((await duplicate.json() as any).data.revision, ack.revision)
  const get = async (id: string) => (await (await request(base + '/episodes/' + id)).json() as any).data
  assert.equal((await get(first)).episode.script, '新脚本')
  assert.equal((await get(second)).episode.script, 'other episode')
  assert.equal((await get(second)).episodeRevision, 1)
  const shotEdit = await patch(b, 2, [{ target: 'shot', episodeId: first, cardId: 'c', id: 's', fields: { camera: '缓慢跟拍', duration: 4 } }])
  const changedCard = (await shotEdit.json() as any).data.episodes[0].cards[0]
  assert.equal(changedCard.shots[0].camera, '缓慢跟拍')
  assert.equal(changedCard.duration, 4)
  assert.equal((await request(base, 'PUT', a, { project, expectedRevision: project.revision })).status, 409)
  assert.equal((await request(base + '/changes', 'PATCH', a, { expectedUser: 'another-user', clientId: a, sequence: 3, changes: [] })).status, 403)
  assert.equal((await patch(a, 3, [{ target: 'card', episodeId: first, id: 'c', fields: { videoUrl: 'forged' } }])).status, 400)
}))

test('episode restore returns only the latest review, latest text run and live text job', async () => fixture(async store => {
  const project = await store.create('任务恢复')
  await store.mutateEpisode(project.id, project.episodeId, ({ jobs }) => {
    const time = new Date().toISOString()
    for (const [id, action, status] of [
      ['old', 'storyboard', 'failed'], ['review', 'review', 'completed'], ['active', 'outline', 'running'],
      ['new', 'revisions', 'failed'], ['video', 'video', 'running'],
    ] as const) jobs.push({      id, action, status, projectId: project.id, episodeId: project.episodeId,
      createdAt: time, updatedAt: time, result: { id }, resumeKey: 'private'    })
    return { result: null }
  })
  const jobs = await store.listJobs(project.id, project.episodeId, true)
  assert.deepEqual(jobs.map(job => [job.id, job.result]), [['review', { id: 'review' }], ['active', undefined], ['new', undefined]])
  assert.ok(jobs.every(job => !('resumeKey' in job)))
}))

test('pending server reservations protect deletion and allow normal edits until release', async () => fixture(async store => {
  let project = await store.create('等待生成')
  const episodeId = project.episodeId, session = randomUUID(), requestId = randomUUID()
  project.episodes[0].cards = [{ id: 'c', prompt: '输入', assetIds: [], shots: [] }]
  project = await store.update(project.id, project, project.revision)
  store.queue.reserve(project.id, episodeId, session, requestId, ['c'])
  const clientId = randomUUID()
  const edited = await store.applyChanges(project.id, {    clientId, sequence: 1, changes: [
      { target: 'card', episodeId, id: 'c', fields: { title: '等待时仍可编辑' } },
    ]  })
  const current = await store.get(project.id)
  current.episodes[0].cards = []
  const running = (error: unknown) => error instanceof ScriptVideoStoreError && error.code === 'VIDEO_RUNNING'
  await assert.rejects(store.update(project.id, current, edited.revision), running)
  await assert.rejects(store.applyChanges(project.id, {    clientId, sequence: 2, changes: [
      { target: 'card', episodeId, id: 'c', remove: true },
    ]  }), running)
  await assert.rejects(store.applyChanges(project.id, {    clientId, sequence: 2, changes: [
      { target: 'episode', id: episodeId, remove: true },
    ]  }), running)
  await assert.rejects(store.delete(project.id), running)
  store.queue.release(project.id, episodeId, session, requestId)
  assert.equal((await store.applyChanges(project.id, {    clientId, sequence: 2, changes: [
      { target: 'card', episodeId, id: 'c', remove: true },
    ]  })).episodes[0].cards.length, 0)
}))

test('single-episode writes and directory edits never decode an unloaded episode', async () => fixture(async (store, directory) => {
  const project = await store.create('拆分存储')
  const own = project.episodeId
  project.episodes.push({ ...project.episodes[0], id: 'unloaded', number: 2, script: '只读校验' })
  await store.update(project.id, project, project.revision)
  const db = new Database(join(directory, 'workspace.sqlite3'))
  try {
    // A JSON parse of this unrelated row would fail immediately.
    db.prepare('UPDATE episodes SET document=? WHERE project_id=? AND id=?').run('undecodable', project.id, 'unloaded')
    const clientId = randomUUID()
    assert.equal((await store.episode(project.id, own)).episode.id, own)
    assert.equal((await store.summary(project.id)).episodes.length, 2)
    const saved = await store.applyChanges(project.id, {      clientId, sequence: 1, changes: [
        { target: 'episode', id: own, fields: { title: '独立改动' } },
        { target: 'episode', id: 'new', value: { id: 'new', script: '第三集' } },
        { target: 'episode', order: ['unloaded', 'new', own] },
      ]    })
    assert.deepEqual(saved.project.episodes.map(ep => ep.id), ['unloaded', 'new', own])
    assert.deepEqual(saved.episodes.map(ep => ep.title), ['独立改动', '未命名分集'])
    assert.deepEqual(db.prepare('SELECT document, revision FROM episodes WHERE project_id=? AND id=?').get(project.id, 'unloaded'),
      { document: 'undecodable', revision: 1 })
  } finally { db.close() }
}))

test('shared edits propagate to unloaded episodes and offline references cannot revive a deleted asset', async () => fixture(async store => {
  const project = await store.create('共享资产', STYLE)
  const second = 'unloaded', cardId = 'cut'
  project.assets = [{ id: 'prop', name: '玉玺', kind: 'prop', image: '/static/prop.png' }]
  project.episodes.push({    ...project.episodes[0], id: second, cards: [{
      id: cardId, prompt: '镜头：@玉玺。', assetIds: ['prop'], openingAssetIds: ['prop'],
      shots: [{ id: 'shot', camera: '特写@玉玺', action: '@玉玺落下', visualAssetIds: ['prop'] }],
      promptVersions: [{ prompt: '旧版本@玉玺' }],
    }], production: { stylePreset: STYLE }  })
  await store.update(project.id, project, project.revision)
  const clientId = randomUUID()
  const changed = await store.applyChanges(project.id, {    clientId, sequence: 1, changes: [
      { target: 'asset', id: 'prop', fields: { name: '金印' } }, { target: 'project', fields: { 'settings.stylePreset': STYLE_TWO } },
    ]  })
  assert.equal(changed.episodes.length, 0)
  const episode = (await store.episode(project.id, second)).episode
  assert.equal(episode.production.stylePreset.name, STYLE_TWO.name)
  assert.ok(episode.cards[0].prompt.includes('@金印'))
  assert.equal(episode.cards[0].promptVersions[0].prompt, '旧版本@玉玺')
  await store.applyChanges(project.id, { clientId, sequence: 2, changes: [{ target: 'asset', id: 'prop', remove: true }] })
  const card = (await store.episode(project.id, second)).episode.cards[0]
  assert.deepEqual([card.assetIds, card.openingAssetIds, card.shots[0].visualAssetIds], [[], [], []])
  await assert.rejects(store.applyChanges(project.id, {    clientId, sequence: 3, changes: [
      { target: 'card', id: cardId, episodeId: second, fields: { assetIds: ['prop'] } },
    ]  }), (error: unknown) => error instanceof ScriptVideoStoreError && error.code === 'ASSET_REMOVED')
  assert.deepEqual((await store.episode(project.id, second)).episode.cards[0].assetIds, [])
}))

test('character voice binding works while another episode is open without overwriting its edits', async () => fixture(async (store) => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  const owner = randomUUID(), other = randomUUID()
  let project = await store.create('共享角色声音')
  const first = project.episodeId, second = 'episode-2'
  project.episodes.push({ ...project.episodes[0], id: second, number: 2 })
  project.assets = [
    { id: 'lead', name: '阿宁', kind: 'character', image: '/static/uploads/lead.png' },
    { id: 'palace', name: '宫殿', kind: 'scene', image: '/static/uploads/palace.png' },
  ]
  project = await store.update(project.id, project, project.revision)
  await store.acquireEpisodeLease(project.id, first, owner, false)
  await store.acquireEpisodeLease(project.id, second, other, false)
  const otherDraft = structuredClone(project)
  otherDraft.episodes[1].script = '另一个标签页正在编辑这集'
  await store.update(project.id, otherDraft, project.revision, other)

  const app = createScriptVideoRoutes(store)
  const bind = (session: string, episodeId: string, assetId: string, body: unknown) =>
    app.request(`/projects/${project.id}/episodes/${episodeId}/assets/${assetId}/voice`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'X-Script-Video-Session': session },
      body: JSON.stringify(body),
    })
  const audio = { url: '/static/uploads/lead.wav', name: '角色参考.wav', mimeType: 'audio/wav' }
  const upload = { field: 'voiceAudio', expected: null, value: audio }
  const legacySave = await store.get(project.id)
  legacySave.assets[0].voiceAudio = audio
  await store.update(project.id, legacySave, legacySave.revision, owner)
  assert.equal((await bind(other, first, 'lead', upload)).status, 200)
  const attached = await bind(owner, first, 'lead', upload)
  assert.equal(attached.status, 200)
  const after = await store.get(project.id)
  assert.deepEqual(after.assets[0].voiceAudio, audio)
  assert.equal(after.episodes[1].script, otherDraft.episodes[1].script)
  assert.equal((await bind(owner, first, 'lead', upload)).status, 200)
  assert.equal((await store.get(project.id)).revision, after.revision)
  assert.equal((await bind(other, second, 'lead', { ...upload, value: { ...audio, url: '/static/uploads/new.wav' } })).status, 200)
  assert.equal((await bind(owner, first, 'palace', upload)).status, 400)
  assert.equal((await bind(owner, first, 'lead', { field: 'image', expected: null, value: 'elsewhere' })).status, 400)

  await store.mutate(project.id, ({ jobs }) => {
    jobs.push({ id: 'text-job', projectId: project.id, episodeId: second, action: 'storyboard', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    return { result: null }
  })
  const remove = { field: 'voiceAudio', expected: audio, value: null }
  const busy = await bind(owner, first, 'lead', remove)
  assert.equal(busy.status, 200)
  await store.mutate(project.id, ({ jobs }) => {
    jobs[0].status = 'completed'
    return { result: null }
  })
  assert.equal((await bind(owner, first, 'lead', remove)).status, 200)
  assert.equal((await bind(owner, first, 'lead', { field: 'voiceMode', expected: null, value: 'model' })).status, 200)
  const restored = await store.get(project.id)
  assert.equal(restored.assets[0].voiceAudio, undefined)
  assert.equal(restored.assets[0].voiceMode, 'model')
  assert.deepEqual((await store.update(project.id, { ...restored, assets: [] }, restored.revision, owner)).assets, [])
}))

test('episode video polling batches active tasks without rewriting progress, and finalizes once', async () => fixture(async (store, directory) => {
  const { createScriptVideoRoutes } = await import('../src/routes/script-video')
  const project = await store.create('视频状态批量查询')
  const first = project.episodeId, second = 'episode-2'
  await store.mutate(project.id, ({ project, jobs }) => {
    const initial = project.episodes[0]
    project.episodes.push({ ...initial, id: second, number: 2, tasks: [] })
    const now = new Date().toISOString()
    for (const [index, episode] of project.episodes.entries()) {
      for (const taskId of index === 0 ? [101, 102] : [103, 104]) {
        const id = `job-${taskId}`
        episode.tasks.push({ id, taskId, status: 'processing' })
        jobs.push({ id, taskId, projectId: project.id, episodeId: episode.id,
          action: 'video', status: 'running', createdAt: now, updatedAt: now })
      }
    }
    return { result: null, documentChanged: true }
  })
  const videoStates = new Map<number, Omit<ScriptVideoGenerationStatus, 'taskId'>>()
  const queried: number[] = []
  const app = createScriptVideoRoutes(store, {
    getScriptVideoGeneration: async (taskId: number) => {
      queried.push(taskId)
      return { taskId, ...(videoStates.get(taskId) || { status: 'processing', stage: 'polling' }) }
    },
  } as any)
  const base = `http://localhost/projects/${project.id}`
  const endpoint = `${base}/episodes/${first}/video-status`
  const getData = async (url: string) => {
    const response = await app.request(url)
    assert.equal(response.status, 200)
    return (await response.json() as any).data
  }
  const observer = new Database(join(directory, 'workspace.sqlite3'), { readonly: true })
  const diskVersion = () => observer.pragma('data_version', { simple: true })
  let marked = diskVersion()
  const revision = (await store.get(project.id)).revision
  assert.deepEqual((await getData(endpoint)).tasks.map((task: any) => task.taskId), [101, 102])
  assert.deepEqual(queried, [101, 102])
  assert.deepEqual((await getData(`${base}/jobs?episodeId=${first}`)).map((job: any) => job.taskId), [101, 102])
  assert.equal((await getData(`${base}/video/101`)).status, 'processing')
  assert.equal(diskVersion(), marked)

  videoStates.set(101, { status: 'completed', stage: 'completed', videoUrl: '/static/videos/video.mp4' })
  videoStates.set(102, { status: 'failed', stage: 'failed', code: 'VIDEO_FAILED', error: '视频生成失败' })
  const [activity] = await Promise.all([getData(base + '/episodes/' + first + '/activity'), getData(endpoint)])
  assert.deepEqual(activity.activeCardIds, [])
  assert.deepEqual(activity.tasks.map((task: any) => task.status), ['completed', 'failed'])
  const settled = await store.get(project.id)
  assert.equal(settled.revision, revision + 1)
  assert.deepEqual(settled.episodes[0].tasks.map((task: any) => task.status), ['completed', 'failed'])
  assert.equal(settled.episodes[0].tasks[0].videoUrl, '/static/videos/video.mp4')
  assert.equal(settled.episodes[0].tasks[1].code, 'VIDEO_FAILED')
  assert.deepEqual(settled.episodes[1].tasks.map((task: any) => task.status), ['processing', 'processing'])
  marked = diskVersion()
  assert.deepEqual(await getData(endpoint), { tasks: [] })
  assert.equal((await getData(`${base}/video/101`)).status, 'completed')
  assert.equal(diskVersion(), marked)

  observer.close()
  videoStates.set(103, { status: 'completed', stage: 'completed', videoUrl: '/static/videos/offline.mp4' })
  const reopened = await getData(base)
  assert.deepEqual(reopened.episodes[1].tasks.map((task: any) => task.status), ['completed', 'processing'])
  assert.equal(reopened.revision, revision + 2)
  assert.equal((await app.request(base, { method: 'DELETE' })).status, 409)
  videoStates.set(104, { status: 'failed', stage: 'failed', code: 'VIDEO_FAILED' })
  assert.equal((await app.request(base, { method: 'DELETE' })).status, 200)
}))
