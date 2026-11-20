import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCardPrompt, type PreviewAsset, type PreviewCard } from '../app/utils/scriptVideoPreview'
import { createPreviewCards, seedAssets, seedScript } from './fixtures/scriptVideoCards'
import { inspectPreviewCardAssets, validatePreviewCards } from '../app/utils/scriptVideoPreviewValidation'

function sampleCards() {
  return createPreviewCards(seedScript, seedAssets, true)
}

function errors(cards: PreviewCard[], assets: PreviewAsset[]) {
  const result = validatePreviewCards(cards, assets)
  assert.equal(result.ok, false, '预期阻止无效分镜')
  return result.issues.filter(issue => issue.level === 'ERROR').map(issue => issue.code)
}

function warnings(cards: PreviewCard[], assets: PreviewAsset[]) {
  const result = validatePreviewCards(cards, assets)
  assert.equal(result.ok, true, '素材与内容提醒不应阻止进入分镜修改')
  assert.deepEqual(result.issues, [])
  return result.warnings.map(issue => issue.code)
}

test('完整示例按四段逐镜核对，正式分镜可在 18 秒收束', () => {
  const result = validatePreviewCards(sampleCards(), seedAssets)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.equal(result.cardCount, 4)
  assert.deepEqual(result.segments.map(segment => segment.duration), [30, 30, 30, 18])
})

test('核对结构中的逐镜合计，提示词文案时长不触发自动阻断', () => {
  const card = sampleCards()[0]!
  const editedShots = card.shots.map((shot, i) => i === 0 ? { ...shot, duration: shot.duration - 1 } : shot)
  assert.ok(errors([{ ...card, shots: editedShots }], seedAssets).includes('DUR009'))
  const editedPrompt = card.prompt.replace('总时长：30秒', '总时长：12.5秒')
  assert.equal(validatePreviewCards([{ ...card, prompt: editedPrompt }], seedAssets).ok, true)
  assert.ok(validatePreviewCards([{ ...card, prompt: editedPrompt }], seedAssets).warnings.some(issue => issue.code === 'PROMPT_DURATION'))
  const natural = { ...card, opening: '', ending: '', scene: '', characters: '', independentGeneration: '',
    prompt: '先推进再切特写。\n镜头 01（2–40秒）\n对白／音效：甲：“不要说出（微顿）两个字。”' }
  const checked = validatePreviewCards([natural], seedAssets)
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.issues, [])
  assert.ok(checked.warnings.some(issue => issue.code === 'PROMPT_TIMELINE'))
  assert.ok(checked.warnings.some(issue => issue.code === 'FORMAL_METADATA_MISSING'))
})

test('不存在的名称、未绑定的素材和缺少配图只提示，可进入分镜修改', () => {
  const card = sampleCards()[0]!
  const lead = seedAssets.find(asset => asset.id === 'emperor')!
  assert.ok(warnings([{ ...card, prompt: card.prompt + '\n@未入库的茶壶。' }], seedAssets).includes('UNKNOWN_ASSET'))
  assert.ok(warnings([{ ...card, assetIds: card.assetIds.filter(id => id !== lead.id) }], seedAssets).includes('UNBOUND_ASSET'))
  assert.ok(warnings([card], seedAssets.map(asset => asset.id === lead.id ? { ...asset, image: '' } : asset)).includes('ASSET_GAP'))
  const unused = { ...card, assetIds: [...card.assetIds, 'deleted-file'] }
  assert.ok(warnings([unused], seedAssets).includes('UNKNOWN_ASSET_ID'))
  assert.ok(inspectPreviewCardAssets({ ...unused, prompt: '全段 30 秒\n单独使用绑定参考图。' }, seedAssets)
    .warnings.some(issue => issue.code === 'UNKNOWN_ASSET_ID'))
})

test('分镜校验接受带空格、逗号、括号和斜杠的完整资产名称', () => {
  const assets: PreviewAsset[] = [{
    id: 'new', kind: 'prop', name: '道具/圣杯 Silver Cup (broken, 2)', image: 'blob:preview',
  }]
  const card: PreviewCard = {
    ...sampleCards()[0]!, title: '银杯特写', summary: '酒杯落上桌面。', duration: 4, assetIds: ['new'],
    shots: [{ id: 'cup-shot', duration: 4, camera: '俯拍', action: '道具/圣杯 Silver Cup (broken, 2) 滚落桌边。', dialogue: '' }],
  }
  card.prompt = buildCardPrompt(card, assets)
  assert.ok(card.prompt.includes('@道具/圣杯 Silver Cup (broken, 2)'))
  const result = validatePreviewCards([card], assets)
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('缺失造型的 @ 引用提示修正，即使更短的角色名已绑定', () => {
  const assets: PreviewAsset[] = ['侍卫', '侍卫长'].map((name, i) => ({ id: String(i), name, kind: 'character', image: 'blob:preview' }))
  const card: PreviewCard = {
    ...sampleCards()[0]!, assetIds: ['0', '1'], prompt: '图1 = @侍卫，图2 = @侍卫长\n全段 30 秒\n@侍卫长_礼服 出门。',
  }
  assert.ok(warnings([card], assets).includes('UNKNOWN_ASSET'))
})

test('整集预检只要求当前画面和实际说话者用到的资产', () => {
  const card = sampleCards()[0]!
  const spare = { id: 'briefing-room', kind: 'scene', name: '议事厅', image: 'blob:preview' } as const
  const assets = [...seedAssets, spare]
  const protectedText = [
    '风格色板 @未入库色卡',
    '独立生成：众人提议前往@议事厅。',
    '对白／音效：旁白：“我看见招牌写着 @未入库称号。”',
    '→衔接至视频编号02：切进@未入库后殿。',
  ]
  card.prompt = [protectedText[0], card.prompt, ...protectedText.slice(1)].join('\n')
  const context = { stylePreset: { id: 'custom' as const, name: '自定义', prefix: protectedText[0]! } }
  const scoped = inspectPreviewCardAssets(card, assets, context)
  assert.ok(!scoped.assetIds.includes(spare.id))
  assert.equal(scoped.mentions.find(hit => hit.id === spare.id)?.usage, 'context')
  assert.deepEqual(scoped.issues, [])
  assert.equal(validatePreviewCards([card], assets, context).ok, true)
  const legacyCard = { ...card, assetIds: [...card.assetIds, spare.id] }
  const missingSpare = [...seedAssets, { ...spare, image: '' }]
  assert.deepEqual(inspectPreviewCardAssets(legacyCard, missingSpare, context).issues, [])
  card.prompt += '\n镜头 09\n画面与动作：推门进入@议事厅。'
  assert.ok(inspectPreviewCardAssets(card, assets, context).warnings.some(issue => issue.code === 'UNBOUND_ASSET'))
  legacyCard.prompt = card.prompt
  assert.ok(inspectPreviewCardAssets(legacyCard, missingSpare, context).warnings.some(issue => issue.code === 'ASSET_GAP'))
})

test('自然语言与明确 @ 引用的场景歧义均提示，供进入分镜后修正', () => {
  const card = sampleCards()[0]!
  const candidates: PreviewAsset[] = [
    { id: 'palace', kind: 'scene', name: '皇宫-御书房', image: 'blob:palace' },
    { id: 'annex', kind: 'scene', name: '别院-御书房', image: 'blob:annex' },
  ]
  const assets = [...seedAssets, ...candidates]
  card.prompt += '\n对白／音效：旁白：“刚才有人在御书房门外等你。”'
  assert.deepEqual(inspectPreviewCardAssets(card, assets).issues, [])
  card.prompt += '\n镜头 09\n画面与动作：推门进入御书房。'
  assert.equal(validatePreviewCards([card], assets).ok, true)
  assert.ok(validatePreviewCards([card], assets).warnings.some(issue => issue.code === 'AMBIGUOUS_ASSET'))
  card.prompt += '\n画面与动作：推门进入@御书房。'
  const issue = inspectPreviewCardAssets(card, assets).warnings.find(item => item.code === 'AMBIGUOUS_ASSET')
  assert.match(issue?.message || '', /镜头 09.*御书房.*皇宫-御书房、别院-御书房/u)
})

test('镜头素材引用的类型、绑定和配图问题均作为可修改的提醒', () => {
  const card = { ...sampleCards()[0]!, assetIds: [] as string[], prompt: '镜头 01\n画面与动作：小皇帝站在庭院。' }
  const lead = seedAssets.find(asset => asset.id === 'emperor')!
  assert.equal(validatePreviewCards([card], seedAssets.map(asset => ({ ...asset, image: '' }))).ok, true)
  const declared = { ...card, shots: card.shots.map((shot, i) => i ? shot : { ...shot, visualAssetIds: [lead.id] }) }
  assert.ok(warnings([declared], seedAssets).includes('UNBOUND_ASSET'))
  const bound = { ...declared, assetIds: [lead.id] }
  assert.ok(warnings([bound], seedAssets.map(asset => ({ ...asset, image: '' }))).includes('ASSET_GAP'))
  const scene = seedAssets.find(asset => asset.kind === 'scene')!
  const wrongKind = { ...card, assetIds: [scene.id], shots: card.shots.map((shot, i) => i ? shot : { ...shot, speakerAssetIds: [scene.id] }) }
  assert.ok(warnings([wrongKind], seedAssets).includes('SPEAKER_ASSET_KIND'))
})

test('空提示词、无效数值和重复片段仍然阻断，重复素材只提示', () => {
  const card = sampleCards()[0]!
  assert.ok(errors([{ ...card, prompt: ' ' }], seedAssets).includes('EMPTY_PROMPT'))
  assert.ok(errors([{ ...card, duration: Number.NaN }], seedAssets).includes('DUR008'))
  assert.ok(errors([{ ...card, shots: [] }], seedAssets).includes('DUR007'))
  assert.ok(errors([card, card], seedAssets).includes('CARD_ID_DUPLICATE'))
  assert.ok(warnings([{ ...card, assetIds: [...card.assetIds, card.assetIds[0]!] }], seedAssets).includes('DUPLICATE_ASSET'))
  const decimals = { ...card, duration: 0.6, shots: card.shots.slice(0, 3).map((shot, i) => ({ ...shot, duration: [0.1, 0.2, 0.3][i]! })) }
  assert.equal(validatePreviewCards([decimals], seedAssets).ok, true)
})

test('传入确认剧本时，改词与心声变化可提示但仍能进入分镜修改', () => {
  const card = { ...sampleCards()[0]!, assetIds: [], prompt: '镜头 01\n对白／音效：甲：“快走。”',
    shots: [{ id: 'warning-shot', duration: 30, camera: '近景', action: '甲站在原地。', dialogue: '甲：“快走。”' }] }
  const result = validatePreviewCards([card], [], { script: '甲（OS）：“不要走。”', scope: 'episode' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
  assert.ok(result.warnings.some(issue => issue.code === 'DIALOGUE_CHANGED'))
})

test('无法读写的镜头或引用数组格式仍会阻止操作，并给出错误', () => {
  const card = sampleCards()[0]!
  const invalidField = { ...card, shots: [{ ...card.shots[0]!, duration: 30, action: null }] } as unknown as PreviewCard
  assert.ok(errors([invalidField], seedAssets).includes('SHOT_FORMAT'))
  const invalidReferences = { ...card, openingAssetIds: 'emperor' } as unknown as PreviewCard
  assert.ok(errors([invalidReferences], seedAssets).includes('ASSET_BINDINGS_INVALID'))
})

test('镜头标识须非空且卡内唯一，画面与机位须非空，空白音效栏仍可修改', () => {
  const card = sampleCards()[0]!
  const shot = { ...card.shots[0]!, duration: 30 }
  for (const id of ['', '  '])
    assert.ok(errors([{ ...card, shots: [{ ...shot, id }] }], seedAssets).includes('SHOT_ID_DUPLICATE'))
  const duplicate = [{ ...shot, duration: 15 }, { ...shot, duration: 15 }]
  assert.ok(errors([{ ...card, shots: duplicate }], seedAssets).includes('SHOT_ID_DUPLICATE'))
  for (const field of ['camera', 'action'] as const)
    assert.ok(errors([{ ...card, shots: [{ ...shot, [field]: ' \n ' }] }], seedAssets).includes('SHOT_FORMAT'))
  for (const dialogue of ['', ' \n '])
    assert.equal(validatePreviewCards([{ ...card, shots: [{ ...shot, dialogue }] }], seedAssets).ok, true)
  const absentDialogue = { ...card, shots: [{ ...shot, dialogue: undefined }] } as unknown as PreviewCard
  assert.ok(errors([absentDialogue], seedAssets).includes('SHOT_FORMAT'))
})

test('精确时长及基础字段共享后端执行规则，避免前端放行后才因结构被拦', () => {
  const card = sampleCards()[0]!
  const near = { ...card, duration: 0.6, shots: [{ ...card.shots[0]!, duration: 0.6000000001 }] }
  assert.ok(errors([near], seedAssets).includes('DUR009'))
  assert.ok(errors([{ ...card, title: ' ' }], seedAssets).includes('CARD_FORMAT'))
  const malformedCatalog = seedAssets.map(asset => ({ ...asset, name: '' }))
  assert.ok(errors([card], malformedCatalog).includes('ASSET_CATALOG_FORMAT'))
})
