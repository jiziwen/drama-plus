import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScriptVideoDelivery, getScriptVideoMaterialUse, type ScriptVideoDeliveryAsset, type ScriptVideoDeliveryCard } from '../src/services/script-video-delivery'

const assets: ScriptVideoDeliveryAsset[] = [
  { id: 'lead', name: '顾凌天_青布长衫', kind: 'character', image: '/lead.png', voiceMode: 'model' },
  { id: 'guard', name: '赵峰_微服便装', kind: 'character', image: '/guard.png' },
  { id: 'spoken', name: '王禄', kind: 'character', image: '/spoken.png' },
]
const card: ScriptVideoDeliveryCard = {
  duration: 5,
  assetIds: ['lead', 'guard'],
  openingAssetIds: [],
  shots: [{ duration: 5, visualAssetIds: ['lead'], speakerAssetIds: ['lead'], dialogue: '顾凌天：“王禄，过来。”' }],
  prompt: [
    '前镜回顾：赵峰站在门外。',
    '人物：顾凌天_青布长衫在门内，赵峰守在门外。',
    '独立生成：顾凌天听赵峰回报。',
    '镜头 01（0–5秒）',
    '画面与动作：顾凌天抬眼。',
    '对白／音效：顾凌天：“王禄，过来。”',
  ].join('\n'),
}

test('回顾和说明里的每处人物引用都使用实际附件编号，台词不插引用也不额外配音', () => {
  for (const options of [
    { provider: 'jimeng', model: 'jimeng-seedance-2.5' },
    { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' },
    { provider: 'volcengine', model: 'doubao-seedance-2-0-fast' },
    { provider: 'minimax', model: 'wf-minimax-h3' },
  ]) {
    const result = buildScriptVideoDelivery(card, assets, options)
    assert.deepEqual(new Set(result.images.map(asset => asset.id)), new Set(['lead', 'guard']))
    const index = result.imageBindings.find(binding => binding.assetId === 'guard')!.index
    const tag = options.provider === 'minimax' ? `<Picture ${index}>` : `@图片${index}`
    assert.ok(result.prompt.includes('前镜回顾：' + tag + '赵峰站在门外。'))
    assert.ok(result.prompt.includes('在门内，' + tag + '赵峰守在门外。'))
    assert.ok(result.prompt.includes('听' + tag + '赵峰回报。'))
    assert.ok(result.prompt.includes('王禄，过来。'))
    assert.doesNotMatch(result.prompt, /(?:@图片\d+|<Picture \d+>)王禄/u)
    assert.deepEqual(result.missingVoices, [])
    assert.deepEqual(result.voices, [])
    assert.deepEqual(new Set(getScriptVideoMaterialUse(card, assets, options).imageIds), new Set(['lead', 'guard']))
  }
})

test('旧自由提示词也提交回顾人物参考，且不把这些人物当成发声者', () => {
  const legacy = { ...card, shots: [], assetIds: ['guard'], prompt: '前镜回顾：赵峰已在门外。' }
  const result = buildScriptVideoDelivery(legacy, assets, { provider: 'volcengine', model: 'doubao-seedance-2-0-fast' })
  assert.deepEqual(result.images.map(asset => asset.id), ['guard'])
  assert.match(result.prompt, /前镜回顾：@图片1赵峰已在门外。/u)
  assert.deepEqual(result.missingVoices, [])
})

test('正式人物参考未绑定或缺图时不会静默漏传', () => {
  const explicit = { ...card, assetIds: ['lead'], prompt: card.prompt.replace('前镜回顾：赵峰', '前镜回顾：@赵峰_微服便装') }
  assert.throws(() => buildScriptVideoDelivery(explicit, assets), /赵峰_微服便装.*尚未绑定/u)
  assert.throws(() => buildScriptVideoDelivery(card, assets.map(asset => asset.id === 'guard' ? { ...asset, image: '' } : asset)), /赵峰_微服便装/u)
})

test('画外发声者也携带人物图，但仍保持画外声音语义', () => {
  const offscreen = {
    ...card,
    prompt: '镜头 01（0–5秒）\n画面与动作：顾凌天侧耳。\n对白／音效：赵峰（画外）：“门外有人。”',
    shots: [{ duration: 5, visualAssetIds: ['lead'], speakerAssetIds: ['guard'], dialogue: '赵峰（画外）：“门外有人。”' }],
  }
  const result = buildScriptVideoDelivery(offscreen, assets.map(asset => ({ ...asset, voiceMode: 'model' })),
    { provider: 'jimeng', model: 'jimeng-seedance-2.5' })
  assert.deepEqual(result.images.map(asset => asset.id), ['lead', 'guard'])
  assert.match(result.prompt, /赵峰_微服便装（画外声音来源，不安排出镜）/u)
  assert.match(result.prompt, /@图片2赵峰（画外）/u)
  assert.doesNotMatch(result.prompt, /赵峰[^\n]*保持对应参考图的造型/u)
  const inner = buildScriptVideoDelivery({ ...offscreen, prompt: offscreen.prompt.replace('（画外）', '（内心 OS）') },
    assets.map(asset => ({ ...asset, voiceMode: 'model' })), { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' })
  assert.match(inner.prompt, /对白／音效：@图片2赵峰\(OS\) ：“门外有人。”/u)
  assert.doesNotMatch(inner.prompt, /声音：|角色闭口|嘴唇不动|不对口型/u)
})

test('回顾中的同名人物多造型需要明确选择，不能无提示漏传参考', () => {
  const catalog = [...assets, { ...assets[1], id: 'uniform', name: '赵峰_官服', image: '/uniform.png' }]
  const ambiguous = { ...card, assetIds: [...card.assetIds, 'uniform'] }
  assert.throws(() => buildScriptVideoDelivery(ambiguous, catalog), /赵峰.*多个匹配/u)
  const spokenOnly = { ...ambiguous,
    prompt: '镜头 01（0–5秒）\n画面与动作：顾凌天抬眼。\n对白／音效：顾凌天：“赵峰，过来。”' }
  assert.doesNotThrow(() => buildScriptVideoDelivery(spokenOnly, catalog))
})
