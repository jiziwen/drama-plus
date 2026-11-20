import assert from 'node:assert/strict'
import test from 'node:test'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { runScriptVideoWholeModel } from '../src/services/script-video-whole-model.js'
import { generateScriptVideoCards, ScriptVideoAIError, type ScriptVideoStoryboardCheckpoint } from '../src/services/script-video-ai.js'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'

const production = {
  coreRhythm: '信交出去，收信人作答。', visualSpecs: '清晨的自然光', shotRhythm: '沿交信方向切镜',
  dialogueRules: '保留来信原句。', interfaceRules: '无界面', costumeRules: '沿用原装',
  sceneAndCamera: '交信者站在窗前左侧。', soundAndEditing: '纸张翻动声跨镜延续。',
  continuityReview: '接住信后才展开阅读。',
  characters: [{ name: '小禾', appearance: '本集的信使', voice: '年轻女声' }],
}
const plan = (durations: number[]): ScriptVideoCard[] => durations.map((duration, index) => ({
  id: 'mail-' + (index + 1), duration, title: '交信' + (index + 1),
  summary: '小禾在窗前展开信。', assetIds: [], combat: false, shots: [], prompt: '', status: 'draft', version: 1,
}))
const input = (lines: string[], durations: number[]) => ({
  assets: [], outline: plan(durations), script: lines.map(line => '小禾：“' + line + '”').join('\n'),
})
function draft(id: string, duration: number, line: string) {
  return {
    id, duration, title: '来信', summary: '小禾朗读来信。', assetIds: [], combat: false,
    opening: '接住信抬头。', scene: '1-01 清晨窗前。', characters: '小禾在窗前。',
    independentGeneration: '拿着来信念出原话。', ending: '信纸停在窗边。',
    shots: [{ duration, camera: '中景固定', action: '小禾在窗前念信。', dialogue: line ? '小禾【朗读】：“' + line + '”' : '纸张翻动声。' }],
  }
}
function anchoredInput(lines: string[], durations: number[]) {
  const episode = input(lines, durations)
  episode.outline = episode.outline.map((card, index) => ({ ...card, dialogueThrough: { line: index + 1 } }))
  return episode
}
const actualQuestion = () => new ScriptVideoAIError('USER_INPUT_REQUIRED', '第4段原台词约297字，无法在30秒内按自然语速完整说完。请选择拆段、延时或压缩对白。')

test('the writer can compress a confirmed 137s plan to four slots, in one call with the entire source', async () => {
  const lines = ['信上写着春天的消息。', '这是大家等了很久的答复。', '他们都可以踏上归途了。', '明天早晨我们就走。']
  const original = input(lines, [30, 30, 30, 30, 17])
  const result = await generateScriptVideoCards(original, async req => {
    const data = JSON.parse(req.message)
    assert.equal(data.confirmedOutline.length, 5)
    assert.equal(data.timing.targetSeconds, 120)
    assert.equal(data.timing.estimatedSpeechSeconds, undefined)
    assert.equal(data.speechPlanning, undefined)
    assert.match(req.instructions, /先压缩次要动作/)
    return {
      timingPlan: { durations: [30, 30, 30, 30], reason: '省略开门、挪椅和整理信纸的重复动作。' },
      production, cards: lines.map((line, i) => draft(original.outline[i].id, 30, line)),
    }
  })
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards.map(c => c.duration), [30, 30, 30, 30])
  assert.equal(original.outline.length, 5)
})

test('storyboard generation accepts the model timeline regardless of dialogue length', async () => {
  const first = '明日启程。'
  const middle = '望你一路平安'.repeat(26)
  const end = '请给家人带好'.repeat(24)
  const original = input([first, middle, end], [30, 30])
  const counts: number[] = []
  const result = await generateScriptVideoCards(original, async req => {
    assert.equal(req.mode, 'episode')
    const cards = [draft('mail-1', 30, first), draft('mail-2', 30, middle + end)]
    await req.onProduction!(production)
    await req.onCard!(cards[0], 0)
    await req.onCard!(cards[1], 1)
    assert.equal(counts.at(-1), 2)
    return { production, cards }
  }, {
    onProgress: (_, checkpoint) => { counts.push(checkpoint.cards.length) },
  })
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards.map(c => c.duration), [30, 30])
})

test('timing and costume questions are recovered within the shared three-repair budget, while source questions pass through', async () => {
  const original = input(['只需把信交给他。'], [5])
  let calls = 0
  const result = await generateScriptVideoCards(original, async req => {
    if (++calls === 1) throw actualQuestion()
    assert.match(JSON.parse(req.message).timing.correction, /自动|自行/)
    return { production, cards: [draft('mail-1', 5, '只需把信交给他。')] }
  })
  assert.equal(result.attempts, 2)
  let checkpoint: ScriptVideoStoryboardCheckpoint | undefined
  calls = 0
  await assert.rejects(generateScriptVideoCards(original, async () => { calls++; throw actualQuestion() }, {
    onProgress: (_progress, cp) => { checkpoint = structuredClone(cp) },
  }), { code: 'STORYBOARD_REPAIRS_EXHAUSTED' })
  assert.equal(calls, 4)
  assert.equal(checkpoint!.repairAttempts, 3)
  await assert.rejects(generateScriptVideoCards(original, async () => { calls++; throw actualQuestion() }, { checkpoint }), {
    code: 'STORYBOARD_REPAIRS_EXHAUSTED',
  })
  assert.equal(calls, 4)
  const assetQuestion = new ScriptVideoAIError('USER_INPUT_REQUIRED', '需要确认小禾使用哪张角色图？')
  calls = 0
  const resumed = await generateScriptVideoCards(original, async (req) => {
    if (++calls === 1) throw assetQuestion
    assert.match(req.message, /造型/u)
    return { production, cards: [draft('mail-1', 5, '只需把信交给他。')] }
  })
  assert.equal(resumed.attempts, 2)
  assert.equal(calls, 2)
  const sourceQuestion = new ScriptVideoAIError('USER_INPUT_REQUIRED', '原文中的来信是谁交给小禾的？')
  calls = 0
  await assert.rejects(generateScriptVideoCards(original, async () => { calls++; throw sourceQuestion }), sourceQuestion)
  assert.equal(calls, 1)
})

test('the adjusted time slots survive a streaming interruption and already accepted speech stays locked on resume', async () => {
  const lines = ['昨天收到你的信。', '我明天出发。', '后天就能见面了。']
  const original = input(lines, [30, 6])
  let saved: ScriptVideoStoryboardCheckpoint | undefined
  const timingPlan = { durations: [30, 30, 6], reason: '保留朗读及换气。' }
  let id = ''
  await assert.rejects(generateScriptVideoCards(original, async req => {
    id = JSON.parse(req.message).timing.extraIdPrefix + '3'
    await req.onTimingPlan!(timingPlan)
    await req.onProduction!(production)
    await req.onCard!(draft('mail-1', 30, lines[0]), 0)
    await req.onCard!(draft('mail-2', 30, lines[1]), 1)
    throw Object.assign(new Error('connection timed out'), { statusCode: 524 })
  }, { onProgress: (_, cp) => { saved = structuredClone(cp) } }), { code: 'MODEL_TIMEOUT' })
  assert.deepEqual(saved!.timingPlan, timingPlan)
  assert.equal(saved!.cards.length, 2)
  const result = await generateScriptVideoCards(original, async req => {
    const data = JSON.parse(req.message)
    assert.deepEqual(data.targetCardIds, [id])
    assert.equal(data.timing.lockedSegmentCount, 2)
    return { cards: [draft(id, 6, lines[2])] }
  }, { checkpoint: saved })
  assert.deepEqual(result.cards.map(c => c.id), ['mail-1', 'mail-2', id])
  assert.deepEqual(result.cards[0].shots, saved!.cards[0].shots)

  let batchedCalls = 0
  const batched = await generateScriptVideoCards(original, async req => {
    const data = JSON.parse(req.message)
    assert.deepEqual(data.targetCardIds, [id])
    assert.equal(data.timing.nextSpokenLines[0].text, lines[2])
    batchedCalls++
    const dialogueThrough = [{ line: 1 }, { line: 1 }, { line: 3 }]
    return { timingPlan: { ...timingPlan, dialogueThrough }, cards: [draft(id, 6, lines[2])] }
  }, { batchSize: 1, checkpoint: saved })
  assert.equal(batchedCalls, 1)
  assert.deepEqual(batched.cards[1].shots, saved!.cards[1].shots)
  assert.deepEqual(batched.cards.map(c => c.dialogueThrough?.line), [1, 1, 3])
})

test('one-card batches keep the model timing plan and pass the accepted shot and next original line forward', async () => {
  const lines = ['明天就出发。', '我替你收好这封信。', '到家后打开看。']
  const original = input([lines[0] + lines[1], lines[2]], [30, 30, 6])
  const dialogueThrough = [{ line: 1, endCue: lines[0] }, { line: 1 }, { line: 2 }]
  const timingPlan = {
    durations: [30, 30, 11],
    dialogueThrough,
    reason: '尾段留时间给收信人的反应。',
  }
  const completedCounts: number[] = []
  const targets: string[] = []

  const result = await generateScriptVideoCards(original, async request => {
    const data = JSON.parse(request.message)
    const index = targets.length
    const id = 'mail-' + (index + 1)
    assert.equal(request.mode, 'episode')
    assert.deepEqual(data.targetCardIds, [id])
    assert.equal(data.timing.lockedSegmentCount, index)
    assert.equal(data.confirmedOutline.length, 3)
    assert.equal(data.confirmedScript, original.script)
    if (index) {
      assert.equal(completedCounts.at(-1), index)
      assert.equal(data.previousCard.ending, '前一段末镜 ' + index)
      assert.equal(data.previousCard.lastShot.dialogue, '小禾【朗读】：“' + lines[index - 1] + '”')
      assert.equal(data.timing.nextSpokenLines[0].text, lines[index])
      assert.deepEqual(data.timing.currentDurations, timingPlan.durations)
      assert.deepEqual(data.production.characters, production.characters)
    }
    targets.push(id)
    const card = { ...draft(id, timingPlan.durations[index], lines[index]), ending: '前一段末镜 ' + (index + 1) }
    return index === 0 ? { timingPlan, production, cards: [card] } : { cards: [card] }
  }, {
    batchSize: 1,
    onProgress: (_, checkpoint) => { completedCounts.push(checkpoint.cards.length) },
  })

  assert.deepEqual(targets, ['mail-1', 'mail-2', 'mail-3'])
  assert.deepEqual(result.cards.map(card => card.duration), timingPlan.durations)
  assert.deepEqual(result.cards.map(card => card.dialogueThrough), dialogueThrough)
  assert.deepEqual(result.cards.map(card => card.id), targets)
  assert.equal(completedCounts.at(-1), 3)
})

test('HTTP 524 during batched generation saves the accepted prefix and resumes with its next original line', async () => {
  const lines = ['我把信带过来了。', '请把它收好。', '今晚再读。']
  const original = anchoredInput(lines, [30, 30, 6])
  const requested: string[][] = []
  let saved: ScriptVideoStoryboardCheckpoint | undefined

  await assert.rejects(generateScriptVideoCards(original, async request => {
    const data = JSON.parse(request.message)
    requested.push(data.targetCardIds)
    if (requested.length === 1) return { production, cards: [draft('mail-1', 30, lines[0])] }
    throw Object.assign(new Error('fixture gateway timeout'), { statusCode: 524 })
  }, {
    batchSize: 1,
    onProgress: (_, checkpoint) => { saved = structuredClone(checkpoint) },
  }), { code: 'MODEL_TIMEOUT' })
  assert.deepEqual(requested, [['mail-1'], ['mail-2']])
  assert.deepEqual(saved?.cards.map(card => card.id), ['mail-1'])
  assert.equal(saved?.repairAttempts, 0)

  const result = await generateScriptVideoCards(original, async request => {
    const data = JSON.parse(request.message)
    const index = requested.length - 1
    const id = 'mail-' + (index + 1)
    assert.deepEqual(data.targetCardIds, [id])
    assert.equal(data.timing.nextSpokenLines[0].text, lines[index])
    requested.push(data.targetCardIds)
    return { cards: [draft(id, original.outline[index].duration, lines[index])] }
  }, { batchSize: 1, checkpoint: saved })

  assert.deepEqual(requested, [['mail-1'], ['mail-2'], ['mail-2'], ['mail-3']])
  assert.deepEqual(result.cards[0].shots, saved?.cards[0].shots)
  assert.deepEqual(result.cards.map(card => card.id), ['mail-1', 'mail-2', 'mail-3'])
})

test('a batch outside its planned dialogue boundary remains editable and warns without spending repair calls', async () => {
  const lines = ['我要把信给你。', '记得在车上读。']
  const original = anchoredInput(lines, [30, 6])

  for (const dialogue of [lines[1], lines.join('')]) {
    const wrongFirst = draft('mail-1', 30, dialogue)
    let saved: ScriptVideoStoryboardCheckpoint | undefined
    const requested: string[][] = []

    const result = await generateScriptVideoCards(original, async request => {
      const data = JSON.parse(request.message)
      requested.push(data.targetCardIds)
      assert.equal(request.mode, 'episode')
      return { production, cards: [data.targetCardIds[0] === 'mail-1' ? wrongFirst : draft('mail-2', 6, lines[1])] }
    }, {
      batchSize: 1,
      onProgress: (_, checkpoint) => { saved = structuredClone(checkpoint) },
    })

    assert.deepEqual(requested, [['mail-1'], ['mail-2']])
    assert.equal(saved?.repairAttempts, 0)
    assert.equal(saved?.cards.length, 2)
    assert.equal(result.attempts, 2)
    assert.ok(result.warnings.some(issue => issue.code.startsWith('DIALOGUE_')))
  }
})

test('non-streaming text replies expose the timing plan before their cards and route prose timing choices to automatic handling', async () => {
  const plan = { durations: [30, 12], reason: '来信需要完整朗读。' }
  const seen: string[] = []
  const request = {
    instructions: '按主干编排', message: '交付本集',
    schema: z.object({ cards: z.array(z.object({})) }),
    onTimingPlan: (value: unknown) => { assert.deepEqual(value, plan); seen.push('plan') },
    onCard: () => { seen.push('card') },
  }
  function endpoint(content: string) {
    const model = createOpenAI({
      apiKey: 'test', baseURL: 'http://fixture.invalid',
      fetch: async () => Response.json({
        id: 'completion', created: 1, model: 'local',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
    }).chat('local')
    return async () => ({ model })
  }
  await runScriptVideoWholeModel(request, endpoint(JSON.stringify({ cards: [{}], timingPlan: plan })))
  assert.deepEqual(seen, ['plan', 'card'])
  await assert.rejects(runScriptVideoWholeModel(request, endpoint(actualQuestion().message)), {
    code: 'USER_INPUT_REQUIRED',
  })
})
