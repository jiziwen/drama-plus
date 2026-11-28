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

test('未设置配音时，实际出声角色需要参考音频', () => {
  const card = makeCard('宁宁（OS）：“别急；@阿川还没动。”；@小禾：“把门关上。”；宁宁：“我知道了。”；音效：木门撞击。')
  assert.deepEqual(getScriptVideoMissingVoices(card, assets, options), ['阿宁_礼服', '小禾'])
  const withoutAudio = buildScriptVideoDelivery(card, assets, options)
  assert.deepEqual(withoutAudio.missingVoices, ['阿宁_礼服', '小禾'])
  assert.doesNotMatch(withoutAudio.prompt, /由模型生成音色/u)

  const voiced = assets.map(asset => ['court', 'he'].includes(asset.id) ? { ...asset, voiceAudio: audio } : asset)
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
  assert.match(withAudio.prompt, /@图片2断腿小乞丐 @音频1/u)
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

test('修仙分镜的说话人带门派前缀时按明确引用的角色附上音色', () => {
  const elder = { id: 'elder', name: '大长老', kind: 'character', image: '/static/uploads/elder.png', voiceAudio: audio }
  const other = { id: 'other', name: '钟不慎', kind: 'character', image: '/static/uploads/other.png' }
  const dialogue = '听雪楼@大长老【男｜长者年龄感｜低沉厚实、略带砂质的男声｜沉着脸责问，后半句压重｜中等偏高音量｜自然语速｜对白（1/1）｜中文普通话】：「你这个师傅怎么当的，连徒弟都看不好！」'
  const action = '听雪楼@大长老按住桌沿，@钟不慎抬眼。\n情绪提示：压着火问。'
  const sound = '音效：掌根按上木桌沿的一记闷响。'
  const camera = '侧向中景，定机。'
  const card = { assetIds: [elder.id, other.id], duration: 5,
    shots: [{ duration: 5, camera, action, dialogue: `${dialogue}\n${sound}` }],
    prompt: `总时长：5秒\n\n镜头 01（0–5秒）\n景别／机位／运动：${camera}\n画面与动作：${action}\n对白／音效：${dialogue}\n${sound}`,
  }
  for (const promptMode of ['reference-guide', 'inline'] as const) {
    const delivery = buildScriptVideoDelivery(card, [elder, other], { provider: 'jimeng', model: 'jimeng-seedance-2.5', promptMode })
    assert.deepEqual(delivery.voices.map(voice => voice.asset.id), [elder.id])
    if (promptMode === 'reference-guide') {
      assert.match(delivery.prompt, /@音频1 是 大长老 的配音音色参考/u)
      assert.match(delivery.prompt, /【配音指令】：听雪楼大长老｜[^\n]*「你这个师傅怎么当的，连徒弟都看不好！」/u)
      assert.doesNotMatch(delivery.prompt.split('【配音指令】')[1], /@音频\d+/u)
    } else {
      assert.match(delivery.prompt, /【配音指令】：听雪楼@(?:图片\d+)?大长老｜[^\n]*音色参考@音频1[^\n]*「你这个师傅怎么当的，连徒弟都看不好！」/u)
    }
    assert.doesNotMatch(delivery.prompt, /^动作：.*@音频/mu)
  }
  assert.deepEqual(getScriptVideoMissingVoices(card, [{ ...elder, voiceAudio: undefined }, other]), ['大长老'])
})

test('独立音效、署名旁白和显式齐声都使用实际发声者各自的音频', () => {
  const roles = ['大长老', '二长老'].map((name, index) => ({ id: `elder-${index}`, name, kind: 'character',
    image: `/static/uploads/elder-${index}.png`, voiceAudio: { ...audio, url: `/static/uploads/elder-${index}.wav` } }))
  const card = { duration: 5, assetIds: roles.map(role => role.id), shots: [{ duration: 5, dialogue: '' }] }
  const header = '镜头 01（0–5秒）\n画面与动作：@大长老跟@二长老站在门边。\n'
  for (const [line, expected] of [
    ['音效：@大长老咳嗽一声。', ['大长老']],
    ['旁白：@大长老【低声】：「灯熄了。」', ['大长老']],
    ['对白／音效：@大长老和@二长老【齐声】：「遵命。」', ['大长老', '二长老']],
  ] as const) {
    const source = { ...card, prompt: header + line }
    const delivery = buildScriptVideoDelivery(source, roles, { promptMode: 'reference-guide' })
    assert.deepEqual(delivery.voices.map(voice => voice.asset.name), [...expected], line)
    const sound = delivery.prompt.split('\n').at(-1)!
    for (const [index, name] of expected.entries()) {
      assert.ok(delivery.prompt.includes(`@音频${index + 1} 是 ${name} 的配音音色参考`))
      assert.ok(sound.includes(name))
    }
    assert.doesNotMatch(sound, /@/u)
    assert.deepEqual(getScriptVideoMissingVoices(source, roles.map(role => ({ ...role, voiceAudio: undefined }))), [...expected])
  }
  assert.deepEqual(buildScriptVideoDelivery({ ...card, prompt: header + '音效：门轴轻响。' }, roles).voices, [])
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
  assert.match(jimeng.prompt, /顾凌天_龙袍 @音频2【平淡下令／简短】：“带魏忠国进来。”@图片1魏忠国 @音频1【领命／干脆】：“是！”音效：衣袍摩擦。/u)
  const seedance = buildScriptVideoDelivery(card, roles, { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' })
  assert.match(seedance.prompt, /顾凌天_龙袍 @音频2【平淡下令／简短】：\{带魏忠国进来。\}@图片1魏忠国 @音频1【领命／干脆】：\{是！\}<衣袍摩擦。>/u)
  assert.doesNotMatch(seedance.prompt, /是本镜画内发声者/u)
})
