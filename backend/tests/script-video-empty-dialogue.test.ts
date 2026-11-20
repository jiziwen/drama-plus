import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateScriptVideoCards,
  ScriptVideoAIError,
  type ScriptVideoStoryboardCheckpoint,
} from '../src/services/script-video-ai.js'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'

const production = {
  coreRhythm: '小禾在窗前等候。', visualSpecs: '清晨自然光。', shotRhythm: '保持同一空间。',
  dialogueRules: '按原文保留人声。', interfaceRules: '无界面。', costumeRules: '沿用原装。',
  sceneAndCamera: '窗前眼平固定机位。', soundAndEditing: '保留衣料声。',
  continuityReview: '站位和朝向连续。',
  characters: [{ name: '小禾', appearance: '站在窗前。', voice: '年轻女声。' }],
}
const outline: ScriptVideoCard = {
  id: 'waiting', title: '窗前等候', duration: 6, summary: '小禾在窗前等候。',
  assetIds: [], combat: false, shots: [], prompt: '', status: 'draft', version: 1,
}
const input = (script = '△画面：小禾闭口站在窗前。') => ({
  script, assets: [], outline: [outline],
})
function draft(dialogue: unknown = '') {
  return {
    id: outline.id, title: outline.title, duration: outline.duration, summary: outline.summary,
    assetIds: [], combat: false, opening: '小禾已站在窗前。', scene: '1-01 清晨窗前。',
    characters: '小禾在窗前。', independentGeneration: '小禾停步等候。', ending: '小禾仍站在窗前。',
    shots: [
      { duration: 3, camera: '眼平中景固定', action: '小禾站在窗前。', dialogue },
      { duration: 3, camera: '眼平近景固定', action: '小禾垂眼等候。', dialogue: ' \t\n ' },
    ],
  }
}
const hasIssue = (code: string) => (error: unknown) =>
  error instanceof ScriptVideoAIError && error.issues.some(issue => issue.code === code)

test('empty sound cells in generated and streamed shots are filled without an AI repair', async () => {
  const received: ScriptVideoStoryboardCheckpoint[] = []
  const generated = draft('')
  const result = await generateScriptVideoCards(input(), async request => {
    assert.equal(request.mode, 'episode')
    await request.onProduction?.(production)
    await request.onCard?.(generated, 0)
    return { production, cards: [generated] }
  }, { onProgress: (_, checkpoint) => { received.push(structuredClone(checkpoint)) } })
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards[0].shots.map(shot => shot.dialogue), ['（无对白）', '（无对白）'])
  assert.ok(received.some(checkpoint => checkpoint.cards.length === 1))
  assert.ok(received.every(checkpoint => !checkpoint.repairAttempts))
})

test('partial repairs normalize blank sound cells without using another repair attempt', async () => {
  const generated = draft('小禾：“明天出发。”')
  generated.shots[0].duration = 2
  const result = await generateScriptVideoCards(input('小禾：“明天出发。”'), async request => {
    if (request.mode !== 'repair') return { production, cards: [generated] }
    assert.ok(request.issues.some(issue => issue.code === 'DUR009'))
    assert.ok(request.issues.every(issue => issue.code !== 'OUTPUT_FORMAT'))
    return { patches: [{ id: outline.id, shots: [{ index: 1, duration: 3 }, { index: 2, dialogue: '\t ' }] }] }
  })
  assert.equal(result.attempts, 2)
  assert.equal(result.cards[0].shots[0].dialogue, '小禾：“明天出发。”')
  assert.equal(result.cards[0].shots[1].dialogue, '（无对白）')
})

test('replacement repairs accept explicit empty sound cells while retaining nonempty sound text', async () => {
  const replacement = draft('音效：衣料轻响。')
  const broken = { ...replacement, opening: undefined }
  const result = await generateScriptVideoCards(input(), async request =>
    request.mode === 'repair'
      ? { patches: [{ id: outline.id, replacement }] }
      : { production, cards: [broken] },
  )
  assert.equal(result.attempts, 2)
  assert.equal(result.cards[0].shots[0].dialogue, '音效：衣料轻响。')
  assert.equal(result.cards[0].shots[1].dialogue, '（无对白）')
})

test('a missing original line stays visible as a warning without spending a repair call', async () => {
  let calls = 0
  const result = await generateScriptVideoCards(input('小禾：“明天出发。”'), async request => {
    calls++
    assert.equal(request.mode, 'episode')
    return { production, cards: [draft('')] }
  })
  assert.equal(calls, 1)
  assert.ok(result.warnings.some(issue => issue.code === 'DIALOGUE_MISSING'))
  assert.deepEqual(result.cards[0].shots.map(shot => shot.dialogue), ['（无对白）', '（无对白）'])
})

test('missing and non-string sound fields remain output format errors', async () => {
  for (const value of [undefined, null, 7]) {
    const generated = draft(value)
    if (value === undefined) delete (generated.shots[0] as { dialogue?: unknown }).dialogue
    await assert.rejects(generateScriptVideoCards(input(), async request =>
      request.mode === 'repair'
        ? { patches: [{ id: outline.id }] }
        : { production, cards: [generated] },
    ), hasIssue('OUTPUT_FORMAT'))
  }
})
