import assert from 'node:assert/strict'
import test from 'node:test'
import { generateScriptVideoCards } from '../src/services/script-video-ai.js'
import { renderScriptVideoPrompt } from '../src/services/script-video-format.js'
import {
  assertScriptVideoCards,
  getScriptVideoContentWarnings,
  sourceDialogue,
  type ScriptVideoCard,
} from '../src/services/script-video-types.js'

const script = '顾凌天(OS)：“千万别回头。”；顾凌天【低沉】：“门开了。”\n系统面板(OV)：“验证通过。”'
const dialogue = '顾凌天（内心 OS，角色闭口，嘴唇不动，不对口型）：“千万别回头。”；顾凌天【低沉】：“门开了。”；系统面板(OV)：“验证通过。”'
const assets: Array<{ id: string; name: string; kind: string }> = []

function card(spoken = dialogue): ScriptVideoCard {
  const draft: ScriptVideoCard = {
    id: 'segment', title: '第1段', duration: 8, summary: '顾凌天等门打开。', combat: false,
    assetIds: [], prompt: '', status: 'draft', version: 1,
    opening: '顾凌天在门边。', scene: '宫殿外。', characters: '顾凌天靠近宫门。',
    independentGeneration: '拍下宫门缓缓打开。', ending: '宫门全开。',
    shots: [{ id: '1', duration: 8, camera: '固定近景。', action: '顾凌天站在宫门前。', dialogue: spoken }],
  }
  return { ...draft, prompt: renderScriptVideoPrompt(draft, assets) }
}

test('OS, spoken dialogue and external VO in one field keep their own voice modes', () => {
  assert.deepEqual(sourceDialogue(script, true).map(line => line.voiceMode), ['心声', undefined, '画外音'])
  assert.ok(getScriptVideoContentWarnings({ script, assets, cards: [card(dialogue.replace('（内心 OS，角色闭口，嘴唇不动，不对口型）', ''))] }).some(issue => issue.code === 'DIALOGUE_INNER_OS'))
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets, cards: [card()] }))
  assert.doesNotThrow(() => assertScriptVideoCards({
    script, assets, cards: [card(dialogue.replace('（内心 OS，角色闭口，嘴唇不动，不对口型）', ''))],
  }))
  assert.doesNotThrow(() => assertScriptVideoCards({
    script, assets, cards: [card(dialogue.replace('【低沉】', '(OS)【低沉】'))],
  }))
})

test('bare inner labels identify the character without becoming part of the name', () => {
  const draft = '顾凌天内心 OS：“别回头。”\n顾凌天 OS：“门开了。”'
  assert.deepEqual(sourceDialogue(draft, true), [
    { speaker: '顾凌天', text: '别回头。', voiceMode: '心声' },
    { speaker: '顾凌天', text: '门开了。', voiceMode: '心声' },
  ])
})

test('a single card can begin at the matching occurrence of repeated words', () => {
  const repeated = '顾凌天：“门开了。”\n顾凌天(OS)：“门开了。”'
  assert.doesNotThrow(() => assertScriptVideoCards({
    script: repeated, assets, cards: [card('顾凌天(OS)：“门开了。”')], scope: 'card',
  }))
})

test('generation keeps voice-mode instructions without adding a semantic repair gate', async () => {
  const bad = card(dialogue.replace('（内心 OS，角色闭口，嘴唇不动，不对口型）', ''))
  const outline = [{ ...bad, shots: [], prompt: '' }]
  const production = {
    coreRhythm: '等门打开。', visualSpecs: '自然光。', shotRhythm: '固定近景。',
    dialogueRules: '逐字保留对白。', interfaceRules: '以声音传达提示。', costumeRules: '沿用既定造型。',
    sceneAndCamera: '宫殿外。', soundAndEditing: '声音衔接自然。', continuityReview: '宫门缓缓打开。',
    characters: [{ name: '顾凌天', appearance: '站在门前。', voice: '沉稳。' }],
  }
  const modes: Array<string | undefined> = []
  const result = await generateScriptVideoCards({ script, assets, outline }, async request => {
    modes.push(request.mode)
    if (request.mode === 'episode') return { production, cards: [bad] }
    assert.fail('semantic voice-mode differences must not spend an automatic repair')
  })
  assert.deepEqual(modes, ['episode'])
  assert.equal(result.cards[0].shots[0].dialogue, bad.shots[0].dialogue)
})
