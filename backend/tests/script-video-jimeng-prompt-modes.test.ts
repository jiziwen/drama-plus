import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildScriptVideoDelivery, getScriptVideoMaterialUse, getScriptVideoPromptVoices, getScriptVideoVoiceInputs,
  type ScriptVideoDeliveryAsset, type ScriptVideoDeliveryCard } from '../src/services/script-video-delivery.js'

const assets: ScriptVideoDeliveryAsset[] = [
  { id: 'yard', name: '北城门', kind: 'scene', image: '/static/uploads/yard.jpg' },
  { id: 'gu', name: '顾凌天_黑色锦袍', kind: 'character', image: '/static/uploads/gu.jpg',
    voiceAudio: { url: '/static/uploads/gu.mp3', name: '皇帝.mp3' } },
  { id: 'xiao', name: '萧天策_将军盔甲', kind: 'character', image: '/static/uploads/xiao.jpg',
    voiceAudio: { url: '/static/uploads/xiao.mp3', name: '将军.mp3' } },
  { id: 'sword', name: '绣春刀', kind: 'prop', image: '/static/uploads/sword.jpg' },
]
const card: ScriptVideoDeliveryCard = {
  duration: 6, assetIds: assets.map(asset => asset.id),
  shots: [{ duration: 3, dialogue: '顾凌天：“萧将军，退下。”', speakerAssetIds: ['gu'] },
    { duration: 3, dialogue: '萧天策(OS)：“先等等。”', speakerAssetIds: ['xiao'] }],
  prompt: ['场景：@北城门', '人物：@顾凌天_黑色锦袍与@萧天策_将军盔甲。',
    '镜头 01（0–3秒）', '画面与动作：@顾凌天_黑色锦袍按住@绣春刀，望向@萧天策_将军盔甲。',
    '对白／音效：@顾凌天_黑色锦袍：“萧将军，退下。”',
    '镜头 02（3–6秒）', '画面与动作：@萧天策_将军盔甲抬眼。',
    '对白／音效：@萧天策_将军盔甲(OS)：“先等等。”', '→衔接：两人留在原地。'].join('\n'),
}
const options = { provider: 'jimeng', model: 'jimeng-seedance-2.5', promptMode: 'reference-guide' as const }
const stylePreset = { id: 'custom' as const, name: '暖色调', prefix: '暖色调\n\n暖色电影光线，禁止字幕。' }
const bodyOf = (prompt: string) => prompt.slice(prompt.indexOf('镜头 01'))

test('素材说明模式前置所有素材和音色说明，风格及正文在后，正文保留资产名和逐角色音频', () => {
  const built = buildScriptVideoDelivery(card, assets, { ...options, stylePreset })
  assert.ok(built.prompt.startsWith('参考素材：\n@图片1 是 @北城门 的场景布局参考图。'))
  assert.match(built.prompt, /@图片2 是 @顾凌天_黑色锦袍 的人物造型参考图。/u)
  assert.match(built.prompt, /@图片3 是 @萧天策_将军盔甲 的人物造型参考图。/u)
  assert.match(built.prompt, /@图片4 是 @绣春刀 的道具形态参考图。/u)
  assert.match(built.prompt, /@音频1 是 @顾凌天_黑色锦袍 的配音音色参考/u)
  assert.match(built.prompt, /@音频2 是 @萧天策_将军盔甲 的配音音色参考/u)
  assert.ok(built.prompt.indexOf('参考素材：') < built.prompt.indexOf('暖色电影光线'))
  assert.ok(built.prompt.indexOf('配音音色参考') < built.prompt.indexOf('暖色电影光线'))
  assert.match(built.prompt, /各角色沿用各自参考图的脸、发型和服装/u)
  const body = bodyOf(built.prompt)
  assert.doesNotMatch(body, /@图片\d+/u)
  assert.match(body, /画面与动作：@顾凌天_黑色锦袍按住@绣春刀，望向@萧天策_将军盔甲。/u)
  assert.match(body, /对白／音效：@顾凌天_黑色锦袍 @音频1：“萧将军，退下。”/u)
  assert.match(body, /对白／音效：@萧天策_将军盔甲 @音频2\(OS\) ：“先等等。”/u)
  assert.match(body, /→衔接：两人留在原地。/u)
})

test('逐处引用模式保留原来的图片和声音插入方式，切换不改变附件顺序', () => {
  const guide = buildScriptVideoDelivery(card, assets, { ...options, stylePreset })
  const inline = buildScriptVideoDelivery(card, assets, { ...options, stylePreset, promptMode: 'inline' })
  assert.ok(inline.prompt.startsWith('暖色电影光线，禁止字幕。'))
  assert.doesNotMatch(inline.prompt, /参考素材：/u)
  assert.match(inline.prompt, /@图片2顾凌天_黑色锦袍的对白音色参考@音频1/u)
  assert.match(bodyOf(inline.prompt), /@图片2顾凌天_黑色锦袍 @音频1：“萧将军，退下。”/u)
  assert.match(bodyOf(inline.prompt), /@图片3萧天策_将军盔甲 @音频2\(OS\) ：“先等等。”/u)
  assert.deepEqual(guide.images, inline.images)
  assert.deepEqual(guide.voices, inline.voices)
  assert.deepEqual(guide.imageBindings, inline.imageBindings)
  assert.deepEqual(guide.missingVoices, inline.missingVoices)
})

test('最终提示词和提交保留续接对白手改的内心 OS，沿用心声与音色归属', () => {
  const providerOptions = [options,
    { provider: 'libtv', model: 'star-video2.5' },
    { provider: 'aicost', model: 'seedance2.5-ae-480p' },
    { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' },
    { provider: 'aicost', model: 'seedance2.0-720p' },
    { provider: 'minimax', model: 'wf-minimax-h3' },
  ]
  const acting = '（内心OS、续）【焦躁／紧凑】'
  const direct = '先等等。'
  for (const marker of ['(内心OS)', '(内心 OS)', '（内心 OS）', '内心 (OS)']) {
    const edited = { ...card, prompt: card.prompt.replace('(OS)：“先等等。”', `${acting} ${marker}：“${direct}”`) }
    for (const provider of providerOptions) for (const promptMode of ['reference-guide', 'inline'] as const) {
      const request = { ...provider, promptMode }
      const delivery = buildScriptVideoDelivery(edited, assets, request)
      const preview = buildScriptVideoDelivery(edited, assets, { ...request, preview: true })
      assert.equal(preview.prompt, delivery.prompt)
      const dialogue = delivery.prompt.split('\n').find(line => line.includes(direct)) || ''
      const authored = `${acting} ${marker}`
      assert.ok(dialogue.includes(authored), `${provider.provider}/${promptMode}: ${dialogue}`)
      assert.match(dialogue, /萧天策_将军盔甲 (?:@?音频2|<Audio 2>)/u)
      assert.match(dialogue.slice(dialogue.indexOf(authored) + authored.length), /^[ \t]*：“先等等。”$/u)
      assert.doesNotMatch(delivery.prompt, /萧天策_将军盔甲保持对应参考图的造型，是本镜画内发声者/u)
      assert.deepEqual(delivery.voices.map(group => group.asset.id), ['gu', 'xiao'])
      assert.deepEqual(getScriptVideoVoiceInputs(edited, assets, request), getScriptVideoVoiceInputs(card, assets, request))
    }
  }
})

test('续接和光线帧编号与专用语义集中在正文前，语音和素材附件顺序仍相同', () => {
  const frameOptions = {
    ...options, stylePreset,
    continuation: { previousCardId: 'prior', imageUrl: '/static/videos/tail.jpg', mode: 'reference' as const, manualSeconds: 2.25 },
    lightingRanges: [{ startShot: 1, endShot: 2, sceneName: '北城门', lighting: '延续午后侧前方日光。', imageUrl: '/static/videos/light.jpg' }],
  }
  const guide = buildScriptVideoDelivery(card, assets, frameOptions)
  const inline = buildScriptVideoDelivery(card, assets, { ...frameOptions, promptMode: 'inline' })
  assert.match(guide.prompt, /@图片5 是续接参考图。/u)
  assert.match(guide.prompt, /@图片6 是北城门的光线与影调参考图。/u)
  assert.match(guide.prompt, /以@图片5作为本段首帧.*手动选取的续接画面/u)
  assert.match(guide.prompt, /用@图片6参考同场人物受光、阴影、曝光与色调/u)
  assert.ok(guide.prompt.indexOf('以@图片5') < guide.prompt.indexOf('暖色电影光线'))
  assert.ok(guide.prompt.indexOf('用@图片6') < guide.prompt.indexOf('暖色电影光线'))
  assert.doesNotMatch(bodyOf(guide.prompt), /@图片\d+/u)
  assert.deepEqual(guide.openingFrame, inline.openingFrame)
  assert.deepEqual(guide.lightingImages, inline.lightingImages)
  assert.deepEqual(guide.lightingRanges, inline.lightingRanges)
})

test('独立手选声音在前置区明确对应说话角色，正文仍使用所选声音', () => {
  const picked: ScriptVideoDeliveryAsset = { id: 'picked', name: '沉稳男声', kind: 'audio', image: '',
    voiceAudio: { url: '/static/uploads/picked.wav', name: '沉稳.wav' } }
  const manual = { ...card, assetIds: [...card.assetIds, picked.id],
    prompt: card.prompt.replace('@顾凌天_黑色锦袍：“', '@顾凌天_黑色锦袍 @沉稳男声：“') }
  const built = buildScriptVideoDelivery(manual, [...assets, picked], options)
  assert.deepEqual(built.voices.map(group => group.asset.id), ['xiao', 'picked'])
  assert.match(built.prompt, /@音频2 是 @顾凌天_黑色锦袍 的配音音色参考（声音素材：@沉稳男声）/u)
  assert.match(bodyOf(built.prompt), /@顾凌天_黑色锦袍 @音频2：“萧将军，退下。”/u)
  assert.match(bodyOf(built.prompt), /@萧天策_将军盔甲 @音频1\(OS\) ：“先等等。”/u)
})

test('画外对白、旁白、原话及音效不因素材说明模式丢失', () => {
  const offscreen = { ...card, prompt: card.prompt.replace('@顾凌天_黑色锦袍：“萧将军，退下。”',
    '@顾凌天_黑色锦袍（画外）：“图1是题目，音频1是答案。”；旁白：“城门未开。”；音效：衣甲摩擦。') }
  const built = buildScriptVideoDelivery(offscreen, assets, options)
  assert.match(bodyOf(built.prompt), /@顾凌天_黑色锦袍 @音频1（画外）：“图1是题目，音频1是答案。”/u)
  assert.match(bodyOf(built.prompt), /旁白：“城门未开。”/u)
  assert.match(bodyOf(built.prompt), /音效：衣甲摩擦。/u)
  assert.doesNotMatch(bodyOf(built.prompt), /@图片\d+/u)
})

test('没有角色归属的独立音效仍说明为声音参考，不改成角色配音', () => {
  const sound = { id: 'drum', name: '鼓点', kind: 'audio', image: '',
    voiceAudio: { url: '/static/uploads/drum.wav', name: '鼓点.wav' } }
  const built = buildScriptVideoDelivery({ duration: 6, assetIds: ['drum'], shots: [],
    manuallyAdded: true, prompt: '音效：@鼓点。' }, [sound], options)
  assert.match(built.prompt, /@音频1 是 @鼓点 的声音参考，按本段标注使用。/u)
  assert.match(built.prompt, /音效：@音频1。/u)
  assert.doesNotMatch(built.prompt, /配音音色参考/u)
})

test('同一声音文件只提交一次，说明仍列全角色，不把普通名字或台词变成资源引用', () => {
  const sameAudio = assets.map(asset => asset.id === 'xiao' ? { ...asset, voiceAudio: assets[1].voiceAudio } : asset)
  const built = buildScriptVideoDelivery(card, sameAudio, options)
  assert.equal(built.voices.length, 1)
  assert.match(built.prompt, /@音频1 是 @顾凌天_黑色锦袍、@萧天策_将军盔甲 的配音音色参考/u)
  assert.match(bodyOf(built.prompt), /@萧天策_将军盔甲 @音频1\(OS\) ：“先等等。”/u)
})

test('各服务显式选择素材说明时沿用原生标签，未指定模式的纯构建继续沿用逐处引用', () => {
  for (const [providerOptions, picture, audio] of [
    [{ provider: 'jimeng', model: 'jimeng-seedance-2.5' }, '@图片', '@音频'],
    [{ provider: 'volcengine', model: 'doubao-seedance-2-5-260628' }, '@图片', '@音频'],
    [{ provider: 'aicost', model: 'seedance2.5-ae-480p' }, '@图片', '@音频'],
    [{ provider: 'aicost', model: 'minimax-h3' }, '<Picture ', '<Audio '],
    [{ provider: 'aicost', model: 'wan3.0-720p-3' }, '图', '音频'],
    [{ provider: 'minimax', model: 'wf-minimax-h3' }, '<Picture ', '<Audio '],
    [{ provider: 'aliyun', model: 'wan3.0-video' }, '图', '音频'],
    [{ provider: 'libtv', model: 'star-video2.5' }, '@图片', '@音频'],
    [{}, '@图片', '@音频'],
  ] as const) {
    const original = buildScriptVideoDelivery(card, assets, providerOptions)
    assert.deepEqual(buildScriptVideoDelivery(card, assets, { ...providerOptions, promptMode: 'inline' }), original)
    const guide = buildScriptVideoDelivery(card, assets, { ...providerOptions, promptMode: 'reference-guide' })
    assert.ok(guide.prompt.startsWith('参考素材：\n' + picture + '1'))
    assert.ok(guide.prompt.includes(audio + '1' + (audio.startsWith('<') ? '>' : '') + ' 是 @顾凌天_黑色锦袍 的配音音色参考'))
    const body = guide.prompt.slice(guide.prompt.search(/^镜头\s*01/mu))
    assert.doesNotMatch(body, /@图片\d+|<Picture \d+>|图\d+/u)
    assert.ok(body.includes('@顾凌天_黑色锦袍 ' + audio + '1' + (audio.startsWith('<') ? '>' : '') + '：'))
    assert.ok(body.includes('萧将军，退下。'))
    assert.ok(body.includes('先等等。'))
    assert.doesNotMatch(body, /�/u)
  }
})

test('Seedance素材说明保留实际人声表演主体与随后现场台词，笑声镜头不添加闭口命令', () => {
  const dialogue = '顾凌天短促发笑。萧天策：“住手。”'
  const selected: ScriptVideoDeliveryCard = { duration: 6, assetIds: ['gu', 'xiao'],
    shots: [{ duration: 6, dialogue }],
    prompt: '镜头 01（0–6秒）\n画面与动作：@顾凌天_黑色锦袍望向@萧天策_将军盔甲。\n对白／音效：' + dialogue }
  const built = buildScriptVideoDelivery(selected, assets, { provider: 'libtv', model: 'star-video2.5', promptMode: 'reference-guide' })
  assert.deepEqual(built.voices.map(group => group.asset.id), ['gu', 'xiao'])
  assert.match(built.prompt, /@顾凌天 @音频1短促发笑。@萧天策 @音频2：\{住手。\}/u)
  assert.match(built.prompt, /@萧天策保持对应参考图的造型，说出本镜标注的台词。/u)
  assert.doesNotMatch(built.prompt, /嘴唇闭合|是本镜画内发声者/u)
})

test('素材说明上传本段已绑定但正文未提到的图片，不扩展未绑定图库或明确排除项', () => {
  const additions: ScriptVideoDeliveryAsset[] = [
    { id: 'horse', name: '白马', kind: 'creature', image: '/static/uploads/horse.jpg' },
    { id: 'excluded', name: '已排除玉佩', kind: 'prop', image: '/static/uploads/excluded.jpg' },
    { id: 'library-only', name: '库中长枪', kind: 'prop', image: '/static/uploads/library-only.jpg' },
  ]
  const selected: ScriptVideoDeliveryCard = { duration: 6,
    assetIds: ['gu', 'sword', 'xiao', 'horse', 'excluded'], excludedAssetIds: ['excluded'],
    shots: [{ duration: 6, dialogue: '顾凌天：“退下。”', speakerAssetIds: ['gu'] }],
    prompt: '镜头 01（0–6秒）\n画面与动作：@顾凌天_黑色锦袍抬眼。\n对白／音效：@顾凌天_黑色锦袍：“退下。”' }
  const built = buildScriptVideoDelivery(selected, [...assets, ...additions], options)
  assert.deepEqual(built.images.map(asset => asset.id), ['gu', 'sword', 'xiao', 'horse'])
  assert.match(built.prompt, /@图片2 是 @绣春刀 的道具形态参考图（是否出镜以当前分镜为准）。/u)
  assert.match(built.prompt, /@图片4 是 @白马 的生物外形参考图（是否出镜以当前分镜为准）。/u)
  assert.doesNotMatch(built.prompt, /已排除玉佩|库中长枪/u)
  assert.deepEqual(built.voices.map(group => group.asset.id), ['gu'], '补全沉默角色图片不能附带其声音')
  assert.deepEqual(getScriptVideoMaterialUse(selected, [...assets, ...additions], options).imageIds, ['gu', 'sword', 'xiao', 'horse'])
  const inline = buildScriptVideoDelivery(selected, [...assets, ...additions], { ...options, promptMode: 'inline' })
  assert.deepEqual(inline.images.map(asset => asset.id), ['gu'], '逐处引用模式仍按正文选图')
})

test('补全图片按相同文件去重，素材别名共用编号且后续音频次序不受影响', () => {
  const sameImage: ScriptVideoDeliveryAsset = { ...assets[3], id: 'sword-alias', name: '另一把绣春刀' }
  const selected = { ...card, assetIds: ['gu', 'sword', 'sword-alias'], shots: [{ duration: 6, dialogue: '顾凌天：“退下。”' }],
    prompt: '镜头 01（0–6秒）\n画面与动作：@顾凌天_黑色锦袍抬眼。\n对白／音效：@顾凌天_黑色锦袍：“退下。”' }
  const built = buildScriptVideoDelivery(selected, [...assets, sameImage], options)
  assert.deepEqual(built.images.map(asset => asset.id), ['gu', 'sword'])
  assert.deepEqual(built.imageBindings, [{ assetId: 'gu', index: 1 }, { assetId: 'sword', index: 2 }, { assetId: 'sword-alias', index: 2 }])
  assert.match(built.prompt, /@图片2 是 @绣春刀 的道具形态参考图（是否出镜以当前分镜为准）。/u)
  assert.match(built.prompt, /@图片2 是 @另一把绣春刀 的道具形态参考图（是否出镜以当前分镜为准）。/u)
  assert.deepEqual(built.voices.map(group => group.asset.id), ['gu'])
})

test('自由提示词补全已选角色图时，不为未讲话角色发送音色文件，音频视图和摘要也一致', () => {
  const selected: ScriptVideoDeliveryCard = { duration: 6, assetIds: ['gu', 'xiao', 'sword'], shots: [],
    prompt: '画面与动作：@顾凌天_黑色锦袍抬眼。' }
  const built = buildScriptVideoDelivery(selected, assets, options)
  assert.deepEqual(built.images.map(asset => asset.id), ['gu', 'xiao', 'sword'])
  assert.deepEqual(built.voices, [])
  assert.deepEqual(getScriptVideoPromptVoices(selected, assets, options), [])
  assert.equal(getScriptVideoVoiceInputs(selected, assets, options).size, 0)
  assert.doesNotMatch(built.prompt, /@音频\d+/u)
  const inline = buildScriptVideoDelivery(selected, assets, { ...options, promptMode: 'inline' })
  assert.deepEqual(inline.images.map(asset => asset.id), ['gu', 'xiao', 'sword'])
  assert.deepEqual(inline.voices.map(group => group.asset.id), ['gu', 'xiao'], '旧逐处模式继续保留旧自由提示词的声音兜底')
})

test('已绑定但未在正文引用的独立音频进入素材区，不生成额外说话人或台词', () => {
  const sounds: ScriptVideoDeliveryAsset[] = ['drum', 'excluded-sound', 'library-sound'].map(id => ({
    id, name: id, kind: 'audio', image: '', voiceAudio: { url: '/static/uploads/' + id + '.wav', name: id },
  }))
  const selected: ScriptVideoDeliveryCard = { duration: 6, assetIds: ['gu', 'xiao', 'drum', 'excluded-sound'],
    excludedAssetIds: ['excluded-sound'], shots: [{ duration: 6, dialogue: '顾凌天：“退下。”', speakerAssetIds: ['gu'] }],
    prompt: '镜头 01（0–6秒）\n画面与动作：@顾凌天_黑色锦袍抬眼。\n对白／音效：@顾凌天_黑色锦袍：“退下。”' }
  const built = buildScriptVideoDelivery(selected, [...assets, ...sounds], options)
  assert.deepEqual(built.voices.map(group => group.asset.id), ['gu', 'drum'])
  assert.match(built.prompt, /@音频2 是 @drum 的声音参考，按本段标注使用。/u)
  assert.doesNotMatch(bodyOf(built.prompt), /@音频2|drum|excluded-sound|library-sound/u)
  assert.doesNotMatch(built.prompt, /excluded-sound|library-sound|@萧天策_将军盔甲 的配音/u)
  assert.deepEqual(getScriptVideoPromptVoices(selected, [...assets, ...sounds], options).map(group => group.asset.id), ['gu', 'drum'])
  assert.deepEqual([...getScriptVideoVoiceInputs(selected, [...assets, ...sounds], options).keys()], ['gu', 'drum'])
  const inline = buildScriptVideoDelivery(selected, [...assets, ...sounds], { ...options, promptMode: 'inline' })
  assert.deepEqual(inline.voices.map(group => group.asset.id), ['gu'])
})

test('素材说明不会把正文隐式提及的未绑定人物自动加入上传，预览保留警告', () => {
  const selected: ScriptVideoDeliveryCard = { duration: 6, assetIds: ['gu'], shots: [{ duration: 6, dialogue: '无对白。' }],
    prompt: '镜头 01（0–6秒）\n画面与动作：顾凌天看着萧天策。\n对白／音效：无对白。' }
  assert.throws(() => buildScriptVideoDelivery(selected, assets, options), /萧天策.*尚未绑定/u)
  const preview = buildScriptVideoDelivery(selected, assets, { ...options, preview: true })
  assert.deepEqual(preview.images.map(asset => asset.id), ['gu'])
  assert.ok(preview.warnings?.some(message => message.includes('萧天策')))
})

for (const providerOptions of [
  { provider: 'libtv', model: 'star-video2.5' },
  { provider: 'aicost', model: 'seedance2.5-ae-480p' },
  { provider: 'volcengine', model: 'doubao-seedance-2-5-260628' },
]) {
  test(providerOptions.provider + '素材说明仍识别实际说话角色，保留口型保护、前镜动作主体及原台词', () => {
    const spoken = '我说；萧天策：退下。'
    const selected: ScriptVideoDeliveryCard = { duration: 6, assetIds: ['gu', 'xiao'],
      shots: [{ duration: 3, dialogue: '无对白。' },
        { duration: 3, dialogue: '顾凌天：“' + spoken + '”', speakerAssetIds: ['gu'] }],
      prompt: ['镜头 01（0–3秒）', '画面与动作：@顾凌天_黑色锦袍走向@萧天策_将军盔甲。',
        '对白／音效：音效：脚步。', '镜头 02（3–6秒）',
        '画面与动作：@顾凌天_黑色锦袍停在@萧天策_将军盔甲面前。',
        '对白／音效：音效：衣料轻响；', '', '@顾凌天_黑色锦袍【平静】：“' + spoken + '”'].join('\n') }
    const built = buildScriptVideoDelivery(selected, assets, { ...providerOptions, promptMode: 'reference-guide' })
    assert.match(built.prompt, /@顾凌天_黑色锦袍是该动作的主体.*由同一人接续下一镜。/u)
    assert.match(built.prompt, /@顾凌天_黑色锦袍保持对应参考图的造型，是本镜画内发声者。其他在画人物按本镜安排动作，嘴唇闭合。/u)
    assert.ok(built.prompt.includes('@顾凌天_黑色锦袍 @音频1【平静】：{' + spoken + '}'))
    assert.deepEqual(built.voices.map(group => group.asset.id), ['gu'])
    assert.doesNotMatch(built.prompt.slice(built.prompt.indexOf('镜头01')), /@图片\d+/u)
    const offscreen = buildScriptVideoDelivery({ ...selected,
      prompt: selected.prompt.replace('【平静】', '（画外）'),
    }, assets, { ...providerOptions, promptMode: 'reference-guide' })
    assert.doesNotMatch(offscreen.prompt, /是本镜画内发声者|是该动作的主体/u)
    assert.ok(offscreen.prompt.includes('@顾凌天_黑色锦袍 @音频1（画外）：{' + spoken + '}'))
  })
}

test('缺图的已绑定图片在预览中给出警告，提交时拒绝静默漏图', () => {
  const selected: ScriptVideoDeliveryCard = { duration: 6, assetIds: ['gu', 'sword'], shots: [{ duration: 6, dialogue: '无对白。' }],
    prompt: '镜头 01（0–6秒）\n画面与动作：@顾凌天_黑色锦袍抬眼。\n对白／音效：无对白。' }
  const catalog = assets.map(asset => asset.id === 'sword' ? { ...asset, image: '' } : asset)
  assert.throws(() => buildScriptVideoDelivery(selected, catalog, options), /找不到.*绣春刀/u)
  const preview = buildScriptVideoDelivery(selected, catalog, { ...options, preview: true })
  assert.ok(preview.warnings?.some(message => message.includes('绣春刀')))
  assert.deepEqual(preview.images.map(asset => asset.id), ['gu'])
})
