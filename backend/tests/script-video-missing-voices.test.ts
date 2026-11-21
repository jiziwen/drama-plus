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

test('默认允许模型生成音色，显式关闭后要求实际出声造型有音频', () => {
  const card = makeCard('宁宁（OS）：“别急；@阿川还没动。”；@小禾：“把门关上。”；宁宁：“我知道了。”；音效：木门撞击。')
  assert.deepEqual(getScriptVideoMissingVoices(card, assets, options), [])
  const referenceOnly = assets.map(asset => ['court', 'he'].includes(asset.id) ? { ...asset, voiceMode: 'reference' as const } : asset)
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

test('一句齐声对白按各个已绑定角色的配音设置处理', () => {
  const group = { id: 'group', name: '七天_素材/角色/残障乞讨孩童/群体', kind: 'character',
    originalName: '群体', sourcePath: '七天_素材/角色/残障乞讨孩童/群体.png',
    image: '/static/uploads/group.png', voiceMode: 'model' as const }
  const child = { id: 'child', name: '断腿小乞丐', kind: 'character',
    image: '/static/uploads/child.png', voiceMode: 'model' as const }
  const voices = [group, child]
  const cue = `@${group.name} 、@${child.name} （稚嫩齐喊）：“天，上天的天！”`
  const card = { ...makeCard(cue), assetIds: voices.map(asset => asset.id),
    prompt: `镜头 01（0–10秒）\n画面与动作：@${group.name} 和 @${child.name} 坐在草席上。\n对白／音效：${cue}` }
  const jimeng = { provider: 'jimeng', model: 'jimeng-seedance-2.5' }
  assert.deepEqual(getScriptVideoMissingVoices(card, voices, jimeng), [])
  const delivery = buildScriptVideoDelivery(card, voices, jimeng)
  assert.deepEqual(delivery.voices, [])
  assert.match(delivery.prompt, /@图片1七天_素材\/角色\/残障乞讨孩童\/群体由模型生成音色/u)
  assert.match(delivery.prompt, /@图片2断腿小乞丐由模型生成音色/u)
  assert.match(delivery.prompt, /@图片1七天_素材\/角色\/残障乞讨孩童\/群体 、@图片2断腿小乞丐 （稚嫩齐喊）：“天，上天的天！”/u)
  const seedance = buildScriptVideoDelivery(card, voices, { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' })
  assert.match(seedance.prompt, /@图片1七天_素材\/角色\/残障乞讨孩童\/群体 、@图片2断腿小乞丐 （稚嫩齐喊）：\{天，上天的天！\}/u)
  assert.doesNotMatch(seedance.prompt, /是本镜画内发声者/u)

  const audioRequired = { ...child, voiceMode: 'reference' as const }
  assert.deepEqual(getScriptVideoMissingVoices(card, [group, audioRequired], jimeng), [child.name])
  const withAudio = buildScriptVideoDelivery(card, [group, { ...child, voiceAudio: audio }], jimeng)
  assert.deepEqual(withAudio.voices.map(voice => voice.asset.id), [child.id])
  assert.match(withAudio.prompt, /@图片2断腿小乞丐（音色参考@音频1）/u)
  assert.doesNotMatch(withAudio.prompt, /断腿小乞丐由模型生成音色/u)

  const normalized = card.prompt.replace(cue, cue.replace(group.name, '残障乞讨孩童／群体'))
  assert.deepEqual(getScriptVideoMissingVoices({ ...card, prompt: normalized }, voices), [])
  const unknown = card.prompt.replace(cue, cue.replace(`@${child.name}`, '断腿小乞丐_补丁布衣'))
  assert.deepEqual(getScriptVideoMissingVoices({ ...card, prompt: unknown }, voices), ['断腿小乞丐_补丁布衣'])
})

test('剧本造型名缺少对应资产时需要手动指定角色', () => {
  const base = { id: 'child', name: '断腿小乞丐', kind: 'character', image: '/static/uploads/child.png', voiceMode: 'model' as const }
  const variant = { ...base, id: 'costume', name: '断腿小乞丐_补丁布衣', voiceMode: 'reference' as const }
  const card = { ...makeCard('断腿小乞丐_补丁布衣：“好。”'), assetIds: [base.id] }
  assert.deepEqual(getScriptVideoMissingVoices(card, [base]), [variant.name])
  const explicit = { ...card, prompt: card.prompt.replace(variant.name, `@${base.name} `) }
  assert.deepEqual(getScriptVideoMissingVoices(explicit, [base]), [])
  assert.deepEqual(getScriptVideoMissingVoices(card, [base, variant]), [variant.name])
  const explicitPicture = { ...card, prompt: card.prompt.replace('@阿川把', `@${variant.name} 把`) }
  assert.throws(() => buildScriptVideoDelivery(explicitPicture, [base]), /找不到素材 @断腿小乞丐_补丁布衣/u)
  const chibi = { ...card, prompt: card.prompt.replace(variant.name, '断腿小乞丐_补丁布衣_3DQ版') }
  assert.deepEqual(getScriptVideoMissingVoices(chibi, [base]), ['断腿小乞丐_补丁布衣_3DQ版'])
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
    role.id === 'wei' ? { ...role, voiceAudio: undefined, voiceMode: 'reference' as const } : role)), ['魏忠国'])
  assert.deepEqual(getScriptVideoMissingVoices(card, roles.slice(1)), ['魏忠国'])

  const jimeng = buildScriptVideoDelivery(card, roles, { provider: 'jimeng', model: 'jimeng-seedance-2.5' })
  assert.match(jimeng.prompt, /顾凌天_龙袍（音色参考@音频2）【平淡下令／简短】：“带魏忠国进来。”@图片1魏忠国（音色参考@音频1）【领命／干脆】：“是！”音效：衣袍摩擦。/u)
  const seedance = buildScriptVideoDelivery(card, roles, { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' })
  assert.match(seedance.prompt, /顾凌天_龙袍（音色参考@音频2）【平淡下令／简短】：\{带魏忠国进来。\}@图片1魏忠国（音色参考@音频1）【领命／干脆】：\{是！\}<衣袍摩擦。>/u)
  assert.doesNotMatch(seedance.prompt, /是本镜画内发声者/u)
})
