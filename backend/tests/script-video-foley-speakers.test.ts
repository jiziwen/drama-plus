import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScriptVideoDelivery, getScriptVideoMaterialUse } from '../src/services/script-video-delivery'

const model = { provider: 'jimeng', model: 'jimeng-seedance-2.5' }
const characters = [{ id: 'wu', name: '吴良' }, { id: 'qi', name: '小七' }].map(character => ({
  ...character, kind: 'character', image: '/static/uploads/' + character.id + '.png',
  voiceAudio: { name: '音色', url: '/static/uploads/' + character.id + '.wav' },
}))
const words = '吴良【傲慢嗤笑／笑着起声，反问短促上挑】：“哈哈哈！压你又怎么样？”'
function card(dialogue: string, speakerAssetIds?: string[]) {
  return {
    duration: 4, assetIds: ['wu', 'qi'],
    shots: [{ duration: 4, dialogue, visualAssetIds: ['wu', 'qi'], speakerAssetIds }],
    prompt: '镜头 01（0–4秒）\n画面与动作：@吴良 打开折扇，@小七 站在一旁。\n对白／音效：' + dialogue,
  }
}

test('音效后紧接表演提示时，把同一条吴良音频用于附件和逐句标注', () => {
  for (const foley of ['〈象牙折扇展开一声轻响。〉', '<象牙折扇展开一声轻响。>', '《象牙折扇展开一声轻响。》',
    '（扇响）【脚步声】', '音效：象牙折扇展开一声轻响。', '音效：〈扇响〉']) {
    for (const recorded of [undefined, ['wu']]) {
      const clip = card(foley + words, recorded)
      const delivery = buildScriptVideoDelivery(clip, characters, model)
      assert.deepEqual(getScriptVideoMaterialUse(clip, characters, model).speakerIds, ['wu'], foley)
      assert.deepEqual(delivery.voices.map(voice => voice.asset.voiceAudio.url), ['/static/uploads/wu.wav'], foley)
      assert.match(delivery.prompt, /吴良（音色参考@音频1）【傲慢嗤笑／笑着起声，反问短促上挑】/u, foley)
    }
  }
})

test('忽略音效及台词内部的假署名，保留音效之后实际台词的缺音色校验', () => {
  const clip = card('〈远处的录音；小七：“请安静。”〉吴良：“我念的是〈掌声〉小七：好。”')
  const delivery = buildScriptVideoDelivery(clip, characters, model)
  assert.deepEqual(delivery.voices.map(voice => voice.asset.voiceAudio.url), ['/static/uploads/wu.wav'])
  assert.deepEqual(delivery.missingVoices, [])
  assert.ok(delivery.prompt.includes('〈远处的录音；小七：“请安静。”〉'))
  assert.ok(delivery.prompt.includes('我念的是〈掌声〉小七：好。'))
  assert.deepEqual(getScriptVideoMaterialUse(card('〈扇响。〉来客【低声】：“谁？”'), characters, model).missingVoices, ['来客'])
  const description = card('音效：收录了几段采样，吴良：衣袍的摩擦声。')
  assert.deepEqual(getScriptVideoMaterialUse(description, characters, model).speakerIds, [])
})

test('完整音效后的停顿标点不影响其后发言人或缺失音色检查', () => {
  for (const separator of ['，', '。', ' ； ', ' ！ ']) {
    const clip = card('〈录音：小七〉' + separator + words)
    assert.deepEqual(getScriptVideoMaterialUse(clip, characters, model).speakerIds, ['wu'])
    assert.deepEqual(getScriptVideoMaterialUse(clip, [], model).missingVoices, ['吴良'])
  }
  const clip = card('吴良：“小心。” ， 〈远处：风响〉 小七：“知道。”')
  assert.deepEqual(getScriptVideoMaterialUse(clip, characters, model).speakerIds, ['wu', 'qi'])
})

test('完整引号包住的音效不会吞掉下一轮发言，引号内的分号和署名均为原文', () => {
  for (const dialogue of ['音效：“砰！”吴良：“快走。”', '环境音：“小七：来了。”吴良：“好。”']) {
    assert.deepEqual(getScriptVideoMaterialUse(card(dialogue), characters, model).speakerIds, ['wu'])
  }
  for (const middle of ['环境音：“旁人：来了。”', '，〈脚步声〉', '']) {
    const clip = card('吴良：“我说；旁人：一句话。”' + middle + '小七：“好。”')
    const use = getScriptVideoMaterialUse(clip, characters, model)
    assert.deepEqual(use.speakerIds, ['wu', 'qi'], middle)
    assert.deepEqual(use.missingVoices, [], middle)
  }
})
