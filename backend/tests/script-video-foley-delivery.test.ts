import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScriptVideoDelivery } from '../src/services/script-video-delivery'

const assets = [
  { id: 'wu', kind: 'character', name: '吴良', image: '/static/uploads/wu.png',
    voiceAudio: { name: '吴良', url: '/static/uploads/wu.wav' } },
  { id: 'gu', kind: 'character', name: '顾凌天_青布长衫', image: '/static/uploads/gu.png',
    voiceAudio: { name: '顾凌天', url: '/static/uploads/gu.wav' } },
]
const line = '哈哈哈！压你又怎么样？'
const direction = '【傲慢哂笑 / 笑着起声，反问短促上挑】'

function render(dialogue: string, provider = 'libtv', model = 'star-video2.5') {
  const card = {
    assetIds: ['wu', 'gu'], duration: 3, shots: [{ duration: 3, dialogue }],
    prompt: `镜头 01（0–3秒）\n画面与动作：@吴良朝@顾凌天_青布长衫展开折扇。\n对白／音效：${dialogue}`,
  }
  return buildScriptVideoDelivery(card, assets, { provider, model })
}

test('心声按简洁OS格式交付，保留音效、人物与音频引用、表演和原话', () => {
  const effect = '两下干脆的木门叩响。'
  const delivery = render(effect + '@顾凌天_青布长衫【画外只闻心声／低沉冷淡／短促】(OS) ：“进来！”')
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['gu'])
  assert.ok(delivery.prompt.includes('对白／音效：' + effect + '@图片2顾凌天_青布长衫 @音频1【画外只闻心声／低沉冷淡／短促】(OS) ：“进来！”'))
  assert.doesNotMatch(delivery.prompt, /声音：|角色闭口|嘴唇不动|不对口型|嘴部始终在画框外|\{进来！\}/u)
  assert.match(delivery.prompt, /画面与动作：@图片1吴良朝@图片2顾凌天_青布长衫展开折扇。/u)
})

for (const [provider, model] of [['libtv', 'star-video2.5'], ['volcengine', 'doubao-seedance-2-5']]) {
  test(`${model}保留台词前的独立音效，吴良使用本人音色，顾凌天保持闭口`, () => {
    const effect = '〈象牙折扇展开一声轻响。〉'
    const delivery = render(effect + '吴良' + direction + '：“' + line + '”', provider, model)
    assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu'])
    assert.ok(delivery.prompt.includes('对白／音效：' + effect + '@图片1吴良 @音频1' + direction + '：{' + line + '}'))
    assert.match(delivery.prompt, /@图片1吴良保持对应参考图的造型，是本镜画内发声者。其他在画人物按本镜安排动作，嘴唇闭合。/u)
  })
}

test('前置音效中的角色名不分配口型，台词引用里的音效示例逐字保留', () => {
  const effect = '〈顾凌天_青布长衫的脚步声。〉'
  const spoken = '那上面写着〈脚步声〉，听见了吗？'
  const delivery = render(effect + '吴良：「' + spoken + '」')
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu'])
  assert.ok(delivery.prompt.includes('对白／音效：' + effect.replace('顾凌天_青布长衫', '@图片2顾凌天_青布长衫') + '@图片1吴良 @音频1：{' + spoken + '}'))
  assert.doesNotMatch(delivery.prompt, /顾凌天_青布长衫保持对应参考图的造型，是本镜画内发声者/u)
})

test('前置音效不改变OS和画外对白的声音模式', () => {
  const effect = '〈扇骨轻响。〉'
  const inner = render(effect + '吴良（OS）：“真有意思。”')
  assert.deepEqual(inner.voices.map(voice => voice.asset.id), ['wu'])
  assert.ok(inner.prompt.includes('对白／音效：' + effect + '@图片1吴良 @音频1(OS) ：“真有意思。”'))
  const external = render(effect + '吴良（画外）：“谁在那里？”')
  assert.ok(external.prompt.includes(effect + '@图片1吴良 @音频1（画外）：{谁在那里？}'))
  for (const delivery of [inner, external]) assert.doesNotMatch(delivery.prompt, /是本镜画内发声者/u)
})

test('普通音效标签保持模型的音效格式，原有分号与台词分开', () => {
  const delivery = render('音效：扇骨轻响；吴良：“开门。”')
  assert.ok(delivery.prompt.includes('对白／音效：<扇骨轻响>；@图片1吴良 @音频1：{开门。}'))
})

test('无标签的前置拟音后仍识别说话角色，并把音频紧跟在角色名后', () => {
  const effect = '靴底轻擦青砖。'
  const dialogue = effect + '吴良（内心OS）【心急 / 略快】：“门外是谁？”'
  const inner = render(dialogue)
  assert.deepEqual(inner.voices.map(voice => voice.asset.id), ['wu'])
  assert.ok(inner.prompt.includes('对白／音效：' + effect + '@图片1吴良 @音频1【心急 / 略快】(OS) ：“门外是谁？”'))
  const spoken = render(effect + '吴良：“门外是谁？”')
  assert.ok(spoken.prompt.includes('对白／音效：' + effect + '@图片1吴良 @音频1：{门外是谁？}'))
  assert.match(spoken.prompt, /@图片1吴良保持对应参考图的造型，是本镜画内发声者/u)
})

test('音效后的逗号和句号保留在角色名之前，不能干扰口型和OS归属', () => {
  for (const punctuation of ['，', '。']) {
    const before = '〈扇骨轻响〉' + punctuation
    const spoken = render(before + '吴良：“开门。”')
    assert.ok(spoken.prompt.includes(before + '@图片1吴良 @音频1：{开门。}'))
    assert.match(spoken.prompt, /@图片1吴良保持对应参考图的造型，是本镜画内发声者/u)
    const inner = render(before + '吴良（OS）：“真有意思。”')
    assert.ok(inner.prompt.includes(before + '@图片1吴良 @音频1(OS) ：“真有意思。”'))
    assert.doesNotMatch(inner.prompt, /是本镜画内发声者/u)
  }
})

test('两人对白之间加逗号和音效时分别保留原话及音色，不强制单人开口', () => {
  const delivery = render('吴良：“去。”，〈门闩：咔哒一声〉 顾凌天_青布长衫：“来。”')
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu', 'gu'])
  assert.ok(delivery.prompt.includes('@图片1吴良 @音频1：{去。}，〈门闩：咔哒一声〉 @图片2顾凌天_青布长衫 @音频2：{来。}'))
  assert.doesNotMatch(delivery.prompt, /是本镜画内发声者/u)
})

test('带引号的环境音只渲染为音效，闭引号后的真实台词独立配音', () => {
  const delivery = render('吴良：“小心。”环境音：“李四：来了。”顾凌天_青布长衫：“好。”')
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu', 'gu'])
  assert.ok(delivery.prompt.includes('@图片1吴良 @音频1：{小心。}<李四：来了。>@图片2顾凌天_青布长衫 @音频2：{好。}'))
})

test('台词引号内的分号和伪说话人按原句输出，闭合后下一位继续发声', () => {
  const delivery = render('〈扇骨轻响〉吴良：“我说；李四：一句话。”顾凌天_青布长衫：“好。”')
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu', 'gu'])
  assert.ok(delivery.prompt.includes('〈扇骨轻响〉@图片1吴良 @音频1：{我说；李四：一句话。}@图片2顾凌天_青布长衫 @音频2：{好。}'))
})

test('命名音效后齐声的两位角色分别引用音频，两人台词不进入音效范围', () => {
  const delivery = render('音效：门响，@吴良、@顾凌天_青布长衫【齐声】：“好。”')
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu', 'gu'])
  assert.match(delivery.prompt, /对白／音效：(?:<门响>，|<门响，>)@图片1吴良 @音频1、@图片2顾凌天_青布长衫 @音频2【齐声】：\{好。\}/u)
  assert.doesNotMatch(delivery.prompt, /是本镜画内发声者/u)
})

test('音效引出的同一行中，第一人现场说话、下一人的心声按简洁OS格式交付', () => {
  for (const separator of ['', '，']) {
    const delivery = render('〈扇骨轻响。〉吴良：“小心。”' + separator + '顾凌天_青布长衫（OS）：“真是好险。”')
    assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu', 'gu'])
    assert.ok(delivery.prompt.includes('@图片1吴良 @音频1：{小心。}' + separator + '@图片2顾凌天_青布长衫 @音频2(OS) ：“真是好险。”'))
    assert.match(delivery.prompt, /@图片1吴良保持对应参考图的造型，是本镜画内发声者/u)
  }
})

test('第六镜独立出现的笑声附上吴良声音，收住笑声的描述和其他人物不带音频', () => {
  const crowd = { id: 'crowd', name: '家丁', kind: 'character', image: '/static/uploads/crowd.png', voiceMode: 'model' as const }
  const dialogue = '〈吴良短促仰头发笑，身侧家丁跟着哄笑；笑声随吴良低头收住。〉'
  const card = {
    assetIds: [...assets.map(a => a.id), crowd.id], duration: 3, shots: [{ duration: 3, dialogue }],
    prompt: '镜头 01（0–3秒）\n画面与动作：@吴良望向@顾凌天_青布长衫，@家丁站在一旁。\n对白／音效：' + dialogue,
  }
  const delivery = buildScriptVideoDelivery(card, [...assets, crowd], { provider: 'libtv', model: 'star-video2.5' })
  assert.deepEqual(delivery.voices.map(v => v.asset.voiceAudio?.url), ['/static/uploads/wu.wav'])
  assert.match(delivery.prompt, /对白／音效：〈@图片1吴良 @音频1短促仰头发笑，身侧@图片3家丁跟着哄笑；笑声随@图片1吴良低头收住。〉/u)
  assert.match(delivery.prompt, /家丁由模型生成音色/u)
  assert.doesNotMatch(delivery.prompt, /是本镜画内发声者|\{吴良短促|吴良的对白音色/u)
})

test('本镜有笑声时不要求发笑者闭嘴，其他镜原有的说话人口型指令仍保留', () => {
  const first = '〈吴良低笑一声。〉顾凌天_青布长衫：“住口。”'
  const second = '顾凌天_青布长衫：“别动。”'
  const card = {
    assetIds: ['wu', 'gu'], duration: 6, shots: [{ duration: 3, dialogue: first }, { duration: 3, dialogue: second }],
    prompt: '镜头 01（0–3秒）\n画面与动作：@吴良望着@顾凌天_青布长衫。\n对白／音效：' + first +
      '\n镜头 02（3–6秒）\n画面与动作：@顾凌天_青布长衫转向@吴良。\n对白／音效：' + second,
  }
  const delivery = buildScriptVideoDelivery(card, assets, { provider: 'libtv', model: 'star-video2.5' })
  const [one, two] = delivery.prompt.split('镜头01')[1].split('镜头02')
  assert.ok(one.includes('〈@图片1吴良 @音频1低笑一声。〉@图片2顾凌天_青布长衫 @音频2：{住口。}'))
  assert.doesNotMatch(one, /其他在画人物按本镜安排动作，嘴唇闭合/u)
  assert.match(two, /其他在画人物按本镜安排动作，嘴唇闭合/u)
})

test('没有音效括号时也将发笑的动作与随后其他角色的现场台词、心声分开', () => {
  const live = render('吴良发笑。顾凌天_青布长衫：“住口。”')
  assert.ok(live.prompt.includes('@图片1吴良 @音频1发笑。@图片2顾凌天_青布长衫 @音频2：{住口。}'))
  assert.match(live.prompt, /@图片2顾凌天_青布长衫保持对应参考图的造型，说出本镜标注的台词/u)
  const inner = render('吴良发笑，顾凌天_青布长衫（OS）：“又来了。”')
  assert.ok(inner.prompt.includes('@图片1吴良 @音频1发笑，@图片2顾凌天_青布长衫 @音频2(OS) ：“又来了。”'))
})
