import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { renderScriptVideoPrompt } from '../src/services/script-video-format.js'
import { assertScriptVideoCards, getScriptVideoContentWarnings, type ScriptVideoCard } from '../src/services/script-video-types.js'

const episode16 = JSON.parse(readFileSync(new URL('./fixtures/script-video-episode16.json', import.meta.url), 'utf8'))

test('episode 16 keeps the original dialogue when its action quotes the end of the same line', () => {
  const card: ScriptVideoCard = structuredClone(episode16.card)
  card.prompt = renderScriptVideoPrompt(card, episode16.assets, undefined, episode16.stylePreset)
  assert.match(card.shots[0].action, /说完“天翻地覆”/u)
  assert.match(card.shots[0].dialogue, /谁知短短一日，局势已天翻地覆。/u)
  assert.doesNotThrow(() => assertScriptVideoCards({
    script: episode16.script, assets: episode16.assets, cards: [card], scope: 'card',
  }))
})

const script = '甲：“我回来了。”\n乙(OS)：“天快亮了。”'
function sample(): ScriptVideoCard {
  const card: ScriptVideoCard = {
    id: 'return', title: '归来', duration: 4, summary: '甲归来，乙心里着急。',
    assetIds: [], combat: false, status: 'draft', version: 1, prompt: '',
    opening: '院门刚打开。', scene: '清晨院内。', characters: '甲在门内，乙站在身侧。',
    independentGeneration: '甲进门，乙看向天边。', ending: '两人留在院内。',
    shots: [
      { id: 'one', duration: 2, camera: '近景／平视／固定', action: '甲进门后站定。', dialogue: '甲：“我回来了。”' },
      { id: 'two', duration: 2, camera: '近景／平视／固定', action: '乙闭口望向天边。', dialogue: '乙(OS)：“天快亮了。”' },
    ],
  }
  return render(card)
}
function render(card: ScriptVideoCard) {
  return { ...card, prompt: renderScriptVideoPrompt(card, []) }
}
function validate(card: ScriptVideoCard, source = script) {
  assertScriptVideoCards({ script: source, assets: [], cards: [card] })
  return getScriptVideoContentWarnings({ script: source, assets: [], cards: [card] })
}
test('action and opening quotations can refer to complete or partial dialogue without performing it twice', () => {
  const card = sample()
  card.opening = '乙心声：“天快亮了。”所对应的天色延续上一镜。'
  card.shots[0].action = '甲说完“我回来了”后合唇，抬头看向乙。'
  card.shots[1].action = '乙心里想着“天快亮了”，嘴唇始终闭合。'
  assert.doesNotThrow(() => validate(render(card)))
})

test('handoff quotations from adjacent source lines do not become current segment speech', () => {
  const card = sample()
  card.opening = '上一镜甲说：“先走一步。”后推门。'
  card.ending = '下一段乙说：“在门口等我。”时再走出院门。'
  const source = '甲：“先走一步。”\n' + script + '\n乙：“在门口等我。”'
  assert.doesNotThrow(() => assertScriptVideoCards({ script: source, assets: [], cards: [render(card)], scope: 'card' }))
})

test('execution checks leave sound-field omissions to the supplied model rules', () => {
  const card = sample()
  card.shots[0].action = '甲说完“我回来了”后合唇。'
  card.prompt = render(card).prompt.replace('对白／音效：甲：“我回来了。”', '对白／音效：（无对白）')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE'))
})

test('execution checks accept manually edited sound text', () => {
  const card = sample()
  card.prompt = card.prompt.replace('我回来了。', '我从来没有回来。')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE_NEW'))
})

test('execution checks do not infer duplicate performances from repeated text', () => {
  const card = sample()
  card.prompt = card.prompt.replace('对白／音效：甲：“我回来了。”', '对白／音效：甲：“我回来了。”\n甲：“我回来了。”')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE_NEW'))
})

test('execution checks accept dialogue assigned to another shot', () => {
  const card = sample()
  card.prompt = card.prompt.replace('对白／音效：甲：“我回来了。”', '对白／音效：（无对白）')
    .replace(/(对白／音效：)([^\n]*天快亮了。[^\n]*)/u, '$1甲：“我回来了。”\n$2')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE'))
})

test('execution checks do not infer speaker identity from prose', () => {
  const card = sample()
  card.prompt = card.prompt.replace('对白／音效：甲：', '对白／音效：乙：')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE_SPEAKER'))
})

test('execution checks do not infer voice mode from prose', () => {
  const card = sample()
  const changed = structuredClone(card)
  changed.shots[1].dialogue = '乙：“天快亮了。”'
  card.prompt = render(changed).prompt
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE_MODE'))
})

test('execution checks allow voice-mode changes without a semantic repair call', () => {
  const card = sample()
  card.shots[1].dialogue = '乙：“天快亮了。”'
  assert.ok(validate(render(card)).some(issue => issue.code === 'DIALOGUE_INNER_OS'))
})

test('execution checks do not interpret context quotations as forbidden speech', () => {
  for (const field of ['opening', 'independentGeneration', 'ending'] as const) {
    const card = sample()
    card[field] = '甲说：“我不会再回来了。”'
    assert.ok(validate(render(card)).some(issue => issue.code === 'PROMPT_DIALOGUE_NEW'))
  }
  const card = sample()
  card.shots[0].action = '甲说：“我不会再回来了。”'
  assert.ok(validate(render(card)).some(issue => issue.code === 'PROMPT_DIALOGUE_NEW'))
})

test('unspoken text shown in the picture is not invented speech', () => {
  const card = sample()
  card.shots[0].action = '屏幕显示：“此地禁止入内。”甲看一眼后站定。'
  assert.doesNotThrow(() => validate(render(card)))
})

test('a source line can remain split into consecutive utterances within the same shot', () => {
  const card = sample()
  card.prompt = card.prompt.replace('甲：“我回来了。”', '甲：“我回”\n甲：“来了。”')
  assert.doesNotThrow(() => validate(card))
})

test('execution checks accept repeated short lines with different prose speaker labels', () => {
  const card = sample()
  card.shots[0].dialogue = '甲：“好。”'
  card.shots[1].dialogue = '乙：“好。”'
  card.prompt = render(card).prompt.replace('对白／音效：甲：', '对白／音效：乙：')
  assert.doesNotThrow(() => validate(card, '甲：“好。”\n乙：“好。”'))
})

test('execution checks accept alternative narrative prompt headings', () => {
  const card = sample()
  card.prompt = card.prompt.replace('镜头 02（2–4秒）', '下一镜（2–4秒）')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE_STRUCTURE'))
})

test('rendering without a cast never turns an ambiguous literal character name into inner speech', () => {
  const card = sample()
  card.characters = '张浩内心与张浩是两个角色。'
  card.shots = [{ ...card.shots[0], duration: 4, dialogue: '张浩内心【平静】：“这是我的名字。”' }]
  const rendered = render(card)
  assert.match(rendered.prompt, /对白／音效：张浩内心【平静】：/u)
  assert.doesNotMatch(rendered.prompt, /张浩【平静】（内心 OS/u)
  assert.doesNotThrow(() => validate(rendered, '人物：张浩内心、张浩\n张浩内心：【平静】“这是我的名字。”'))
})

test('已知角色的心声统一渲染为简短 OS 标记', () => {
  const card = sample()
  card.characters = '张浩站在窗前。'
  card.assetIds = ['zhang']
  card.shots = [{ ...card.shots[0], duration: 4, action: '张浩闭口站在窗前。', dialogue: '张浩内心【平静】：“别回头。”' }]
  const assets = [{ id: 'zhang', name: '张浩', kind: 'character' }]
  card.prompt = renderScriptVideoPrompt(card, assets)
  assert.match(card.prompt, /对白／音效：@?张浩【平静】\(OS\) ：“别回头。”/u)
  assert.doesNotThrow(() => assertScriptVideoCards({ script: '张浩(OS)：“别回头。”', assets, cards: [card] }))
})

test('execution checks accept natural speech instructions without parsing their meaning', () => {
  const card = sample()
  card.shots[0].action = '甲说“我永远不会回来。”'
  assert.ok(validate(render(card)).some(issue => issue.code === 'PROMPT_DIALOGUE_NEW'))
})

test('execution checks accept unattributed quoted sound text', () => {
  const card = sample()
  card.prompt = card.prompt.replace('对白／音效：甲：“我回来了。”', '对白／音效：甲：“我回来了。”；“我永远不会回来。”')
  assert.ok(validate(card).some(issue => issue.code === 'PROMPT_DIALOGUE_NEW'))
})

test('execution checks do not enforce semantic segment assignment', () => {
  const card = sample()
  card.shots[0].action = '甲站在门口，甲说：“明天出发。”'
  assert.doesNotThrow(() => assertScriptVideoCards({
    script: script + '\n甲：“明天出发。”', assets: [], cards: [render(card)], scope: 'card',
  }))
})

test('quoted foley and acting notes after speech do not create another spoken line', () => {
  const card = sample()
  card.shots[0].dialogue = '甲【重音在“回”字】：“我回来了。”；门轴发出“吱呀”的轻响。'
  assert.doesNotThrow(() => validate(render(card)))
})
