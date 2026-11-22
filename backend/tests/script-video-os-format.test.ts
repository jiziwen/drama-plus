import assert from 'node:assert/strict'
import test from 'node:test'
import { annotateScriptVideoInnerOs, hasScriptVideoInnerOs, legacyScriptVideoInnerOs } from '../src/services/script-video-inner-os'

const legacy = '（内心 OS，角色闭口，嘴唇不动，不对口型）'
const name = '@顾凌天_青布长衫'
const cues = '【画外只闻心声／低沉冷淡／短促】'
const options = { speakers: ['顾凌天_青布长衫'] }

test('全局 OS 用简短标记保留表演、音频、音效和对白原话', () => {
  const input = `对白／音效：两下干脆的木门叩响。${name} @音频2${cues}${legacy}：“进来！”`
  const expected = `对白／音效：两下干脆的木门叩响。${name} @音频2${cues}(OS) ：“进来！”`
  assert.equal(annotateScriptVideoInnerOs(input, options), expected)
  assert.equal(annotateScriptVideoInnerOs(expected, options), expected)
})

test('所有心声别写法统一为短 OS，保留角色名和其他表演要求', () => {
  for (const marker of ['(OS)', '（OS）', '（内心 OS）', '【心声】', legacy]) {
    assert.equal(annotateScriptVideoInnerOs(`${name}${marker}【低沉】：“别动。”`, options),
      `${name}【低沉】(OS) ：“别动。”`)
  }
  assert.equal(annotateScriptVideoInnerOs('顾凌天内心独白：“别动。”', options), '顾凌天(OS) ：“别动。”')
})

test('普通对白、OV、台词中的 OS 字样及角色名不被改写', () => {
  const input = `对白／音效：${name}【低沉】：“他说${legacy}。”；系统面板(OV)：“收到。”；林心声：“门开了。”`
  assert.equal(annotateScriptVideoInnerOs(input, { speakers: [...options.speakers, '林心声'] }), input)
  assert.equal(hasScriptVideoInnerOs(`${name}(OS)`), true)
  assert.equal(hasScriptVideoInnerOs(`${name}${legacy}`), true)
})

test('同一行多段 OS 分别规范，风格前缀与原文换行保持不变', () => {
  const prefix = `风格原文 ${name}${legacy}：“文字。”\r\n\r\n`
  const body = `对白／音效：${name}${legacy}：“甲。”；${name}(OS)：“乙。”\r\n对白：${name}：“丙。”`
  const output = annotateScriptVideoInnerOs(prefix + body, { ...options, protectedPrefix: prefix })
  assert.equal(output, prefix + `对白／音效：${name}(OS) ：“甲。”；${name}(OS) ：“乙。”\r\n对白：${name}：“丙。”`)
})

test('旧任务摘要单独保留旧序列化，不能修改台词里的短标记', () => {
  const input = `对白／音效：${name}${cues}(OS) ：“台词里保留(OS)。”`
  assert.equal(legacyScriptVideoInnerOs(input, options), `对白／音效：${name}${cues}${legacy}：“台词里保留(OS)。”`)
  assert.equal(annotateScriptVideoInnerOs(input, options), input)
})
