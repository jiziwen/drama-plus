import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildScriptVideoDelivery, type ScriptVideoLightingRange } from '../src/services/script-video-delivery.js'
import { getScriptVideoStylePreset, scriptVideoPromptStylePrefix } from '../src/services/script-video-style.js'

const frame = '/static/videos/court-lighting.jpg'
const tail = { previousCardId: 'two', previousTaskId: 17, imageUrl: '/static/videos/tail.jpg', mode: 'reference' as const }
const options = { provider: 'aicost', model: 'seedance2.5-ae-480p' }
const card = { duration: 5, shots: [{ duration: 2 }, { duration: 2 }, { duration: 1 }], assetIds: ['yard', 'girl'],
  prompt: [
    '全段 5 秒', '场景：@北院', '镜头 01（0–2秒）', '画面与动作：@云袖在院内。',
    '对白／音效：云袖：“这盏灯明亮通透。”', '镜头 02（2–4秒）', '画面与动作：@云袖低头。',
    '镜头 03（4–5秒）', '画面与动作：切到殿内。',
  ].join('\n') }
const assets = [
  { id: 'girl', name: '云袖', kind: 'character', image: '/static/uploads/1.jpg', voiceAudio: { name: '云袖', url: '/static/uploads/1.mp3' } },
  { id: 'yard', name: '北院', kind: 'scene', image: '/static/uploads/2.jpg' },
]
const ranges: ScriptVideoLightingRange[] = [
  { startShot: 1, endShot: 2, sceneName: '北院', imageUrl: frame, lighting: '巳时，人物站在廊下。' },
  { startShot: 3, endShot: 3, sceneName: '大殿', transitionIn: true, lighting: '侧窗天光。' },
]

test('同场换机位把光线图作为额外的普通图，给转场精确划定范围', () => {
  const { prompt, images, voices, openingFrame, lightingImages, lightingRanges } = buildScriptVideoDelivery(card, assets, { ...options, lightingRanges: ranges })
  assert.equal(images.length, 2)
  assert.equal(voices.length, 1)
  assert.equal(openingFrame, undefined)
  assert.deepEqual(lightingImages, [frame])
  assert.deepEqual(lightingRanges, ranges)
  assert.match(prompt, /镜头1至2「北院」[^\n]+@图片3参考同场人物受光/u)
  assert.match(prompt, /镜头3「大殿」，从镜头3切入该场的画面起：侧窗天光/u)
  assert.doesNotMatch(prompt, /作为本段首帧/u)
})

test('延续尾帧和音色占用额度，剩余位置按镜头顺序分配，重复使用同一帧只传一次', () => {
  const extra = [
    { ...ranges[0], endShot: 1 },
    { ...ranges[0], startShot: 2, endShot: 2 },
    { ...ranges[1], imageUrl: '/static/videos/second.jpg' },
  ]
  const built = buildScriptVideoDelivery(card, assets, { ...options, continuation: tail, lightingRanges: extra,
    referenceLimits: { maxReferences: 5, maxTotalReferences: 5 } })
  assert.deepEqual(built.lightingImages, [frame])
  assert.equal(built.openingFrame?.imageIndex, 3)
  assert.equal(built.lightingRanges[2].imageUrl, undefined)
  assert.match(built.prompt, /以@图片3作为本段首帧/u)
  assert.equal(built.prompt.match(/@图片4参考同场/g)?.length, 2)
  assert.doesNotMatch(built.prompt, /@图片5/u)
  assert.match(built.prompt, /镜头3「大殿」[^\n]+侧窗天光/u)

  const reused = buildScriptVideoDelivery(card, assets, { ...options, continuation: tail,
    lightingRanges: [{ ...ranges[0], imageUrl: tail.imageUrl }], referenceLimits: { maxReferences: 3, maxTotalReferences: 4 } })
  assert.deepEqual(reused.lightingImages, [])
  assert.equal(reused.lightingRanges[0].imageUrl, tail.imageUrl)
  assert.match(reused.prompt, /@图片3参考同场人物受光/u)
})

test('只消解提交预设中的矛盾影调，清晰度/声音、未冲突的场景细节和角色原话保留', () => {
  const stylePreset = getScriptVideoStylePreset('cool')!
  const before = buildScriptVideoDelivery(card, assets, { ...options, stylePreset }).prompt
  assert.ok(before.startsWith(scriptVideoPromptStylePrefix(stylePreset)))
  const styled = buildScriptVideoDelivery(card, assets, { ...options, stylePreset, lightingRanges: ranges }).prompt
  assert.doesNotMatch(styled, /曝光充足偏高|高饱和自然|色调倾向暖色调/u)
  assert.match(styled, /低调布光/u)
  assert.match(styled, /蓝灰低饱和调色/u)
  assert.match(styled, /画面清晰锐利/u)
  assert.match(styled, /禁止生成背景音乐/u)
  assert.match(styled, /这盏灯明亮通透。/u)
  assert.equal(card.prompt.includes('这盏灯明亮通透。'), true)
  const custom = { id: 'custom' as const, name: '院落', prefix: '色调倾向暖色调，华服暗红色。门廊灯笼高饱和自然。' }
  const neutral = buildScriptVideoDelivery(card, assets, { ...options, stylePreset: custom, lightingRanges: ranges }).prompt
  assert.ok(neutral.startsWith(custom.prefix))
  const soft = buildScriptVideoDelivery(card, assets, { ...options, stylePreset,
    lightingRanges: [{ ...ranges[0], lighting: '廊下漫射光，避免高饱和' }] }).prompt
  assert.doesNotMatch(soft, /高反差硬光|硬光质感/u)
  assert.match(soft, /蓝灰低饱和调色/u)
})
