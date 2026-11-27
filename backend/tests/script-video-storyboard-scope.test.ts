import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'
import type { ScriptVideoStoryboardMode } from '../src/services/script-video-storyboard-mode.js'

const outline: ScriptVideoCard[] = ['到院门', '推门', '入院'].map((title, index) => ({
  id: 'scope-' + (index + 1), title, summary: title, duration: 30, assetIds: [], combat: false,
  prompt: '', shots: [], version: 1, status: 'draft',
}))
const production = {
  coreRhythm: '推门入院。', visualSpecs: '晨光', shotRhythm: '固定长镜', dialogueRules: '无对白',
  interfaceRules: '无界面', costumeRules: '原稿服装', sceneAndCamera: '院门朝外',
  soundAndEditing: '门轴声', continuityReview: '承接推门的动作', characters: [],
}
const savedCards = outline.map(card => ({
  ...card, prompt: card.summary, opening: '院门前', scene: '清晨庭院', characters: '来客在门边',
  ending: card.summary, independentGeneration: card.summary,
  shots: [{ id: card.id + '-shot', duration: 30, camera: '固定全景',
    action: card.summary + '\n情绪提示：从容。', dialogue: '无台词\n音效：门轴轻响。' }],
}))
type WireRequest = {
  stream: boolean
  messages: { role: string; content: string }[]
  tools: { function: { name: string; parameters: {
    required: string[]
    properties: { cards: { minItems: number; maxItems?: number; items: { required: string[] } } }
  } } }[]
}

test('both storyboard modes send a delivery scope consistent with the submit_draft tool', async t => {
  const oldPath = process.env.SQLITE_PATH
  const oldMysql = process.env.MYSQL_AUTO_IMPORT
  process.env.SQLITE_PATH = ':memory:'
  process.env.MYSQL_AUTO_IMPORT = 'false'
  t.after(() => {
    if (oldPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = oldPath
    if (oldMysql === undefined) delete process.env.MYSQL_AUTO_IMPORT
    else process.env.MYSQL_AUTO_IMPORT = oldMysql
  })
  const sent: WireRequest[] = []
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json({ id: 'scope-fixture', max_output_tokens: 12000, max_input_tokens: 99000 })
    sent.push(JSON.parse(String(init.body)))
    return Response.json({ error: { message: 'Captured request', type: 'rate_limit_error' } }, { status: 429 })
  })
  const { db, schema } = await import('../src/db/index.js')
  const { generateScriptVideoCards } = await import('../src/services/script-video-ai.js')
  const now = new Date().toISOString()
  const { id: configId } = db.insert(schema.aiServiceConfigs).values({
    name: 'scope fixture', serviceType: 'text', provider: 'openai', apiKey: 'fixture',
    baseUrl: 'https://scope.invalid', model: '["scope-fixture"]', createdAt: now, updatedAt: now,
  }).returning().get()

  async function capture(storyboardMode: ScriptVideoStoryboardMode, saved: number, batchSize?: number) {
    const before = sent.length
    await assert.rejects(generateScriptVideoCards({
      configId, model: 'scope-fixture', storyboardMode, script: '来客推门进入院中。', assets: [], outline,
    }, undefined, {
      batchSize,
      checkpoint: saved ? { cards: savedCards.slice(0, saved), production } : undefined,
    }))
    assert.equal(sent.length, before + 1)
    const body = sent[before]
    assert.equal(body.stream, true)
    const system = body.messages.find(message => message.role === 'system')!.content
    const data = JSON.parse(body.messages.find(message => message.role === 'user')!.content)
    const draft = body.tools.find(tool => tool.function.name === 'submit_draft')!.function.parameters
    assert.deepEqual(data.targetCardIds, outline.slice(saved, batchSize ? saved + batchSize : undefined).map(card => card.id))
    assert.equal(draft.properties.cards.minItems, 1)
    assert.equal(draft.properties.cards.maxItems, batchSize)
    assert.equal(draft.required.includes('production'), saved === 0)
    assert.ok(draft.properties.cards.items.required.includes('characters'))
    assert.doesNotMatch(system, /一次回答中按已确认的主干事件顺序写完整集|正式稿在一次请求中写完整集|同一次回答里上一段的实际末镜/u)
    return system
  }

  for (const mode of ['cultivation', 'original'] as const) {
    await t.test(mode, async () => {
      const first = await capture(mode, 0, 1)
      assert.match(first, /cards 只提交 targetCardIds 指定的 1 段/u)
      assert.match(first, /从已保存的 0 段之后按新时间表顺序取最多 1 段/u)
      assert.match(first, /segments 是 confirmedOutline 中从 1 起算的段号/u)
      const tail = await capture(mode, 2, 2)
      assert.match(tail, /指定的 1 段。重排时，从已保存的 2 段之后按新时间表顺序取最多 2 段，尾批只交剩余段/u)
      assert.match(await capture(mode, 0), /从首段开始生成整集。cards 按生效的时间表一次提交所有片段/u)
      assert.match(await capture(mode, 1), /已保存的 1 段之后接写，按生效的时间表一次提交全部剩余片段/u)
    })
  }
  await t.test('installed workspace overrides retain custom notes while dropping the old whole-episode rule', async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'storyboard-scope-'))
    const prior = process.env.WORKSPACE_PATH
    t.after(async () => {
      if (prior === undefined) delete process.env.WORKSPACE_PATH
      else process.env.WORKSPACE_PATH = prior
      await rm(dir, { recursive: true, force: true })
    })
    const root = path.join(dir, 'skills/script-to-video')
    await mkdir(path.join(root, 'references'), { recursive: true })
    const legacy = [
      ['references/validation.md', '模型在一次回答中按已确认的主干事件顺序写完整集分镜，并按原文检查相邻片段的首末镜承接。\n项目自定义校验：留意推门方向。'],
      ['项目适配说明.md', '正式稿在一次请求中写完整集。项目自定义交付：保留右手状态。按已确认大纲的顺序输出所有片段，整集制作规格、人物与声音设定只写一次。每段开头接同一次回答里上一段的实际末镜。'],
    ]
    for (const [name, text] of legacy) await writeFile(path.join(root, name), text)
    process.env.WORKSPACE_PATH = dir
    for (const mode of ['cultivation', 'original'] as const) {
      const instructions = await capture(mode, 0, 1)
      assert.match(instructions, /项目自定义校验：留意推门方向/u)
      if (mode === 'original') assert.match(instructions, /项目自定义交付：保留右手状态/u)
      assert.doesNotMatch(instructions, /按已确认大纲的顺序输出所有片段/u)
    }
    for (const [name, text] of legacy) assert.equal(await readFile(path.join(root, name), 'utf8'), text)
  })
})
