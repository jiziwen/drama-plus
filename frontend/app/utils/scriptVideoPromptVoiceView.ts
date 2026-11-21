import type { AssetMention } from '../../../backend/src/services/script-video-mentions'

type VoiceCue = { sourceOffset: number; start: number; end: number; tokenStart: number; tokenEnd: number; index: number }
const generatedCue = /（音色参考@音频\d+）/gu
const withoutCues = (text: string) => text.replace(generatedCue, '')

export function scriptVideoPromptVoiceView(source: string, mentions: readonly AssetMention[], audioIndexByRole: ReadonlyMap<string, number>) {
  let text = ''
  let cursor = 0
  const cues: VoiceCue[] = []
  for (const hit of mentions) {
    const index = audioIndexByRole.get(hit.id)
    if (!index || hit.usage !== 'speaker' || (hit.spoken && !hit.vocalization)) continue
    const label = `@音频${index}`
    const prefix = '（音色参考'
    text += source.slice(cursor, hit.end)
    const start = text.length
    const tokenStart = start + prefix.length
    text += prefix + label + '）'
    cues.push({ sourceOffset: hit.end, start, end: text.length, tokenStart, tokenEnd: tokenStart + label.length, index })
    cursor = hit.end
  }
  text += source.slice(cursor)
  const sourceOffset = (position: number) => cues.reduce((offset, cue) =>
    offset - Math.max(0, Math.min(position, cue.end) - cue.start), position)
  const displayOffset = (position: number, beforeCue = false) => cues.reduce((offset, cue) =>
    offset + (cue.sourceOffset < position || cue.sourceOffset === position && !beforeCue ? cue.end - cue.start : 0), position)
  return { text, source, cues, sourceOffset, displayOffset }
}

/** Apply the edit to authored text, keeping automatically numbered references out of saved prompts. */
export function editScriptVideoPromptVoiceView(view: ReturnType<typeof scriptVideoPromptVoiceView>, next: string, selectionStart: number, selectionEnd: number) {
  let start = 0
  let oldEnd = view.text.length
  let newEnd = next.length
  while (start < oldEnd && start < newEnd && view.text[start] === next[start]) start++
  while (oldEnd > start && newEnd > start && view.text[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const sourceStart = view.sourceOffset(start)
  const sourceEnd = view.sourceOffset(oldEnd)
  const withinCue = view.cues.some(cue => start > cue.start && oldEnd < cue.end)
  const insert = withinCue ? '' : withoutCues(next.slice(start, newEnd))
  const positionInSource = (position: number) => {
    if (position <= start) return view.sourceOffset(position)
    if (position < newEnd) return sourceStart + (withinCue ? 0 : withoutCues(next.slice(start, position)).length)
    return sourceStart + insert.length + view.sourceOffset(position - newEnd + oldEnd) - sourceEnd
  }
  return {
    text: view.source.slice(0, sourceStart) + insert + view.source.slice(sourceEnd),
    selectionStart: positionInSource(selectionStart),
    selectionEnd: positionInSource(selectionEnd),
    beforeCue: start === oldEnd && view.cues.some(cue => start === cue.start),
  }
}
