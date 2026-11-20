import assert from 'node:assert/strict'
import test from 'node:test'
import type { AssetMention } from '../../backend/src/services/script-video-mentions'
import { editScriptVideoPromptVoiceView, scriptVideoPromptVoiceView } from '../app/utils/scriptVideoPromptVoiceView'

function mention(source: string, name: string, occurrence: number, usage: AssetMention['usage'], spoken = false): AssetMention {
  let start = -1
  for (let i = 0; i <= occurrence; i++) start = source.indexOf(name, start + 1)
  assert.ok(start >= 0)
  return { id: 'lead', name, start, end: start + name.length, usage, spoken, literal: !name.startsWith('@'), explicit: name.startsWith('@') }
}

test('audio cue projection follows each speaker reference while preserving action and spoken text', () => {
  const source = '🎬 画面：@阿梨抬手。\n对白：@阿梨（低声）：“阿梨回来了。”\n心声：@阿梨：“终于。”'
  const name = '@阿梨'
  const mentions = [
    mention(source, name, 0, 'visual'),
    mention(source, name, 1, 'speaker'),
    mention(source, '阿梨', 2, 'speaker', true),
    mention(source, name, 2, 'speaker'),
  ]
  const view = scriptVideoPromptVoiceView(source, mentions, new Map([['lead', 2]]))
  assert.equal(view.text, '🎬 画面：@阿梨抬手。\n对白：@阿梨（音色参考@音频2）（低声）：“阿梨回来了。”\n心声：@阿梨（音色参考@音频2）：“终于。”')
  for (const cue of view.cues) {
    assert.equal(view.text.slice(cue.tokenStart, cue.tokenEnd), '@音频2')
    assert.equal(view.displayOffset(cue.sourceOffset, true), cue.start)
    assert.equal(view.displayOffset(cue.sourceOffset), cue.end)
    assert.equal(view.sourceOffset(cue.tokenStart), cue.sourceOffset)
  }
  assert.equal(view.sourceOffset(view.text.length), source.length)
})

test('typing or replacing adjacent authored text maps the caret and drops the generated cues before saving', () => {
  const source = '对白：@阿梨：“真的。”\n对白：@阿梨：“终于。”'
  const mentions = [mention(source, '@阿梨', 0, 'speaker'), mention(source, '@阿梨', 1, 'speaker')]
  const view = scriptVideoPromptVoiceView(source, mentions, new Map([['lead', 1]]))

  const nearFirstCue = view.cues[0].end
  const added = '（轻声）'
  const after = view.text.slice(0, nearFirstCue) + added + view.text.slice(nearFirstCue)
  const edit = editScriptVideoPromptVoiceView(view, after, nearFirstCue + added.length, nearFirstCue + added.length)
  assert.equal(edit.text, '对白：@阿梨（轻声）：“真的。”\n对白：@阿梨：“终于。”')
  assert.equal(edit.selectionStart, source.indexOf('：“') + added.length)
  assert.equal(edit.selectionEnd, edit.selectionStart)

  const replaceStart = view.text.indexOf('真的')
  const replaceEnd = view.text.indexOf('终于')
  const replacement = '回来了。'
  const next = view.text.slice(0, replaceStart) + replacement + view.text.slice(replaceEnd)
  const replaced = editScriptVideoPromptVoiceView(view, next, replaceStart + replacement.length, replaceStart + replacement.length)
  assert.equal(replaced.text, '对白：@阿梨：“回来了。终于。”')
  assert.equal(replaced.selectionStart, replaced.text.indexOf('终于'))
})

test('the displayed audio number is derived and cannot become an authored asset reference', () => {
  const source = '对白：@阿梨：“真的。”'
  const view = scriptVideoPromptVoiceView(source, [mention(source, '@阿梨', 0, 'speaker')], new Map([['lead', 1]]))
  const { tokenEnd, sourceOffset } = view.cues[0]
  const next = view.text.slice(0, tokenEnd - 1) + '9' + view.text.slice(tokenEnd)
  const edit = editScriptVideoPromptVoiceView(view, next, tokenEnd, tokenEnd)
  assert.equal(edit.text, source)
  assert.equal(edit.selectionStart, sourceOffset)
})
