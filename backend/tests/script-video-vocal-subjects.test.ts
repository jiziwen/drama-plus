import assert from 'node:assert/strict'
import test from 'node:test'
import { scriptVideoFoleyCues } from '../src/services/script-video-foley'
import { annotateScriptVideoAssets } from '../src/services/script-video-mentions'
import { buildScriptVideoDelivery } from '../src/services/script-video-delivery'

const crowdName = '七天_素材/角色/吴良家丁/群体'
const assets = [
  { id: 'wu', kind: 'character', name: '吴良', image: 'wu.png', voiceAudio: { name: '吴良', url: '/wu.wav' } },
  { id: 'crowd', kind: 'character', name: crowdName, image: 'crowd.png', voiceMode: 'model' as const },
  { id: 'chief', kind: 'character', name: '吴良为首家丁', image: 'chief.png', voiceAudio: { name: '领头', url: '/chief.wav' } },
]
const options = { dialogue: true, autoBind: true, detectUnboundSpeakers: true }
const bound = assets.map(a => a.id)
const scan = (text: string) => annotateScriptVideoAssets(text, assets, bound, options)

test('第六镜笑声绑定实际发声的吴良和家丁群体，原文及第二次提及吴良的位置保持不变', () => {
  const dialogue = '〈吴良短促仰头发笑，身侧家丁跟着哄笑；笑声随吴良低头收住。〉'
  const result = scan(dialogue)
  assert.deepEqual(result.mentions.filter(hit => hit.vocalization).map(hit =>
    [hit.id, dialogue.slice(hit.start, hit.end), hit.usage, hit.spoken, hit.literal]),
  [['wu', '吴良', 'speaker', true, true], ['crowd', '家丁', 'speaker', true, true]])
  assert.equal(result.text, dialogue)
  const delivery = buildScriptVideoDelivery({ duration: 3, assetIds: bound, shots: [{ duration: 3, dialogue }],
    prompt: '镜头 01（0–3秒）\n对白／音效：' + dialogue }, assets, { provider: 'jimeng', model: 'jimeng-seedance-2.5' })
  assert.deepEqual(delivery.voices.map(voice => voice.asset.id), ['wu'])
  assert.deepEqual(delivery.missingVoices, [])
})

test('只把对白字段内实际发出的哭、喊、叹息和咳声归到主体', () => {
  for (const dialogue of ['吴良低声抽泣。', '〈吴良放声大哭。〉', '音效：吴良大喊一声。', '吴良轻叹一声。', '〈吴良咳嗽两声。〉', '〈吴良低笑一声。〉']) {
    assert.deepEqual(scan(dialogue).mentions.filter(hit => hit.vocalization).map(hit => hit.id), ['wu'], dialogue)
  }
  for (const dialogue of ['〈吴良手中的折扇一声轻响，衣料摩擦。〉', '〈吴良听见一声哄笑。〉', '〈吴良让家丁发笑。〉',
    '〈吴良忍住笑，家丁无声微笑。〉', '〈录音里有人提到“吴良发笑”。〉', '吴良：“家丁大哭。吴良发笑。”',
    '吴良：等着。家丁大哭。', '〈听见吴良在隔壁，门外传来笑声。〉', '〈假设吴良发笑。〉', '〈若吴良发笑，家丁便会发现他。〉',
    '〈吴良发笑便会引人注意。〉', '〈纸上写着‘风响；吴良发笑。’〉']) {
    assert.deepEqual(scan(dialogue).mentions.filter(hit => hit.vocalization), [], dialogue)
    assert.deepEqual(scan(dialogue).unboundSpeakers, [], dialogue)
  }
  assert.deepEqual(annotateScriptVideoAssets('画面与动作：吴良仰头发笑。', assets, bound,
    { autoBind: true }).mentions.filter(hit => hit.vocalization), [])
  assert.deepEqual(scan('〈吴良听见家丁正在抽泣。〉').mentions.filter(hit => hit.vocalization).map(hit => hit.id), ['crowd'])
  assert.deepEqual(scan('吴良发笑。家丁：“住口。”').mentions.filter(hit => hit.usage === 'speaker').map(hit => hit.id), ['wu', 'crowd'])
})

test('叙述的人声保留缺角色、群体歧义校验，不会用领头家丁的声音代替群众', () => {
  assert.deepEqual(scan('〈巡夜人低声抽泣。〉').unboundSpeakers, ['巡夜人'])
  const other = { ...assets[1], name: '七天_素材/角色/赵府家丁/群体', id: 'other' }
  assert.deepEqual(annotateScriptVideoAssets('〈家丁哄笑。〉', [...assets, other], [...bound, other.id], options).ambiguous, ['家丁'])
  assert.deepEqual(annotateScriptVideoAssets('〈家丁哄笑。〉', assets, ['wu', 'chief'], options).unboundSpeakers, ['家丁'])
})

test('家丁群体的声音简称不改变同段领头家丁的镜头和画面引用', () => {
  const source = '镜头 01（0–3秒）\n景别：焦点落在家丁眼部。\n画面与动作：吴良为首家丁看向门外。家丁仅右袖和手入镜，家丁先斜眼打量。\n对白／音效：〈身侧家丁跟着哄笑。〉'
  const result = annotateScriptVideoAssets(source, assets, bound, { autoBind: true })
  assert.deepEqual(result.mentions.filter(hit => hit.usage === 'visual').map(hit => hit.id), ['chief'])
  assert.deepEqual(result.mentions.filter(hit => hit.vocalization).map(hit => hit.id), ['crowd'])
  assert.equal(result.text, source.replace('吴良为首家丁', '@吴良为首家丁'))
})

test('音色标注不会提前闭合外围音效或把下一句对白吞入音效', () => {
  for (const cue of ['（吴良（音色参考@音频3）发笑。）', '<吴良（音色参考<Audio 3>）发笑。>',
    '(吴良（音色参考音频3）发笑。)', '〈吴良（音色参考@音频3）发笑。〉']) {
    const line = cue + '吴良：“来人。”'
    assert.deepEqual(scriptVideoFoleyCues(line).map(hit => line.slice(hit.start, hit.end)), [cue])
  }
})
