import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isScriptVideoNonvisualMention,
  scriptVideoAssetScopeRanges,
  splitScriptVideoHandoff,
} from '../src/services/script-video-asset-scope.js'

const visibleScopes = (text: string, dialogue = false) => scriptVideoAssetScopeRanges(text, dialogue)
  .map(({start, end, kind}) => [kind, text.slice(start, end)] as const)

test('E54 wrapped summary, sound column and nested handoff retain their original offsets', () => {
  const prompt = [
    '🌙 场景风格',
    '←承上：←承上视频编号02：开场仍在偏殿院落。',
    '独立生成：本段目标：萧容鱼劝其回御书房。',
    '佛珠为段末道具。',
    '镜头 05（14–17秒）',
    '画面与动作：咖妃歪坐软榻上，右手捻着佛珠。',
    '对白／音效：无对白；@佛珠轻碰（物理音效）。',
    '→衔接：→衔接至视频编号04：顾凌天一段仍在@偏殿，本段完成于大殿内。',
  ].join('\r\n')
  assert.deepEqual(visibleScopes(prompt), [
    ['summary', '独立生成：本段目标：萧容鱼劝其回御书房。\r\n佛珠为段末道具。'],
    ['sound', '@佛珠轻碰（物理音效）。'],
    ['handoff', '→衔接至视频编号04：顾凌天一段仍在@偏殿，本段完成于大殿内。'],
  ])
  const { body, notes } = splitScriptVideoHandoff(prompt)
  assert.deepEqual(notes, ['→衔接至视频编号04：顾凌天一段仍在@偏殿，本段完成于大殿内。'])
  assert.match(body, /\r\n←承上：开场仍在偏殿院落。\r\n/u)
  assert.match(body, /画面与动作：咖妃歪坐软榻上，右手捻着佛珠。/u)
  assert.doesNotMatch(body, /→衔接至/u)
})

test('handoff scopes only the following clip and preserves the actual end portrait', () => {
  const line = '→衔接：顾凌天停在@院落。下一段开场才切到@御书房。'
  const quoted = '末镜停在：牌匾有“下一段将到@御书房；开门”六字。'
  assert.deepEqual(splitScriptVideoHandoff([line, quoted].join('\n')), {
    body: '→衔接：顾凌天停在@院落。\n→衔接：牌匾有“下一段将到@御书房；开门”六字。',
    notes: ['下一段开场才切到@御书房。'],
  })
  assert.deepEqual(visibleScopes(line), [['handoff', '下一段开场才切到@御书房。']])
  assert.deepEqual(visibleScopes(quoted), [])
  assert.deepEqual(splitScriptVideoHandoff('→衔接至视频编号04：@院落。'), { body: '', notes: ['→衔接至视频编号04：@院落。'] })
})

test('foley protects only its clause, including quotation punctuation and unquoted speaker boundaries', () => {
  const text = [
    '对白 / 音效：@侍卫：“拟音：@台阶有声；快走。”；音效：@门锁“咯噔；吱呀”，@小旗【微喘】：快跑。；<远处@龙椅被撞>；画面与动作：@王禄跑进@院落。',
    '画面与动作：@侍卫说“物理音效”，@道具破碎（物理音效）。',
    '对白／音效：顾凌天：“听。”\n拟音：@佛珠在远处相撞。',
  ].join('\n')
  assert.deepEqual(visibleScopes(text), [
    ['sound', '音效：@门锁“咯噔；吱呀”'],
    ['sound', '<远处@龙椅被撞>'],
    ['sound', '拟音：@佛珠在远处相撞。'],
  ])
  assert.deepEqual(visibleScopes('无对白；@佛珠落地（物理音效）。', true), [
    ['sound', '@佛珠落地（物理音效）。'],
  ])
  assert.deepEqual(visibleScopes('对白：@侍卫：“听，<门响>”<佛珠轻响>；@小旗：快跑。'), [
    ['sound', '<佛珠轻响>'],
  ])
})

test('summaries end at real fields, unlabelled quoted speakers and blank lines', () => {
  const text = '本段事件：甲先劝说\n乙想起书房\n甲：“我在这里。”\n本段事件：另写丁\n\n戊出场\n镜头 01（0–2秒）'
  assert.deepEqual(visibleScopes(text), [['summary', '本段事件：甲先劝说\n乙想起书房'], ['summary', '本段事件：另写丁']])
})

test('negated and proposed destinations do not absorb a following visual clause or a real transition', () => {
  const check = (text: string, name: string, expected: boolean) => {
    const start = text.indexOf(name)
    assert.ok(start >= 0)
    assert.equal(isScriptVideoNonvisualMention(text, start, start + name.length), expected, text)
  }
  check('萧容鱼劝其回@御书房，顾凌天留在院落。', '@御书房', true)
  check('顾凌天没有进入御书房，站在院落。', '御书房', true)
  check('顾凌天没有进入御书房，站在院落。', '院落', false)
  check('赵峰没有停步，随后切入御书房。', '御书房', false)
  check('顾凌天未迟疑，直接推开御书房门。', '御书房', false)
  check('顾凌天没有离开御书房，近景拍摄。', '御书房', false)
  check('赵峰刚才打算回去，眼下已经走进御书房。', '御书房', false)
  check('顾凌天不去御书房，而转入大殿。', '大殿', false)
  check('御书房（仅对白提及）。', '御书房', true)
  check('画面与动作：顾凌天手持@金封密信，不展示@玉佩。', '@玉佩', true)
  check('画面与动作：顾凌天手持@金封密信，不展示@玉佩。', '@金封密信', false)
  check('独立生成：众人商议下段前往@议事厅。', '@议事厅', true)
  check('赵峰正在寻找失踪的@太监，自己沿着廊下奔跑。', '@太监', true)
  check('赵峰一边寻找@玉佩，终于找到并拿起。', '@玉佩', false)
  check('赵峰从抽屉里找出@玉佩。', '@玉佩', false)
  check('赵峰不松开@玉佩，转身出门。', '@玉佩', false)
  check('赵峰回想起当年@御书房。', '@御书房', true)
  check('画面闪回：@御书房的木门敞开。', '@御书房', false)
})
