import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertScriptVideoCards,
  assertScriptVideoFormal,
  getScriptVideoOutlineDurationIssues,
  getScriptVideoContentWarnings,
  ScriptVideoAIError,
  type ScriptVideoCard,
  type ScriptVideoProduction,
} from '../src/services/script-video-types.js'

const assets = [
  { id: 'scene', name: '院落', kind: 'scene' },
  { id: 'person', name: '甲', kind: 'character' },
  { id: 'other', name: '乙', kind: 'character' },
]
const production: ScriptVideoProduction = {
  coreRhythm: '门前交谈。', visualSpecs: '自然光。', shotRhythm: '固定镜头。',
  dialogueRules: '沿用剧本。', interfaceRules: '无界面。', costumeRules: '既定造型。',
  sceneAndCamera: '院内。', soundAndEditing: '自然声音。', continuityReview: '同场连续。', characters: [],
}
function card(): ScriptVideoCard {
  return {
    id: 'card', title: '院门', duration: 0.3, summary: '甲站在门前。', assetIds: ['scene', 'person'], combat: false,
    prompt: '画面与动作：@院落 中，@甲 站在门前。', status: 'draft', version: 1,
    opening: '院门紧闭。', openingAssetIds: ['scene'], scene: '院落。', characters: '甲在门前。',
    independentGeneration: '拍下门前人物。', ending: '人物站定。',
    shots: [
      { id: 'one', duration: 0.1, camera: '固定。', action: '甲站定。', dialogue: '甲：“开门。”', visualAssetIds: ['scene'], speakerAssetIds: ['person'] },
      { id: 'two', duration: 0.2, camera: '固定。', action: '门打开。', dialogue: '门轴响。', visualAssetIds: ['scene'], speakerAssetIds: [] },
    ],
  }
}
const input = (cards = [card()]) => ({ script: '甲：“开门。”', assets, cards, production })
const hasIssue = (code: string) => (error: unknown) =>
  error instanceof ScriptVideoAIError && error.issues.some(issue => issue.code === code)

test('hard validation accepts exact decimal sums and scientific-notation seconds', () => {
  assert.doesNotThrow(() => assertScriptVideoFormal(input()))
  const tiny = card()
  tiny.duration = 3e-7
  tiny.shots[0].duration = 1e-7
  tiny.shots[1].duration = 2e-7
  assert.doesNotThrow(() => assertScriptVideoCards(input([tiny])))
  tiny.shots[1].duration = 3e-7
  assert.throws(() => assertScriptVideoCards(input([tiny])), hasIssue('DUR009'))
})

test('hard validation rejects malformed cards, missing IDs and invalid numeric durations', () => {
  for (const mutate of [
    (draft: any) => { draft.shots = [] },
    (draft: any) => { draft.prompt = ' ' },
    (draft: any) => { draft.shots[0].id = '' },
    (draft: any) => { draft.shots[0].dialogue = undefined },
    (draft: any) => { draft.shots[0].visualAssetIds = 'scene' },
    ...[NaN, Infinity, -1, 0, 30.01].map(duration => (draft: any) => { draft.duration = duration }),
    ...[NaN, Infinity, -1, 0, 30.01].map(duration => (draft: any) => { draft.shots[0].duration = duration }),
  ]) {
    const draft = card()
    mutate(draft)
    assert.throws(() => assertScriptVideoCards(input([draft])), hasIssue('CARD_FORMAT'))
  }
})

test('card and shot IDs are unique in their execution scope', () => {
  assert.throws(() => assertScriptVideoCards(input([card(), card()])), hasIssue('CARD_ID_DUPLICATE'))
  const duplicate = card()
  duplicate.shots[1].id = duplicate.shots[0].id
  assert.throws(() => assertScriptVideoCards(input([duplicate])), hasIssue('SHOT_ID_DUPLICATE'))
  const duplicateCatalog = { ...input(), assets: [...assets, assets[0]] }
  assert.doesNotThrow(() => assertScriptVideoCards(duplicateCatalog))
  assert.ok(getScriptVideoContentWarnings(duplicateCatalog).some(issue => issue.code === 'ASSET_CATALOG_DUPLICATE'))
})

test('hard validation rejects an incorrect numeric shot sum', () => {
  const draft = card()
  draft.shots[1].duration = 0.19
  assert.throws(() => assertScriptVideoCards(input([draft])), hasIssue('DUR009'))
})

test('draft asset references produce actionable warnings without blocking editing', () => {
  const cases: Array<[string, (draft: ScriptVideoCard) => void]> = [
    ['ASSET_UNKNOWN', draft => { draft.assetIds.push('missing') }],
    ['ASSET_DUPLICATE', draft => { draft.assetIds.push('scene') }],
    ['ASSET_UNKNOWN', draft => { draft.openingAssetIds = ['missing'] }],
    ['ASSET_UNBOUND', draft => { draft.openingAssetIds = ['other'] }],
    ['ASSET_UNBOUND', draft => { draft.shots[0].visualAssetIds = ['other'] }],
    ['ASSET_UNKNOWN', draft => { draft.shots[0].speakerAssetIds = ['missing'] }],
    ['ASSET_SPEAKER_KIND', draft => { draft.shots[0].speakerAssetIds = ['scene'] }],
    ['ASSET_DUPLICATE', draft => { draft.shots[0].visualAssetIds = ['scene', 'scene'] }],
    ['ASSET_DUPLICATE', draft => { draft.shots[0].speakerAssetIds = ['person', 'person'] }],
    ['ASSET_UNKNOWN', draft => { draft.excludedAssetIds = ['missing'] }],
  ]
  for (const [code, mutate] of cases) {
    const draft = card()
    mutate(draft)
    assert.doesNotThrow(() => assertScriptVideoCards(input([draft])))
    assert.ok(getScriptVideoContentWarnings(input([draft])).some(issue => issue.code === code), code)
  }
})

test('deliberate prompt asset references warn while bare prose stays nonblocking', () => {
  const draft = card()
  draft.prompt = '画面与动作：@不存在的素材。'
  assert.doesNotThrow(() => assertScriptVideoCards(input([draft])))
  assert.ok(getScriptVideoContentWarnings(input([draft])).some(issue => issue.code === 'ASSET_MENTION_UNKNOWN'))
  draft.prompt = '画面与动作：@乙 站在门外。'
  assert.doesNotThrow(() => assertScriptVideoCards(input([draft])))
  assert.ok(getScriptVideoContentWarnings(input([draft])).some(issue => issue.code === 'ASSET_UNBOUND'))
  const variants = [
    { id: 'coat', name: '张浩_外套', kind: 'character' },
    { id: 'robe', name: '张浩_长袍', kind: 'character' },
  ]
  draft.prompt = '画面与动作：张浩望向院门。'
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input([draft]), assets: [...assets, ...variants] }))
  draft.prompt = '画面与动作：@张浩 望向院门。'
  const ambiguous = { ...input([draft]), assets: [...assets, ...variants] }
  assert.doesNotThrow(() => assertScriptVideoCards(ambiguous))
  assert.ok(getScriptVideoContentWarnings(ambiguous).some(issue => issue.code === 'ASSET_AMBIGUOUS'))
})

test('formal execution still requires its template and an explicitly synchronized prompt', () => {
  const missing = card()
  delete missing.ending
  assert.throws(() => assertScriptVideoFormal(input([missing])), hasIssue('FORMAL_METADATA_MISSING'))
  const stale = card()
  stale.promptNeedsSync = true
  assert.throws(() => assertScriptVideoFormal(input([stale])), hasIssue('PROMPT_STALE'))
  assert.throws(() => assertScriptVideoFormal({ ...input(), production: undefined }), hasIssue('PRODUCTION_MISSING'))
})

test('content, prompt timing prose and unused bindings cannot introduce extra automatic gates', () => {
  const draft = card()
  draft.assetIds.push('other')
  draft.scene = '另一个场景。'
  draft.prompt = '全段总时长：999秒。\n镜头 99（9–99秒）\n画面与动作：人物到了别处。\n对白／音效：乙(OS)：“这是改写的内容。”'
  draft.shots[0].dialogue = '乙(OS)：“这是改写的内容。”'
  assert.doesNotThrow(() => assertScriptVideoFormal(input([draft])))
})

test('outline timing enforces provider numeric limits without imposing a creative thirty-second policy', () => {
  assert.deepEqual(getScriptVideoOutlineDurationIssues([{ duration: 8 }, { duration: 12 }, { duration: 4.5 }]), [])
  for (const duration of [0, -1, NaN, Infinity, 30.01])
    assert.deepEqual(getScriptVideoOutlineDurationIssues([{ duration }]).map(issue => issue.code), ['OUTLINE_DURATION_RANGE'])
})
