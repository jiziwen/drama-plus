import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScriptVideoDelivery, getScriptVideoMissingVoices, type ScriptVideoDeliveryAsset } from '../src/services/script-video-delivery'

const audio = { url: '/static/uploads/reference.wav', name: '参考音频.wav' }
const assets: ScriptVideoDeliveryAsset[] = [
  { id: 'court', name: '阿宁_礼服', kind: 'character', image: '/static/uploads/court.png' },
  { id: 'daily', name: '阿宁_常服', kind: 'character', image: '/static/uploads/daily.png', voiceAudio: audio },
  { id: 'he', name: '小禾', kind: 'character', image: '/static/uploads/he.png' },
  { id: 'silence', name: '阿川', kind: 'character', image: '/static/uploads/chuan.png' },
]
const options = { cast: [{ name: '阿宁_礼服（宁宁）' }] }

function makeCard(dialogue: string) {
  return {
    assetIds: ['court', 'daily', 'he', 'silence'],
    duration: 10,
    shots: [{ duration: 10, dialogue }],
    prompt: `镜头 01（0–10秒）\n画面与动作：@阿川把写着“门还开着”的牌子挂好。\n对白／音效：${dialogue}`,
  }
}

test('默认关闭模型生成音色，对话和别名 OS 要求实际出声造型有音频', () => {
  const card = makeCard('宁宁（OS）：“别急；@阿川还没动。”；@小禾：“把门关上。”；宁宁：“我知道了。”；音效：木门撞击。')
  const referenceOnly = assets.map(asset => asset.id === 'he' ? { ...asset, voiceMode: 'reference' as const } : asset)
  assert.deepEqual(getScriptVideoMissingVoices(card, referenceOnly, options), ['阿宁_礼服', '小禾'])
  assert.deepEqual(buildScriptVideoDelivery(card, referenceOnly, options).missingVoices, ['阿宁_礼服', '小禾'])

  const voiced = referenceOnly.map(asset => ['court', 'he'].includes(asset.id) ? { ...asset, voiceAudio: audio } : asset)
  const delivery = buildScriptVideoDelivery(card, voiced, options)
  assert.deepEqual(delivery.missingVoices, [])
  assert.deepEqual(delivery.voices.flatMap(voice => voice.roles.map(role => role.id)), ['court', 'he'])
})

test('开启后允许模型为没有参考音频的 OS 生成音色，上传音频仍优先', () => {
  const card = makeCard('宁宁（OS）：“阿川还没动。”；@阿宁_常服：“把门关上。”；音效：木门撞击。')
  const enabled = assets.map(asset =>
    ['court', 'daily', 'silence'].includes(asset.id) ? { ...asset, voiceMode: 'model' as const } : asset)
  assert.deepEqual(getScriptVideoMissingVoices(card, enabled, options), [])
  const delivery = buildScriptVideoDelivery(card, enabled, { ...options, model: 'seedance2.5-ae-480p', provider: 'aicost' })
  assert.deepEqual(delivery.missingVoices, [])
  assert.deepEqual(delivery.voices.flatMap(voice => voice.roles.map(role => role.id)), ['daily'])
  assert.match(delivery.prompt, /阿宁_礼服由模型生成音色/u)
  assert.doesNotMatch(delivery.prompt, /(?:阿宁_常服|小禾|阿川)由模型生成音色/u)
})

test('识别没有角色资产的发声人，忽略系统 OV、字幕及动作音效', () => {
  const card = makeCard('阿川：无对白；系统面板（OV）：“连接完成。”；字幕：“不要出门。”；巡夜人（OS）：“有人来过。”；音效：木门撞击。')
  assert.deepEqual(getScriptVideoMissingVoices(card, assets, options), ['巡夜人'])
})

test('无台词、空引号和环境音无需音频', () => {
  const card = makeCard('阿川：（无对白）；阿川：“”；无声：只有风声。\n环境音：风声。\n环境声：树叶沙沙。\n音效/环境音：脚步声。\n广播：“请入场。”')
  assert.deepEqual(getScriptVideoMissingVoices(card, assets, options), [])
})

test('多造型的未消歧名字由素材校验处理，避免误报缺失声音', () => {
  const card = makeCard('阿宁：“好。”；阿宁（OS）：“先等等。”')
  assert.deepEqual(getScriptVideoMissingVoices(card, assets, options), [])
  assert.throws(() => buildScriptVideoDelivery(card, assets, options), /阿宁.*多个匹配/u)
})

test('闭合引号后紧接同一行的发声角色要校验声音并在成片提示词各自引用', () => {
  const roles = [
    { id: 'wei', name: '魏忠国', kind: 'character', image: '/static/uploads/wei.png', voiceAudio: { ...audio, url: '/static/uploads/wei.wav' } },
    { id: 'gu', name: '顾凌天_龙袍', kind: 'character', image: '/static/uploads/gu.png', voiceAudio: { ...audio, url: '/static/uploads/gu.wav' } },
  ]
  const dialogue = '@顾凌天_龙袍【平淡下令／简短】：“带魏忠国进来。”魏忠国【领命／干脆】：“是！”音效：衣袍摩擦。'
  const card = {
    assetIds: roles.map(role => role.id),
    duration: 4,
    shots: [{ duration: 4, dialogue }],
    prompt: `镜头 01（0–4秒）\n画面与动作：@魏忠国 和 @顾凌天_龙袍 站在殿中。\n对白／音效：${dialogue}`,
  }
  assert.deepEqual(getScriptVideoMissingVoices(card, roles.map(role =>
    role.id === 'wei' ? { ...role, voiceAudio: undefined } : role)), ['魏忠国'])
  assert.deepEqual(getScriptVideoMissingVoices(card, roles.slice(1)), ['魏忠国'])

  const jimeng = buildScriptVideoDelivery(card, roles, { provider: 'jimeng', model: 'jimeng-seedance-2.5' })
  assert.match(jimeng.prompt, /顾凌天_龙袍（音色参考@音频2）【平淡下令／简短】：“带魏忠国进来。”@图片1魏忠国（音色参考@音频1）【领命／干脆】：“是！”音效：衣袍摩擦。/u)
  const seedance = buildScriptVideoDelivery(card, roles, { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' })
  assert.match(seedance.prompt, /顾凌天_龙袍（音色参考@音频2）【平淡下令／简短】：\{带魏忠国进来。\}@图片1魏忠国（音色参考@音频1）【领命／干脆】：\{是！\}<衣袍摩擦。>/u)
  assert.doesNotMatch(seedance.prompt, /是本镜画内发声者/u)
})
