import assert from 'node:assert/strict'
import test from 'node:test'
import { generateScriptVideoCards, generateScriptVideoOutline } from '../src/services/script-video-ai.js'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'

const production = {
  coreRhythm: '门前交谈。', visualSpecs: '清晨自然光。', shotRhythm: '固定机位。',
  dialogueRules: '依照原文。', interfaceRules: '无界面。', costumeRules: '沿用原装。',
  sceneAndCamera: '门前同一空间。', soundAndEditing: '保留环境声。', continuityReview: '两人仍在门前。',
  characters: [{ name: '甲', appearance: '门前。', voice: '男声。' }, { name: '乙', appearance: '门旁。', voice: '女声。' }],
}
const plan = (duration: number, index = 0): ScriptVideoCard => ({
  id: 'advisory-' + index, title: '门前' + index, duration, summary: '门前交谈。',
  assetIds: [], combat: false, shots: [], prompt: '', status: 'draft', version: 1,
})
const draft = (card: ScriptVideoCard, dialogue: string) => ({
  ...card, opening: '甲乙站在门前。', scene: '清晨门前。', characters: '甲乙站在门前。',
  independentGeneration: '两人在门前交谈。', ending: '甲乙仍在门前。',
  shots: [{ duration: card.duration, camera: '中景固定', action: '甲乙站在门前。', dialogue }],
})

test('content and unresolved materials reach editable storyboards without any paid repair', async () => {
  const outline = [plan(4), plan(6, 1)]
  const received: string[][] = []
  const result = await generateScriptVideoCards({
    script: '甲：“开门。”\n乙：“进来。”', assets: [], outline,
  }, async request => {
    assert.equal(request.mode, 'episode', 'advisories must never start an automatic repair')
    const ids = JSON.parse(request.message).targetCardIds
    received.push(ids)
    const card = outline.find(card => card.id === ids[0])!
    const generated = draft(card, card.id === outline[0].id ? '甲：“请开门。”' : '乙：“进来。”')
    generated.assetIds = ['deleted-material']
    generated.shots[0].action += '@待补充的茶壶 放在门边。'
    return { production, cards: [generated] }
  }, { batchSize: 1 })
  assert.deepEqual(received, outline.map(card => [card.id]))
  assert.equal(result.attempts, 2)
  assert.equal(result.cards.length, 2)
  for (const code of ['DIALOGUE_CHANGED', 'ASSET_UNKNOWN', 'ASSET_MENTION_UNKNOWN'])
    assert.ok(result.warnings.some(issue => issue.code === code), code)
})

test('an OS difference is returned as a review hint after a single generation', async () => {
  const card = plan(4)
  let calls = 0
  const result = await generateScriptVideoCards({ script: '甲(OS)：“开门。”', assets: [], outline: [card] }, async request => {
    calls++
    assert.equal(request.mode, 'episode')
    return { production, cards: [draft(card, '甲：“开门。”')] }
  })
  assert.equal(calls, 1)
  assert.ok(result.warnings.some(issue => issue.code === 'DIALOGUE_INNER_OS'))
})

test('long outlines and unresolved assets return hints without another planning call', async () => {
  let calls = 0
  const result = await generateScriptVideoOutline({ script: '两人在门前交谈。', assets: [] }, async () => {
    calls++
    return { cards: Array.from({ length: 5 }, (_, index) => ({ ...plan(30, index), assetIds: ['missing'] })) }
  })
  assert.equal(calls, 1)
  assert.equal(result.cards.length, 5)
  assert.ok(result.warnings.some(issue => issue.code === 'ASSET_UNKNOWN'))
  assert.ok(result.warnings.some(issue => issue.code === 'OUTLINE_EXTENSION'))
})
