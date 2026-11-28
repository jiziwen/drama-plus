const numberedVoice = /(?:@?音频\d+|<Audio \d+>)(?!\d)/u
export const scriptVideoInlineVoiceCue = new RegExp('[ \\t]+' + numberedVoice.source, 'u')
export function scriptVideoNamedAudioCue(names: readonly string[]) {
  const alternatives = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&'))
  return alternatives.length ? '@(?:' + alternatives.join('|') + ')(?![A-Za-z0-9_-])' : ''
}
const legacyVoice = new RegExp('（音色参考' + numberedVoice.source + '）', 'u')
const voiceCue = new RegExp(legacyVoice.source + '|' + scriptVideoInlineVoiceCue.source, 'gu')
export const scriptVideoPerformanceBracket = /（[^）\n]*）|\([^)\n]*\)|【[^】\n]*】|\[[^\]\n]*\]/u
export const scriptVideoSpeakerLabel = /(?:[\p{L}\p{N}·・_. /／-]{0,120}@)?[\p{L}\p{N}·・_. /／-]{1,120}?/u
export const scriptVideoSpeakerSeparator = /[ \t]*(?:、|[和与及跟](?=[ \t]*@))[ \t]*/u
const speakerWithCues = new RegExp(scriptVideoSpeakerLabel.source + '(?:' + scriptVideoInlineVoiceCue.source + ')?' +
  '(?:\\s*(?:' + scriptVideoPerformanceBracket.source + '))*', 'u')
export const unquotedSpeaker = new RegExp('^\\s*' + speakerWithCues.source + '(?:' + scriptVideoSpeakerSeparator.source +
  speakerWithCues.source + ')*\\s*[:：]\\s*', 'u')
export const speechClosers: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', '{': '}' }
export const scriptVideoSpeechQuote = /“[^”\n]*”?|「[^」\n]*」?|『[^』\n]*』?|"[^"\n]*"?|\{[^}\n]*\}?/u
const performanceTokens = new RegExp(scriptVideoSpeechQuote.source + '|(?<direction>' + scriptVideoPerformanceBracket.source + ')', 'gu')
const effectLabel = /(?:物理音效|背景音效|音效|环境音|环境声|背景音|动作音|拟音|音乐|配乐|BGM|SFX)[ \t]*[:：]/iu
const standaloneEffectPrefix = new RegExp('^\\s*' + effectLabel.source + '\\s*$', 'iu')

// Tokenize complete quotes and brackets so punctuation and names inside a cue
// cannot start another turn. Positions always refer to the original line.
const soundTokens = new RegExp('(?<speech>' + scriptVideoSpeechQuote.source + ')|' +
  '(?<bracket>' + /〈[^〉\n]*〉|<[^>\n]*>|《[^》\n]*》/u.source + '|' + scriptVideoPerformanceBracket.source +
  ')|(?<label>' + effectLabel.source + ')|(?<pause>[；;，,。.!！？?])', 'giu')

export function scriptVideoNextTurnStart(line: string, end: number) {
  return end + /^[ \t；;，,。.!！？?]*/u.exec(line.slice(end))![0].length
}

export function withoutScriptVideoVoiceCues(text: string) {
  return text.replace(voiceCue, '')
}

function startsQuotedTurn(text: string) {
  const label = unquotedSpeaker.exec(text)
  return !!label && /^[“「『"{]/u.test(text.slice(label[0].length))
}

export function scriptVideoFoleyCues(line: string) {
  const cues: Array<{ start: number; end: number }> = []
  let boundary = 0, previousEnd = 0, namedStart: number | undefined
  // A generated voice tag can contain the same closing bracket as the
  // surrounding effect. Keep offsets when rescanning a provider's final text.
  const scan = line.replace(voiceCue, tag => '·'.repeat(tag.length))
  for (const token of scan.matchAll(soundTokens)) {
    const start = token.index!, end = start + token[0].length
    const { speech, bracket, label, pause } = token.groups!
    const atBoundary = previousEnd === boundary && !line.slice(boundary, start).trim()
    previousEnd = end
    const closedQuote = speech && speech.length > 1 && speech.at(-1) === speechClosers[speech[0]]
    if (atBoundary && (bracket && !/^<(?:Picture|Audio)\s*\d+>$/iu.test(bracket) || namedStart !== undefined && closedQuote)) {
      cues.push({ start: namedStart ?? start, end })
      namedStart = undefined
      boundary = end
    } else if (namedStart !== undefined) {
      if (!pause) continue
      const separator = /[；;]/u.test(pause)
      if (separator || startsQuotedTurn(line.slice(end))) {
        cues.push({ start: namedStart, end: separator ? start : end })
        namedStart = undefined
        boundary = end
      }
    } else if (label && atBoundary) {
      namedStart = start
      boundary = end
    } else if (pause && /[。.!！？?]/u.test(pause) && !atBoundary &&
      !unquotedSpeaker.test(line.slice(boundary, start)) && startsQuotedTurn(line.slice(end))) {
      // A complete, unlabeled sound description can stand before an attributed line.
      cues.push({ start: boundary, end })
      boundary = end
    } else if (closedQuote || pause && (atBoundary || /[；;]/u.test(pause))) {
      boundary = end
    }
  }
  if (namedStart !== undefined) cues.push({ start: namedStart, end: line.length })
  return cues.map(cue => ({ ...cue, next: scriptVideoNextTurnStart(line, cue.end) }))
}

/** Parentheses on an attribution describe its delivery. The same brackets can
 * also enclose a standalone sound effect and its actual vocal subject. */
export function scriptVideoPerformanceDirections(line: string, effects = scriptVideoFoleyCues(line)) {
  const ranges: Array<{ start: number; end: number }> = []
  for (const token of line.matchAll(performanceTokens)) {
    if (!token.groups?.direction) continue
    const start = token.index!, end = start + token[0].length
    const standalone = effects.some(effect => effect.end === end && (effect.start === start ||
      effect.start < start && standaloneEffectPrefix.test(line.slice(effect.start, start))))
    if (!standalone) ranges.push({ start, end })
  }
  return ranges
}

export function mapScriptVideoSoundLine(
  line: string, dialogue: (text: string) => string, effect: (text: string) => string = text => text,
) {
  let result = '', cursor = 0
  for (const cue of scriptVideoFoleyCues(line)) {
    if (cursor < cue.start) result += dialogue(line.slice(cursor, cue.start))
    result += effect(line.slice(cue.start, cue.end))
    result += line.slice(cue.end, cue.next)
    cursor = cue.next
  }
  return cursor < line.length ? result + dialogue(line.slice(cursor)) : result
}
