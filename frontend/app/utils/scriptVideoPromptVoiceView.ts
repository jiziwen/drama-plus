import type { AssetMention } from '../../../backend/src/services/script-video-mentions'

type VoiceCue = { sourceStart: number; sourceEnd: number; start: number; end: number; tokenStart: number; tokenEnd: number; index: number }
const generatedCue = /（音色参考@音频\d+）|[ \t]+@音频\d+(?!\d)/gu
const withoutCues = (text: string) => text.replace(generatedCue, '')

export function scriptVideoPromptVoiceView(source: string, mentions: readonly AssetMention[], audioIndexByAsset: ReadonlyMap<string, number>) {
  let text = ''
  let cursor = 0
  const cues: VoiceCue[] = []
  for (const hit of mentions) {
    const index = audioIndexByAsset.get(hit.id)
    const manual = hit.usage === 'audio'
    if (!index || !manual && (hit.usage !== 'speaker' || hit.manualAudioId || hit.spoken && !hit.vocalization)) continue
    const sourceStart = manual ? hit.start : hit.end
    text += source.slice(cursor, sourceStart)
    const start = text.length
    const tokenStart = start + (manual ? 0 : 1)
    text += (manual ? '' : ' ') + `@音频${index}`
    cues.push({ sourceStart, sourceEnd: hit.end, start, end: text.length, tokenStart, tokenEnd: text.length, index })
    cursor = hit.end
  }
  text += source.slice(cursor)
  function sourceOffset(position: number) {
    let offset = position
    for (const cue of cues) {
      if (position < cue.start) break
      if (position < cue.end) return cue.sourceStart + Math.min(position - cue.start, cue.sourceEnd - cue.sourceStart)
      offset += cue.sourceEnd - cue.sourceStart - (cue.end - cue.start)
    }
    return offset
  }
  function displayOffset(position: number, beforeCue = false) {
    let offset = position
    for (const cue of cues) {
      if (position < cue.sourceStart || position === cue.sourceStart && beforeCue) break
      if (position < cue.sourceEnd) return cue.start + Math.min(position - cue.sourceStart, cue.end - cue.start)
      offset += (cue.end - cue.start) - (cue.sourceEnd - cue.sourceStart)
    }
    return offset
  }
  return { text, source, cues, sourceOffset, displayOffset }
}

/** Apply the edit to authored text, keeping automatically numbered references out of saved prompts. */
export function editScriptVideoPromptVoiceView(
  view: ReturnType<typeof scriptVideoPromptVoiceView>, next: string, selectionStart: number, selectionEnd: number,
  previousSelection?: { selectionStart: number; selectionEnd: number },
) {
  let start = 0
  let oldEnd = view.text.length
  let newEnd = next.length
  const from = previousSelection?.selectionStart ?? 0
  const to = previousSelection?.selectionEnd ?? from
  // A replacement can begin with the same @ as the selected reference.
  const suffix = view.text.slice(to)
  if (from < to && next.length >= from + suffix.length && next.startsWith(view.text.slice(0, from)) && next.endsWith(suffix)) {
    start = from
    oldEnd = to
    newEnd -= suffix.length
  } else {
    while (start < oldEnd && start < newEnd && view.text[start] === next[start]) start++
    while (oldEnd > start && newEnd > start && view.text[oldEnd - 1] === next[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
  }
  const leadingCue = view.cues.find(cue => cue.start < start && start < cue.end)
  const trailingCue = view.cues.find(cue => cue.start < oldEnd && oldEnd < cue.end)
  const withinCue = leadingCue && oldEnd <= leadingCue.end &&
    (leadingCue.sourceStart === leadingCue.sourceEnd || oldEnd === start)
  const sourceStart = withinCue ? view.sourceOffset(start) : leadingCue?.sourceStart ?? view.sourceOffset(start)
  const sourceEnd = withinCue ? sourceStart : trailingCue?.sourceEnd ?? view.sourceOffset(oldEnd)
  const insert = withinCue ? '' : withoutCues(next.slice(start, newEnd))
  const positionInSource = (position: number) => {
    if (position < start) return view.sourceOffset(position)
    if (position === start) return sourceStart
    if (position < newEnd) return sourceStart + (withinCue ? 0 : withoutCues(next.slice(start, position)).length)
    return sourceStart + insert.length + Math.max(0, view.sourceOffset(position - newEnd + oldEnd) - sourceEnd)
  }
  return {
    text: view.source.slice(0, sourceStart) + insert + view.source.slice(sourceEnd),
    selectionStart: positionInSource(selectionStart),
    selectionEnd: positionInSource(selectionEnd),
    beforeCue: start === oldEnd && view.cues.some(cue => start === cue.start),
  }
}
