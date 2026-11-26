import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateScriptVideoCards,
  ScriptVideoAIError,
  type ScriptVideoModelRequest,
  type ScriptVideoStoryboardCheckpoint,
} from '../src/services/script-video-ai.js'
import type { EpisodeIssue } from '../src/services/script-video-episode-repair.js'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'

const outline: ScriptVideoCard[] = ['到门前', '看向院中', '推门'].map((title, index) => ({
  id: 'courtyard-' + (index + 1),
  title,
  summary: title,
  duration: 3,
  assetIds: [],
  combat: false,
  prompt: '',
  shots: [],
  version: 1,
  status: 'draft',
}))
const production = {
  coreRhythm: '到门前站定，再推门。',
  visualSpecs: '晨光',
  shotRhythm: '固定机位',
  dialogueRules: '本场无对白。',
  interfaceRules: '无界面',
  costumeRules: '原稿服装',
  sceneAndCamera: '院内朝门',
  soundAndEditing: '门轴细响',
  continuityReview: '沿用推门方向',
  characters: [],
}
const input = { script: '阿明走到院门前站定，看向院中，再推门。', assets: [], outline }
const drafts = outline.map((card, index) => ({
  ...card,
  opening: '院门前',
  ending: card.summary,
  scene: '清晨庭院',
  characters: '阿明站在院门前',
  independentGeneration: card.summary,
  shots: [
    {
      duration: index === 0 ? 2 : 3,
      camera: '固定全景',
      action: '阿明' + card.summary,
      dialogue: '静默。',
    },
  ],
}))
const correction = { patches: [{ id: outline[0].id, shots: [{ index: 1, duration: 3 }] }] }

test('cultivation restores missing per-segment characters from explicit visual bindings without a repair call', async () => {
  const assets = [
    { id: 'a', kind: 'character', name: '阿明', image: '' },
    { id: 'b', kind: 'character', name: '阿兰', image: '' },
  ]
  const plan = [...outline, { ...outline[2], id: 'courtyard-4', title: '回到院中' }]
  const generated = plan.map((segment, index) => ({
    ...drafts[2],
    ...segment,
    characters: undefined,
    assetIds: [assets[index % 2].id],
    shots: [{
      duration: segment.duration,
      camera: '全景，固定机位。',
      action: `${assets[index % 2].name}在院门前${segment.title}。\n情绪提示：神情平静。`,
      dialogue: '无台词\n音效：脚步轻响。',
      visualAssetIds: [assets[index % 2].id],
    }],
  }))
  const result = await generateScriptVideoCards(
    { ...input, script: '阿明和阿兰在院门前往来。', assets, outline: plan, storyboardMode: 'cultivation' },
    async request => {
      assert.equal(request.mode, 'episode', '已有入画角色绑定，无需请求定点修复')
      return { production, cards: generated }
    },
  )
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards.map(card => card.characters?.split('。')[0]), ['阿明', '阿兰', '阿明', '阿兰'])
  assert.deepEqual(result.cards.map(card => card.assetIds), [['a'], ['b'], ['a'], ['b']])
  assert.deepEqual(result.cards.map(card => card.shots[0].dialogue), generated.map(card => card.shots[0].dialogue))
})

test('cultivation repairs just the missing characters field when visual bindings cannot supply it', async () => {
  const draft = {
    ...drafts[2], characters: undefined,
    shots: [{ ...drafts[2].shots[0], action: '阿明推门。\n情绪提示：神情平静。', dialogue: '无台词\n音效：门轴细响。' }],
  }
  const result = await generateScriptVideoCards(
    { ...input, outline: [outline[2]], storyboardMode: 'cultivation' },
    async request => {
      if (request.mode === 'episode') return { production, cards: [draft] }
      assert.equal(request.mode, 'repair')
      assert.deepEqual(JSON.parse(request.message).targetCardIds, [draft.id])
      assert.match(request.instructions, /fields\.characters/u)
      assert.match(request.issues[0]?.message ?? '', /第1段 characters/u)
      return { patches: [{ id: draft.id, fields: { characters: '阿明站在院门前。' } }] }
    },
  )
  assert.equal(result.attempts, 2)
  assert.equal(result.cards[0].characters, '阿明站在院门前。')
  assert.equal(result.cards[0].shots[0].action, draft.shots[0].action)
  assert.equal(result.cards[0].shots[0].dialogue, draft.shots[0].dialogue)
})

test('cultivation reports missing characters and every malformed shot in the same repair request', async () => {
  const shotCounts = [5, 5, 4, 4]
  const plan = [...outline, { ...outline[2], id: 'courtyard-4', title: '走入房中', summary: '走入房中' }].map((segment, index) => ({
    ...segment,
    duration: shotCounts[index] * 2,
  }))
  const lines = ['我到了。', '院里很安静。', '房门没锁。', '我进来了。']
  const generated = plan.map((segment, index) => ({
    ...drafts[2],
    ...segment,
    characters: undefined,
    shots: Array.from({ length: shotCounts[index] }, (_, shotIndex) => ({
      duration: 2,
      camera: shotIndex === 0 ? '近景固定' : '中景固定',
      action: shotIndex === 0 ? `阿明${segment.title}。` : '阿明停下脚步。',
      dialogue: shotIndex === 0 ? `阿明【轻声】：“${lines[index]}”` : '无台词',
    })),
  }))
  const fixedShots = generated.map((segment, index) => segment.shots.map((shot, shotIndex) => ({
    ...shot,
    action: shot.action + '\n情绪提示：神情平静。',
    dialogue: (shotIndex === 0
      ? `阿明【男｜青年感｜清朗｜平静｜轻声｜正常｜对白（1/1）｜普通话】：「${lines[index]}」`
      : '无台词') + '\n音效：院里的风声。',
  })))
  const repairs: ScriptVideoModelRequest[] = []
  const result = await generateScriptVideoCards({
    ...input,
    script: plan.map((segment, index) => `阿明${segment.title}。\n阿明：“${lines[index]}”`).join('\n'),
    outline: plan,
    storyboardMode: 'cultivation',
  }, async request => {
    if (request.mode === 'episode') return { production, cards: generated }
    repairs.push(request)
    return {
      production: { ...production, visualSpecs: '正午逆光' },
      patches: plan.map((segment, index) => ({
        id: segment.id,
        fields: { characters: `阿明在本段${segment.title}并轻声说话。` },
        shots: fixedShots[index].map(({ action, dialogue }, shotIndex) => ({ index: shotIndex + 1, action, dialogue })),
      })),
    }
  })

  assert.equal(repairs.length, 1)
  const repair: { targetCardIds: string[]; issues: EpisodeIssue[] } = JSON.parse(repairs[0].message)
  assert.deepEqual(repair.targetCardIds, plan.map(segment => segment.id))
  for (const [index, segment] of plan.entries()) {
    const issues = repair.issues.filter(issue => issue.cardId === segment.id)
    assert.ok(issues.some(issue => issue.code === 'OUTPUT_FORMAT' && /\bcharacters\b/u.test(issue.message)))
    const shotNumbers = issues.flatMap(issue =>
      issue.code === 'CULTIVATION_SHOT_FORMAT' ? issue.message.match(/\d+/gu) ?? [] : [])
    assert.deepEqual([...new Set(shotNumbers)], Array.from({ length: shotCounts[index] }, (_, shotIndex) => String(shotIndex + 1)))
  }
  assert.deepEqual(result.production, production)
  assert.deepEqual(result.cards.map(({ id, duration }) => ({ id, duration })), plan.map(({ id, duration }) => ({ id, duration })))
  assert.deepEqual(result.cards.map(card => card.characters), plan.map(segment => `阿明在本段${segment.title}并轻声说话。`))
  assert.deepEqual(result.cards.map(card => card.shots.map(({ duration, camera, action, dialogue }) => ({ duration, camera, action, dialogue }))), fixedShots)
})

test('resume keeps received segments after a TS failure and writes only the missing suffix', async () => {
  let saved: ScriptVideoStoryboardCheckpoint | undefined
  const persist = (_progress: unknown, cp: ScriptVideoStoryboardCheckpoint) => {
    saved = structuredClone(cp)
  }
  await assert.rejects(
    generateScriptVideoCards(
      input,
      async (req) => {
        await req.onProduction!(production)
        await req.onCard!(drafts[0], 0)
        await req.onCard!(drafts[1], 1)
        throw Object.assign(Error('interrupted'), { statusCode: 524 })
      },
      { onProgress: persist },
    ),
    (e) => e instanceof ScriptVideoAIError && e.code === 'MODEL_TIMEOUT',
  )
  assert.equal(saved!.cards.length, 0)
  assert.equal(saved!.partialRaw!.cards.length, 2)

  const modes: string[] = []
  const result = await generateScriptVideoCards(
    input,
    async (req) => {
      modes.push(req.mode!)
      const data = JSON.parse(req.message)
      if (req.mode === 'episode') {
        assert.deepEqual(data.targetCardIds, [outline[2].id])
        assert.equal(data.previousCard.lastShot.action, drafts[1].shots[0].action)
        return { cards: [drafts[2]] }
      }
      assert.deepEqual(data.targetCardIds, [outline[0].id])
      return correction
    },
    { checkpoint: saved },
  )
  assert.deepEqual(modes, ['episode', 'repair'])
  assert.deepEqual(
    result.cards.map((card) => card.shots[0].action),
    drafts.map((card) => card.shots[0].action),
  )
})

test('a timeout in the third paid repair reports the original TS issue and exhausts the budget on resume', async () => {
  let calls = 0
  let saved: ScriptVideoStoryboardCheckpoint | undefined
  const isExhausted = (err: unknown) =>
    err instanceof ScriptVideoAIError &&
    err.code === 'STORYBOARD_REPAIRS_EXHAUSTED' &&
    ['DUR009', 'MODEL_TIMEOUT'].every((code) => err.issues.some((issue) => issue.code === code))
  await assert.rejects(
    generateScriptVideoCards(
      input,
      async (req) => {
        calls++
        if (req.mode === 'episode') return { production, cards: drafts }
        if (calls === 4) throw Object.assign(Error('private upstream error'), { statusCode: 504 })
        return { patches: [] }
      },
      {
        onProgress: (_, cp) => {
          saved = structuredClone(cp)
        },
      },
    ),
    isExhausted,
  )
  assert.equal(calls, 4)
  assert.equal(saved!.repairAttempts, 3)
  await assert.rejects(
    generateScriptVideoCards(
      input,
      async () => {
        calls++
        return {}
      },
      { checkpoint: saved },
    ),
    isExhausted,
  )
  assert.equal(calls, 4)
})

test('a patch targeting an unrelated segment is rejected atomically', async () => {
  const result = await generateScriptVideoCards(input, async (req) => {
    if (req.mode === 'episode') return { production, cards: drafts }
    if (req.attempted === 1)
      return {
        patches: [
          ...correction.patches,
          { id: outline[2].id, shots: [{ index: 1, action: '意外修改' }] },
        ],
      }
    assert.equal(JSON.parse(req.message).previousPatchIssues[0].code, 'REPAIR_SCOPE')
    return correction
  })
  assert.equal(result.attempts, 3)
  assert.equal(result.cards[2].shots[0].action, drafts[2].shots[0].action)
})
