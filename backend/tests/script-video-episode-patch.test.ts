import assert from 'node:assert/strict'
import test from 'node:test'
import { applyEpisodePatch, repairOutput } from '../src/services/script-video-episode-repair.js'
import type { ScriptVideoCard, ScriptVideoProduction } from '../src/services/script-video-types.js'

const production: ScriptVideoProduction = {
  coreRhythm: '在门口停住。',
  visualSpecs: '清晨自然光',
  shotRhythm: '使用固定机位',
  dialogueRules: '本段无对白',
  interfaceRules: '没有界面',
  costumeRules: '沿用原有服装',
  sceneAndCamera: '面对院门',
  soundAndEditing: '保留脚步声',
  continuityReview: '保持行走方向',
  characters: [{ name: '阿明', appearance: '穿蓝衣', voice: '无台词' }],
}
const card: ScriptVideoCard = {
  id: 'courtyard-1',
  title: '到门前',
  summary: '阿明朝院门走过去。',
  duration: 5,
  assetIds: [],
  combat: false,
  shots: [],
  prompt: '',
  status: 'draft',
  version: 1,
}
const characters = '阿明站在院门前。'
const candidate = { cards: [card], production }
const cardIssue = { code: 'OUTPUT_FORMAT', message: '缺少人物字段。', cardId: card.id }
const replacementProduction = { ...production, visualSpecs: '午后自然光' }
const patch = repairOutput.parse({
  production: replacementProduction,
  patches: [{ id: card.id, fields: { characters } }],
})

test('card repairs fill missing fields while preserving validated production outside the repair scope', () => {
  const result = applyEpisodePatch(candidate, [card], [cardIssue], patch)
  assert.deepEqual(result.cards, [{ ...card, characters }])
  assert.equal(result.production, candidate.production)
  assert.equal(card.characters, undefined)
})

test('repair can replace production when the audit identifies an episode-wide issue', () => {
  const result = applyEpisodePatch(candidate, [card], [
    cardIssue, { code: 'OUTPUT_FORMAT', message: '制作规格需要更新。' },
  ], patch)
  assert.deepEqual(result.production, replacementProduction)
  assert.deepEqual(result.cards, [{ ...card, characters }])
})
