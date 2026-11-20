import assert from 'node:assert/strict'
import test from 'node:test'
import { generateScriptVideoCards } from '../src/services/script-video-ai.js'
import { renderScriptVideoCardReferences, scriptVideoStoryboardBody } from '../src/services/script-video-format.js'
import { assertScriptVideoCards, getScriptVideoContentWarnings, formalFields, type ScriptVideoCard } from '../src/services/script-video-types.js'

const courtyard = { id: 'courtyard', name: '京城皇宫-后宫偏殿院落', kind: 'scene' }
const hall = { id: 'hall', name: '京城皇宫-后宫偏殿正厅', kind: 'scene' }
const assets = [courtyard, hall]
const script = '**场次**：51-01\n**场景**：' + courtyard.name + '\n△画面：顾凌天站在院落里望向南侧院门。'
const jumpsToHall = '镜头从院落切至' + hall.name + '。顾凌天站在地面上。'
const lookingFromCourtyard = '顾凌天凝望院外，仍站在院落中。'

function card(
  action: string,
  scene = '场号51-01｜' + courtyard.name + '（唯一空间）｜日间巳时',
): ScriptVideoCard {
  const draft: ScriptVideoCard = {
    id: 'segment', title: '第51集 第5段（尾段）', duration: 8, summary: '随顾凌天转身。', combat: false,
    assetIds: [courtyard.id], scene, prompt: '', status: 'draft', version: 1,
    opening: '顾凌天在院中站定。', characters: '顾凌天站在南侧院门前。',
    independentGeneration: '拍下顾凌天望向院门的动作。', ending: '顾凌天停下脚步。',
    shots: [
      { id: '1', duration: 4, camera: '中景／固定', action: '顾凌天望向南侧院门外方向。', dialogue: '无对白。' },
      { id: '2', duration: 4, camera: '中近景／固定', action, dialogue: '无对白。' },
    ],
  }
  const rendered = renderScriptVideoCardReferences(draft, assets, undefined, undefined, true)
  return { ...draft, prompt: rendered.prompt, assetIds: rendered.usedIds }
}

test('formal cards render the previous recap separately and preserve optional material IDs', () => {
  const draft = card(lookingFromCourtyard)
  const recap = '上一镜拍到旧场地。\n末帧停在' + hall.name + '。'
  const parsed = formalFields.parse({
    ...draft,
    openingRecap: recap,
    openingAssetIds: [courtyard.id],
    shots: [{ ...draft.shots[0], visualAssetIds: [courtyard.id], speakerAssetIds: [] }, draft.shots[1]],
  })
  assert.deepEqual(parsed.openingAssetIds, [courtyard.id])
  assert.deepEqual(parsed.shots[0].visualAssetIds, [courtyard.id])
  assert.deepEqual(parsed.shots[0].speakerAssetIds, [])
  assert.ok(scriptVideoStoryboardBody(parsed).startsWith('前镜回顾：' + recap + '\n←承上：' + draft.opening))
  assert.equal(formalFields.parse(draft).openingRecap, undefined)
  assert.ok(scriptVideoStoryboardBody(draft).startsWith('←承上：' + draft.opening))
  const rendered = renderScriptVideoCardReferences({ ...draft, openingRecap: recap }, assets, undefined, undefined, true)
  assert.ok(rendered.prompt.includes(recap))
  assert.ok(!rendered.prompt.includes('@' + hall.name))
  assert.deepEqual(rendered.usedIds, [courtyard.id])
  assert.deepEqual(rendered.contextAssetIds, [hall.id])
})

test('draft opening, shot and speaker reference problems remain nonblocking warnings', () => {
  const draft = card(lookingFromCourtyard)
  draft.openingAssetIds = ['unknown']
  draft.shots[0].visualAssetIds = [hall.id]
  draft.shots[1].speakerAssetIds = [courtyard.id]
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets, cards: [draft] }))
  assert.deepEqual(getScriptVideoContentWarnings({ script, assets, cards: [draft] }).map(issue => issue.code).filter(code => code.startsWith('ASSET_')), ['ASSET_UNKNOWN', 'ASSET_UNBOUND', 'ASSET_SPEAKER_KIND'])
})

test('execution checks leave source-scene consistency to the supplied generation rules', () => {
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets, cards: [card(jumpsToHall)] }))
  assert.ok(getScriptVideoContentWarnings({ script, assets, cards: [card(jumpsToHall)] }).some(issue => issue.code === 'SCENE_CONTINUITY'))
})

test('execution checks accept a prompt-only scene change with valid references', () => {
  const draft = card(lookingFromCourtyard)
  const edited = card(jumpsToHall)
  draft.prompt = edited.prompt.replace('画面与动作：镜头从院落', '画面与动作：\n镜头从院落')
  draft.assetIds = edited.assetIds
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets, cards: [draft] }))
})

test('generation does not add a semantic scene-continuity repair gate', async () => {
  const initial = card(jumpsToHall)
  const outline = [{ ...initial, assetIds: [courtyard.id], shots: [], prompt: '' }]
  const production = {
    coreRhythm: '先停步，后循视线接下一个动作。',
    visualSpecs: '自然光。', shotRhythm: '中景接中近景。', dialogueRules: '本段无对白。',
    interfaceRules: '本段没有界面。', costumeRules: '沿用出场造型。',
    sceneAndCamera: '先在院门前。', soundAndEditing: '保留脚步声。',
    continuityReview: '人物连续转身。', characters: [],
  }
  const modes: string[] = []
  const repaired = await generateScriptVideoCards({ script, assets, outline }, async request => {
    modes.push(request.mode!)
    if (request.mode === 'episode') return { production, cards: [initial] }
    assert.fail('a prose scene change must not spend an automatic repair')
  })
  assert.deepEqual(modes, ['episode'])
  assert.equal(repaired.cards[0].shots[0].action, initial.shots[0].action)
  assert.equal(repaired.cards[0].shots[1].action, jumpsToHall)
  assert.deepEqual(repaired.cards[0].assetIds, initial.assetIds)

  const authored = script + '\n**场次**：51-02\n**场景**：' + hall.name + '\n△转场：【推门转场】顾凌天穿过院门走进' + hall.name + '。'
  const existing = card(jumpsToHall, courtyard.name + '→' + hall.name + '｜两处按剧本转场')
  const accepted = await generateScriptVideoCards({ script: authored, assets, outline }, async request => {
    assert.equal(request.mode, 'episode')
    return { production, cards: [existing] }
  })
  assert.equal(accepted.attempts, 1)
  assert.equal(accepted.cards[0].shots[1].action, jumpsToHall)
})

test('an exterior view from the courtyard, an explicit exclusion and a scripted cut remain valid', () => {
  const looking = card('顾凌天凝望' + hall.name + '的屋檐，脚仍停在院落中。')
  const negation = card('顾凌天停在原地。固定机位，禁止切至' + hall.name + '。')
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets, scope: 'card', cards: [looking] }))
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets, scope: 'card', cards: [negation] }))
  assert.doesNotThrow(() => assertScriptVideoCards({
    script: script + '\n**场次**：51-02\n**场景**：' + hall.name + '\n△转场：顾凌天穿过院门走进' + hall.name + '。',
    assets, scope: 'card', cards: [card(jumpsToHall)],
  }))
  assert.doesNotThrow(() => assertScriptVideoCards({
    script: script + '\n△转场：顾凌天穿过院门走进' + hall.name + '。',
    assets, scope: 'card', cards: [card(jumpsToHall)],
  }))
})
