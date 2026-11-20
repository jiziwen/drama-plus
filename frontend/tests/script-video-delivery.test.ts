import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScriptVideoDelivery } from '../../backend/src/services/script-video-delivery'
import { exportMarkdown, type PreviewAsset, type PreviewCard } from '../app/utils/scriptVideoPreview'
import { exportPreviewPackage, portableDeliveryCard } from '../app/utils/scriptVideoPreviewExport'

const png = 'data:image/png;base64,AQID'
const voice = 'data:audio/wav;base64,BAUG'
const contextualOnly = '独立生成：顾凌天想起同图。'
const assets: PreviewAsset[] = [
  {id:'first', name:'王禄', kind:'character', image:png + 'AA==', voiceAudio:{url:voice+'AA==',name:'王禄.wav'}},
  {id:'costume', name:'顾凌天_龙袍', kind:'character', image:png, voiceAudio:{url:voice,name:'顾凌天.wav'}},
  {id:'other', name:'顾凌天_常服', kind:'character', image:png+'AQ=='},
  {id:'prop', name:'玉佩', kind:'prop', image:png+'Ag=='},
  {id:'same',name:'同图',kind:'prop',image:png+'Ag=='},
]
const card: PreviewCard = {
  id:'c',title:'偏殿', duration:5, summary:'顾凌天想起玉佩。', combat:false, status:'draft', version:1,
  assetIds:['first','costume','same'], characters:'顾凌天_龙袍、王禄',
  shots:[{id:'1',duration:3.5,camera:'',action:'',dialogue:'顾凌天_龙袍(OS)【缓慢】：“王禄拿走了玉佩。”'},
    {id:'2',duration:1.5,camera:'',action:'',dialogue:'无台词'}],
  prompt:[
    '←承上：←承上第1段：二人站定。',contextualOnly,'镜头 01（0–3.5秒）','景别／机位／运动：跟随顾凌天。',
    '画面与动作：@顾凌天_龙袍转身。','对白／音效：顾凌天_龙袍(OS)【缓慢】：“王禄拿走了玉佩。”',
    '音效：衣袖摩擦。','镜头 02（3.5–5秒）','画面与动作：王禄抬眼。','对白／音效：无台词',
    '→衔接：顾凌天静立。→衔接至第3段：下一场才出门。','手写镜头备注',
  ].join('\n'),
}
const options = {model:'doubao-seedance-2-5-260628',provider:'volcengine'}

test('角色音频参考放在本段事件之后、第一镜之前', () => {
  const settings = [
    { model: 'jimeng-seedance-2.5', provider: 'jimeng' },
    options,
    { model: 'doubao-seedance-2-0-fast', provider: 'volcengine' },
  ]
  for (const config of settings) {
    const { prompt } = buildScriptVideoDelivery(card, assets, config)
    assert.match(prompt, /(?:本段事件|独立生成)：[^\n]+\n\n[^\n]+只参考音色，不照搬音频中的内容。\n\n镜头 ?01/u)
    assert.equal(prompt.match(/只参考音色，不照搬音频中的内容。/gu)?.length, 1)
    assert.ok(prompt.endsWith('手写镜头备注'))
    assert.equal(portableDeliveryCard(card, assets, config).prompt, prompt)
  }
  const legacy = {
    ...card,
    prompt: '冷色调\r\n\r\n画面与动作：顾凌天转身。\n对白／音效：顾凌天_龙袍：“听我说。”',
    shots: [{ ...card.shots[0], dialogue: '顾凌天_龙袍：“听我说。”' }],
  }
  const { prompt } = buildScriptVideoDelivery(legacy, assets, settings[0])
  assert.match(prompt, /^冷色调\r\n\r\n[^\n]+只参考音色，不照搬音频中的内容。\n\n画面与动作：/u)
})

test('相同的资产身份贯穿简称、OS、缩略图、实际音色和原话，不把提及的道具演出来', () => {
  const result = buildScriptVideoDelivery(card, assets, options)
  assert.deepEqual(result.images.map(a => a.id), ['costume','first'])
  assert.deepEqual(result.voices.map(v => v.asset.id), ['costume'])
  assert.match(result.prompt, /跟随@图片1顾凌天。/)
  assert.match(result.prompt, /声音：画外心声（V\.O\.，顾凌天_龙袍【缓慢】，音色参考@音频1，仅声音，画内闭口不对口型）：\{王禄拿走了玉佩。\}/)
  assert.match(result.prompt, /@图片1顾凌天_龙袍的角色音色参考@音频1/)
  assert.doesNotMatch(result.prompt, /@图片\d+\s*(?:玉佩|同图)/)
  assert.match(result.prompt, /<衣袖摩擦。>/)
  assert.ok(result.prompt.endsWith('手写镜头备注'))
  assert.doesNotMatch(result.prompt,/下一场才出门|顾凌天_常服|3\.5秒/)
  assert.equal(portableDeliveryCard(card, assets, options).prompt, result.prompt)
  assert.ok(exportMarkdown([card],assets,{delivery:options}).includes(result.prompt))
  assert.match(result.prompt, /镜头01（0–4秒）/)
  assert.match(result.prompt, /镜头02（4–5秒）/)
})

test('Seedance 2.5 整秒无法表示极短镜头时保留镜头顺序', () => {
  const quickShot = {
    ...card,
    shots: card.shots.map((shot, index) => ({ ...shot, duration: index ? 4.75 : 0.25 })),
    prompt: card.prompt.replaceAll('3.5', '0.25'),
  }
  const { prompt } = buildScriptVideoDelivery(quickShot, assets, options)
  assert.match(prompt, /^镜头01\n/mu)
  assert.match(prompt, /^镜头02\n/mu)
})

test('ZIP 内模型提示词与 Markdown、JSON 完全一致，附件去重且静默人物不携带音频', async t => {
  let zip: Blob | undefined
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => { zip=blob; return 'blob:test' })
  const saved = Object.getOwnPropertyDescriptor(globalThis,'document')
  Object.defineProperty(globalThis,'document',{configurable:true,value:{ createElement: () => ({click(){}}) }})
  t.after(() => { if (saved) Object.defineProperty(globalThis,'document',saved); else Reflect.deleteProperty(globalThis,'document') })
  const prepared = { [png]: 'data:image/webp;base64,BwgJ' }
  const continuation = { imageUrl: 'data:image/jpeg;base64,CgsM', mode: 'reference' as const,
    previousCardId: 'preceding', previousTaskId: 19 }
  const lightingRanges = [{ sceneName:'院落', startShot:1, endShot:2, imageUrl:'data:image/jpeg;base64,DQ4P' }]
  const reflection: PreviewAsset = { id: 'reflection', name: '镜中倒影', kind: 'character', image: png }
  const projectAssets = [...assets, reflection]
  const current = { ...card, assetIds: [...card.assetIds, reflection.id],
    prompt: card.prompt.replace('@顾凌天_龙袍转身。', '@顾凌天_龙袍转身，@镜中倒影随他转身。') }
  await exportPreviewPackage([current],projectAssets,'片段.zip',{
    delivery:options,referenceImages:prepared,continuations:{[card.id]:continuation},
    lightingRanges: { [card.id]: lightingRanges },
  })
  assert.ok(zip)
  const bytes = Buffer.from(await zip.arrayBuffer())
  const files = new Map<string, Buffer>()
  let offset=0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const len=bytes.readUInt32LE(offset+18), nameLen=bytes.readUInt16LE(offset+26)
    const start=offset+30+nameLen+bytes.readUInt16LE(offset+28)
    files.set(bytes.toString('utf8',offset+30,offset+30+nameLen), bytes.subarray(start,start+len))
    offset=start+len
  }
  const { prompt, imageBindings } = buildScriptVideoDelivery(current,projectAssets,{ ...options, continuation, lightingRanges })
  assert.deepEqual(imageBindings.find(binding => binding.assetId === reflection.id), { assetId: reflection.id, index: 1 })
  assert.match(prompt, /@图片1镜中倒影随他转身/u)
  assert.equal(files.get('片段01/视频提示词.txt')!.toString(),prompt)
  assert.ok(files.get('分镜脚本.md')!.toString().includes(prompt))
  assert.equal(JSON.parse(files.get('分镜数据.json')!.toString()).cards[0].prompt,prompt)
  assert.deepEqual([...files.keys()].filter(name => /片段01\/图/u.test(name)), ['片段01/图1-顾凌天_龙袍.webp','片段01/图2-王禄.png','片段01/图3-上一段视频尾帧.jpg','片段01/图4-场景光线参考.jpg'])
  assert.deepEqual(files.get('片段01/图1-顾凌天_龙袍.webp'),Buffer.from([7,8,9]))
  assert.deepEqual(files.get('片段01/图3-上一段视频尾帧.jpg'),Buffer.from([10,11,12]))
  assert.deepEqual(files.get('片段01/图4-场景光线参考.jpg'),Buffer.from([13,14,15]))
  assert.match(prompt,/用@图片4参考同场人物受光/u)
  assert.deepEqual([...files.keys()].filter(name => /片段01\/声音/u.test(name)), ['片段01/声音1-顾凌天_龙袍.wav'])
})

test('有逐镜画面的稿件只发送本段实际配图，旧的自由提示词保留手选参考', () => {
  const current = { ...card, prompt: card.prompt.replace(contextualOnly + '\n', '') }
  const delivery = buildScriptVideoDelivery(current, assets, options)
  assert.deepEqual(delivery.images.map(asset => asset.id), ['costume', 'first'])
  assert.doesNotMatch(delivery.prompt, /同图/u)
  assert.doesNotMatch(delivery.prompt, /@图片\d+\s*玉佩/u)
  const freeform = { ...card, prompt: '简洁的院落镜头。', shots: [] }
  assert.deepEqual(buildScriptVideoDelivery(freeform, assets, options).images.map(asset => asset.id), ['first', 'costume', 'same'])
})

test('逐镜素材标注统一驱动交付，场外声音与纯候选配图各自处理', () => {
  const marked: PreviewCard = {
    ...card,
    openingAssetIds: [],
    shots: [{ ...card.shots[0], duration: 5, visualAssetIds: ['first'], speakerAssetIds: ['costume'] }],
    prompt: [
      '前镜回顾：@同图在桌上。\n上一段顾凌天曾出镜。',
      '←承上：同场切镜至王禄。',
      '人物：顾凌天_龙袍、王禄。',
      '镜头 01（0–5秒）',
      '画面与动作：@王禄抬眼。',
      '对白／音效：顾凌天_龙袍(OS)：“等一等。”',
    ].join('\n'),
  }
  const delivery = buildScriptVideoDelivery(marked, assets, options)
  assert.deepEqual(delivery.images.map(asset => asset.id), ['first'])
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['costume'])
  assert.deepEqual(delivery.missingVoices, [])
  assert.match(delivery.prompt, /画面与动作：@图片1王禄抬眼。/u)
  assert.doesNotMatch(delivery.prompt, /@图片\d+\s*(?:同图|顾凌天)/u)
  assert.equal(portableDeliveryCard(marked, assets, options).prompt, delivery.prompt)
})

test('同场切镜前的回顾不会把上一段造型带入本段参考图', () => {
  const roles: PreviewAsset[] = [
    { id: 'wei', name: '魏忠国', kind: 'character', image: png + 'BA==' },
    { id: 'q', name: '魏忠国_3DQ版', kind: 'character', image: png + 'BQ==' },
  ]
  const recap = '←承上：←承上第4段：上一镜是魏忠国右肩上的@魏忠国_3DQ版收住作揖，心声已收。'
  const current = {
    ...card,
    assetIds: ['wei', 'q'],
    shots: [{ ...card.shots[0], duration: 5, dialogue: '无对白。' }],
    prompt: [
      recap + '同场切镜至门内，@魏忠国仍站在柱旁。',
      '镜头 01（0–5秒）',
      '画面与动作：门扇敞开。',
      '对白／音效：无对白。',
    ].join('\n'),
  }
  const settings = { model: 'jimeng-seedance-2.5', provider: 'jimeng' }
  const cut = buildScriptVideoDelivery(current, roles, settings)
  assert.deepEqual(cut.images.map(asset => asset.id), ['wei'])
  assert.match(cut.prompt, /@图片1魏忠国仍站在柱旁/u)
  assert.doesNotMatch(cut.prompt, /@图片\d+魏忠国_3DQ版/u)
  assert.deepEqual(cut.missingVoices, [])

  const continuous = buildScriptVideoDelivery({
    ...current,
    prompt: current.prompt.replace('同场切镜至门内', '同一镜头续接上一段尾帧'),
  }, roles, settings)
  assert.deepEqual(continuous.images.map(asset => asset.id), ['wei', 'q'])
})

test('交付排除旧绑定的画外布景和未出镜道具，保留原话、声音参考和实际画面', () => {
  const added: PreviewAsset[] = [
    { id: 'yard', name: '偏殿院落', kind: 'scene', image: png + 'BA==' },
    { id: 'belfry', name: '钟房', kind: 'scene', image: png + 'BQ==' },
    { id: 'study', name: '皇宫-御书房', kind: 'scene', image: png + 'Bg==' },
    { id: 'other-study', name: '内廷-御书房', kind: 'scene', image: png + 'Bw==' },
    { id: 'letter', name: '金封密信', kind: 'prop', image: png + 'CA==' },
    { id: 'medicine-box', name: '药箱', kind: 'prop', image: png + 'CQ==' },
  ]
  const spoken = '顾凌天_龙袍(OS)：“@玉佩和@药箱还在@御书房，@未知标记照写。”'
  const current = {
    ...card,
    assetIds: ['yard', 'costume', 'first', 'prop', 'belfry', 'study', 'letter'],
    shots: [{ ...card.shots[0], dialogue: spoken }],
    prompt: [
      '场景：@偏殿院落（唯一空间）',
      '独立生成：顾凌天想起玉佩，提议稍后回御书房。',
      '镜头 01（0–5秒）',
      '画面与动作：顾凌天手持@金封密信，王禄站在身后；不展示@玉佩。',
      `对白／音效：${spoken}；音效：从远处@钟房传来三声钟响。`,
      '→衔接：顾凌天留在院中。→衔接至第2段：切到@皇宫-御书房，打开@尚未上传的紫檀柜。',
    ].join('\n'),
  }
  const delivery = buildScriptVideoDelivery(current, [...assets, ...added], options)
  assert.deepEqual(delivery.images.map(asset => asset.id).sort(), ['costume', 'first', 'letter', 'yard'])
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['costume'])
  assert.match(delivery.prompt, /\{@玉佩和@药箱还在@御书房，@未知标记照写。\}/)
  assert.match(delivery.prompt, /<从远处@?钟房传来三声钟响。>/)
  assert.match(delivery.prompt, /本段全程在.*偏殿院落/)
  assert.match(delivery.prompt, /手持@图片\d+金封密信/)
  assert.doesNotMatch(delivery.prompt, /@图片\d+\s*(?:钟房|皇宫-御书房|玉佩)|尚未上传的紫檀柜/)
  const missingVisual = { ...current, assetIds: current.assetIds.filter(id => id !== 'letter') }
  assert.throws(() => buildScriptVideoDelivery(missingVisual, [...assets, ...added], options), /金封密信.*尚未绑定/u)
})

test('实际的画外说话人仍按角色绑定原声', () => {
  const current = {
    ...card,
    assetIds: ['costume', 'first'],
    shots: [{ ...card.shots[0], dialogue: '王禄(OV)：“陛下，门外有人等候。”' }],
    prompt: [
      '镜头 01（0–5秒）',
      '画面与动作：顾凌天看向门外。',
      '对白／音效：王禄(OV)：“陛下，门外有人等候。”',
    ].join('\n'),
  }
  const delivery = buildScriptVideoDelivery(current, assets, options)
  assert.deepEqual(delivery.images.map(asset => asset.id), ['costume'])
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['first'])
  assert.match(delivery.prompt, /王禄的对白音色参考@音频1/)
  assert.match(delivery.prompt, /王禄（音色参考@音频1）\(OV\)：[“{]陛下，门外有人等候。/)
})

test('当前卡有两种造型时不能把裸人名指向任选一张图', () => {
  assert.throws(() => buildScriptVideoDelivery({...card,assetIds:['costume','other']},assets,options), /镜头 01.*顾凌天.*多个匹配.*顾凌天_龙袍.*顾凌天_常服/u)
})

test('角色设定不参与配音，仅实际发声的 OS 有声音，读圣旨和显示圣旨文字分别处理', () => {
  const scene = { ...card, prompt: [
    '人物：王禄（院中）：沉默站岗', '镜头 01（0–5秒）', '画面与动作：顾凌天手握圣旨，王禄站在身后。',
    '对白／音效：顾凌天_龙袍(OS)【缓慢】：为何王禄仍未走？',
  ].join('\n') }
  const result = buildScriptVideoDelivery(scene, assets, options)
  assert.deepEqual(result.voices.map(v => v.asset.id), ['costume'])
  assert.match(result.prompt,/声音：画外心声（V\.O\..*不对口型）：\{为何王禄仍未走？\}/)
  assert.ok(!result.prompt.includes('上呈现本段指定文字'))
  const screen = buildScriptVideoDelivery({...scene,prompt:scene.prompt.replace('手握圣旨','展开圣旨，圣旨上写着“奉天承运”')},assets,options)
  assert.match(screen.prompt,/只在圣旨上呈现本段指定文字，无额外对白字幕。/)
  const handwritten = buildScriptVideoDelivery({...scene,prompt:'顾凌天_龙袍(OS)：{为何王禄仍未走？}'},assets,options)
  assert.deepEqual(handwritten.voices.map(v => v.asset.id), ['costume'])
  assert.ok(handwritten.prompt.indexOf('只参考音色，不照搬音频中的内容。') < handwritten.prompt.indexOf('为何王禄仍未走？'))
  assert.match(handwritten.prompt, /画外心声（V\.O\.，顾凌天_龙袍，音色参考@音频1，仅声音，画内闭口不对口型）：\{为何王禄仍未走？\}/)
})

test('同一镜的内心 OS 逐句闭口，正常对白和系统 OV 保持原样', () => {
  const mixed = {
    ...card,
    assetIds: ['costume'],
    prompt: '镜头 01（0–5秒）\n画面与动作：顾凌天开口问话。\n' +
      '对白／音效：顾凌天内心独白：“别急；先问一句。”；顾凌天：“你听见什么？”；系统面板(OV)：“提示已发送。”\n' +
      '未绑定角色【O.S.】：“我也听见了。”\n' +
      '对白：顾凌天：“他说的是内心OS。”\n' +
      '林心声：“门开了。”',
  }
  for (const model of ['doubao-seedance-2-5-260628', 'wf-minimax-h3', 'wan3.0-video']) {
    const settings = { model, cast: [{ name: '林心声' }] }
    const { prompt, voices } = buildScriptVideoDelivery(mixed, assets, settings)
    const seedance25 = model.startsWith('doubao-seedance-2-5')
    assert.equal(prompt.match(seedance25 ? /画外心声（V\.O\./gu : /内心 OS，角色闭口，嘴唇不动，不对口型/gu)?.length, 2)
    assert.match(prompt, /不对口型）：[“{]别急；先问一句。/)
    assert.match(prompt, seedance25
      ? /画外心声（V\.O\.，未绑定角色，仅声音，画内闭口不对口型）：\{我也听见了。\}/
      : /未绑定角色（内心 OS，角色闭口，嘴唇不动，不对口型）：[“{]我也听见了。/)
    assert.match(prompt, /顾凌天（音色参考(?:@?音频1|<Audio 1>)）：[“{]你听见什么？/)
    assert.match(prompt, /系统面板\(OV\)：“提示已发送。”/)
    assert.match(prompt, /[“{]他说的是内心OS。/)
    assert.match(prompt, /林心声：“门开了。”/)
    assert.deepEqual(voices.map(v => v.asset.id), ['costume'])
    assert.equal(portableDeliveryCard(mixed, assets, settings).prompt, prompt)
  }
})

test('即梦同一角色的每处对白和心声都有对应音频引用，原话与动作不加标记', () => {
  const script = {
    ...card,
    assetIds: ['costume', 'first'],
    prompt: [
      '镜头 01（0–5秒）',
      '画面与动作：@顾凌天_龙袍望向@王禄。',
      '对白／音效：@顾凌天_龙袍：“去问王禄。”；@王禄(OS)：“好。”；@顾凌天_龙袍：“现在。”',
    ].join('\n'),
  }
  const { prompt, voices } = buildScriptVideoDelivery(script, assets, { model: 'jimeng-seedance-2.5-flash', provider: 'jimeng' })
  assert.deepEqual(voices.map(voice => voice.asset.id), ['costume', 'first'])
  assert.match(prompt, /画面与动作：@图片1顾凌天_龙袍望向@图片2王禄。/)
  assert.match(prompt, /顾凌天_龙袍（音色参考@音频1）：“去问王禄。”/)
  assert.match(prompt, /王禄（音色参考@音频2）（内心 OS[^）]*）：“好。”/)
  assert.match(prompt, /顾凌天_龙袍（音色参考@音频1）：“现在。”/)
})

test('Seedance 2.5 以实际镜头决定角色顺序，现场对白和纯心声用不同的声画处理', () => {
  const scene = {
    ...card, duration: 10, assetIds: ['costume', 'first'],
    prompt: [
      '人物：@顾凌天_龙袍、@王禄。',
      '镜头 01（0–2秒）', '景别／机位／运动：正面特写，@顾凌天_龙袍。',
      '画面与动作：@王禄迈步上前，@顾凌天_龙袍在后方站定。', '对白／音效：无对白。',
      '镜头 02（2–4秒）', '景别／机位／运动：中近景，@王禄。', '画面与动作：@王禄抱拳。',
      '对白／音效：@王禄：“臣遵旨！”',
      '镜头 03（4–6秒）', '景别／机位／运动：中近景正面，@王禄面部与胸前。',
      '画面与动作：@王禄抱拳的手收紧。', '台词：@王禄（OS）：“我也照抓不误！”；系统面板（OV）：“提示已发送。”',
      '镜头 04（6–8秒）', '景别／机位／运动：反打@顾凌天_龙袍的面部特写。',
      '画面与动作：@顾凌天_龙袍微微抬眉。', '对白／音效：@王禄（OS）：“还有下一步。”',
      '镜头 05（8–10秒）', '景别／机位／运动：@王禄正面近景。',
      '画面与动作：@王禄点头。', '对白／音效：@王禄（OS）：“先等一等。”；@王禄：“请听我说。”',
    ].join('\n'),
  }
  for (const settings of [options, {model:'seedance2.5-ae-480p',provider:'aicost'}]) {
    const result = buildScriptVideoDelivery(scene, assets, settings)
    assert.deepEqual(result.images.map(asset => asset.id), ['first', 'costume'])
    assert.deepEqual(result.imageBindings, [{assetId:'first',index:1}, {assetId:'costume',index:2}])
    const [, move, first, inner, reaction, mixed] = result.prompt.split(/^镜头\d+(?:（\d+–\d+秒）)?\n/mu)
    assert.match(move, /@图片1王禄是该动作的主体.*由同一人接续下一镜/u)
    assert.match(first, /@图片1王禄保持对应参考图的造型，是本镜画内发声者/u)
    assert.match(first, /@图片1王禄（音色参考@音频1）：\{臣遵旨！\}/u)
    assert.match(inner, /嘴部始终在画框外；主体为@图片1王禄/u)
    assert.match(inner, /@图片1王禄抱拳的手收紧/u)
    assert.match(inner, /声音：画外心声（V\.O\.，王禄，音色参考@音频1，仅声音，画内闭口不对口型）：\{我也照抓不误！\}/u)
    assert.match(reaction, /反打@图片2顾凌天_龙袍的面部特写/u)
    assert.match(mixed, /@图片1王禄正面近景/u)
    assert.match(mixed, /@图片1王禄（音色参考@音频1）：\{请听我说。\}/u)
  }
})

test('当前项目的 ComfyUI、火山 2.0 与外部交付均使用所选模型的真实引用格式', () => {
  for (const model of ['wf-minimax-h3', 'doubao-seedance-2-0-fast', 'wan3.0-video']) {
    const delivery = buildScriptVideoDelivery(card, assets, {model})
    assert.equal(portableDeliveryCard(card,assets,{model}).prompt,delivery.prompt)
    if (model === 'wf-minimax-h3') assert.ok(delivery.prompt.includes('<Picture 2>顾凌天'))
    if (model === 'doubao-seedance-2-0-fast') assert.ok(delivery.prompt.includes('镜头01\n'))
    if (model === 'wan3.0-video') assert.match(delivery.prompt, /跟随图2顾凌天/)
  }
})

test('锁定有明确场景的片段，下一段的场景和道具留在编辑器', () => {
  const nextAssets: PreviewAsset[] = [
    {id:'yard', name:'皇宫-偏殿院落', kind:'scene', image:png+'BA=='},
    {id:'hall', name:'皇宫-偏殿正厅', kind:'scene', image:png+'BQ=='},
    {id:'letter', name:'金封密信', kind:'prop', image:png+'Bg=='},
  ]
  const current = {
    ...card,
    assetIds:['yard','costume','hall','letter'],
    prompt:[
      '场景：51-01｜@皇宫-偏殿院落（唯一空间）',
      '镜头 01（0–5秒）',
      '画面与动作：顾凌天停在台阶上，望向院门外。',
      '→衔接：顾凌天站在院中。→衔接至第2段：切到@皇宫-偏殿正厅，展开@金封密信。',
    ].join('\n'),
  }
  for (const config of [options, {model:'wf-minimax-h3'}]) {
    const result = buildScriptVideoDelivery(current, [...assets, ...nextAssets], config)
    assert.match(result.prompt, /本段全程在.*皇宫-偏殿院落/)
    assert.match(result.prompt, /望向院门外/)
    assert.match(result.prompt, /顾凌天站在院中/)
    assert.doesNotMatch(result.prompt, /正厅|密信|衔接至第2段/)
    assert.deepEqual(result.images.map(a=>a.id).sort(), ['costume','yard'])
    assert.equal(portableDeliveryCard(current,[...assets,...nextAssets],config).prompt, result.prompt)
  }
})

test('保留本段镜头内实际发生的跨门和切景', () => {
  const scenes: PreviewAsset[] = [
    {id:'yard', name:'宫殿外广场', kind:'scene', image:png+'BA=='},
    {id:'hall', name:'宫殿正厅', kind:'scene', image:png+'BQ=='},
  ]
  const current = {
    ...card, assetIds:['yard','hall'],
    prompt:[
      '场景：@宫殿外广场 → @宫殿正厅',
      '镜头 01（0–3秒）','画面与动作：从@宫殿外广场走到门前。',
      '镜头 02（3–5秒）','画面与动作：跨过门槛，切到@宫殿正厅。',
    ].join('\n'),
  }
  const delivery = buildScriptVideoDelivery(current, scenes, options)
  assert.deepEqual(delivery.images.map(a=>a.id), ['yard','hall'])
  assert.match(delivery.prompt, /跨过门槛，切到@图片2宫殿正厅/)
  assert.doesNotMatch(delivery.prompt, /本段全程在/)
})
