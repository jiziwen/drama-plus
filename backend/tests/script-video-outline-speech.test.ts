import assert from 'node:assert/strict'
import test from 'node:test'
import { generateScriptVideoOutline, ScriptVideoAIError } from '../src/services/script-video-ai.js'
import { isScriptVideoTimingQuestion, outlineSpeechIssues } from '../src/services/script-video-speech-planning.js'

const line = (text: string) => ({ text })
const card = (duration: number, line: number, endCue?: string) => ({
  duration, title: '抵达院门', summary: '两人告别，马车驶出院门。', combat: false, assetIds: [],
  dialogueThrough: { line, endCue },
})
const timingQuestion = '第4段原台词约297字，按自然语速约需60秒。请回复 A 延长、B 拆段或 C 删减部分台词。'

test('outline speech boundaries cover the original dialogue in order, including mid-line cuts and silent segments', () => {
  const source = [line('甲'.repeat(148) + '前句。' + '乙'.repeat(145) + '接下去。'), line('再会。')]
  assert.deepEqual(outlineSpeechIssues(source, [card(30, 0), card(30, 1, '前句。'), card(30, 2)]), [])
  assert.equal(outlineSpeechIssues(source, [card(30, 1, '甲甲'), card(30, 2)])[0]?.code, 'OUTLINE_SPEECH_BOUNDARY')
  assert.equal(outlineSpeechIssues(source, [card(30, 1, '前句。'), card(30, 0)])[0]?.code, 'OUTLINE_SPEECH_ORDER')
  assert.equal(outlineSpeechIssues(source, [card(30, 1, '前句。')]).at(-1)?.code, 'OUTLINE_SPEECH_INCOMPLETE')
  assert.equal(outlineSpeechIssues(source, [card(30, 1), {}])[0]?.code, 'OUTLINE_SPEECH_BOUNDARY')
})

test('outline generation accepts the model duration regardless of dialogue length, with or without a dialogue boundary', async () => {
  const speech = '加快脚步，再往前走。'.repeat(31)
  const input = { script: '人甲：“' + speech + '”', assets: [] }
  for (const dialogueThrough of [{ line: 1 }, undefined]) {
    const result = await generateScriptVideoOutline(input, async () => ({
      cards: [{ ...card(30, 1), dialogueThrough }],
    }))
    assert.equal(result.attempts, 1)
    assert.equal(result.cards[0].duration, 30)
  }
})

test('unsupported timing questions re-enter outline planning automatically; unrelated choices still surface', async () => {
  const input = { script: '人甲：“我会回来。”', assets: [] }
  assert.equal(isScriptVideoTimingQuestion(timingQuestion), true)
  for (const prompt of ['请确认选哪个造型，另一个问题是总时长。', '第30秒是谁说这段话？', '应该选哪张角色图？']) {
    assert.equal(isScriptVideoTimingQuestion(prompt), false)
  }
  const result = await generateScriptVideoOutline(input, async request => {
    if (request.attempted === 1) throw new ScriptVideoAIError('USER_INPUT_REQUIRED', timingQuestion)
    assert.equal(request.issues[0].code, 'AUTO_TIMING')
    return { cards: [card(4, 1)] }
  })
  assert.equal(result.attempts, 2)
  let attempts = 0
  await assert.rejects(generateScriptVideoOutline(input, async () => {
    attempts++
    throw new ScriptVideoAIError('USER_INPUT_REQUIRED', timingQuestion)
  }), { code: 'OUTLINE_TIMING_FAILED' })
  assert.equal(attempts, 3)
  const costume = await generateScriptVideoOutline(input, async request => {
    if (request.attempted === 1) throw new ScriptVideoAIError('USER_INPUT_REQUIRED', '应该选哪张角色图？')
    assert.ok(request.issues.some(issue => /造型/u.test(issue.message)))
    return { cards: [card(4, 1)] }
  })
  assert.equal(costume.attempts, 2)
  await assert.rejects(generateScriptVideoOutline(input, async () => {
    throw new ScriptVideoAIError('USER_INPUT_REQUIRED', '谁交出了原文的第一封信？')
  }), { code: 'USER_INPUT_REQUIRED' })
})

test('the model outline is preserved without a program-enforced total duration rewrite', async () => {
  const result = await generateScriptVideoOutline({ script: '院门关闭。灯影摇晃。'.repeat(50), assets: [] }, async request => {
    assert.equal(request.attempted, 1)
    return { cards: Array.from({ length: 5 }, () => card(30, 0)) }
  })
  assert.equal(result.cards.length, 5)
  assert.equal(result.attempts, 1)
})
