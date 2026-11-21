const speakerWithCues = /@?[\p{L}\p{N}·・_. /／-]+(?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*/u
export const unquotedSpeaker = new RegExp('^\\s*' + speakerWithCues.source + '(?:\\s*、\\s*' + speakerWithCues.source + ')*\\s*[:：]\\s*', 'u')
export const speechClosers: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', '{': '}' }
export const scriptVideoSpeechQuote = /“[^”\n]*”?|「[^」\n]*」?|『[^』\n]*』?|"[^"\n]*"?|\{[^}\n]*\}?/u

// Tokenize complete quotes and brackets so punctuation and names inside a cue
// cannot start another turn. Positions always refer to the original line.
const soundTokens = new RegExp('(?<speech>' + scriptVideoSpeechQuote.source + ')|' +
  /(?<bracket>〈[^〉\n]*〉|<[^>\n]*>|《[^》\n]*》|（[^）\n]*）|\([^)\n]*\)|【[^】\n]*】|\[[^\]\n]*\])|(?<label>(?:物理音效|背景音效|音效|环境音|环境声|背景音|动作音|拟音|音乐|配乐|BGM|SFX)[ \t]*[:：])|(?<pause>[；;，,。.!！？?])/u.source, 'giu')

export function scriptVideoNextTurnStart(line: string, end: number) {
  return end + /^[ \t；;，,。.!！？?]*/u.exec(line.slice(end))![0].length
}

export function scriptVideoFoleyCues(line: string) {
  const cues: Array<{ start: number; end: number }> = []
  let boundary = 0, previousEnd = 0, namedStart: number | undefined
  // A generated voice tag can contain the same closing bracket as the
  // surrounding effect. Keep offsets when rescanning a provider's final text.
  const scan = line.includes('音色参考') ? line.replace(/（音色参考(?:@?音频\d+|<Audio \d+>)）/gu, tag => '·'.repeat(tag.length)) : line
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
      const rest = line.slice(end)
      const nextLabel = unquotedSpeaker.exec(rest)
      if (separator || nextLabel && /^[“「『"{]/u.test(rest.slice(nextLabel[0].length))) {
        cues.push({ start: namedStart, end: separator ? start : end })
        namedStart = undefined
        boundary = end
      }
    } else if (label && atBoundary) {
      namedStart = start
      boundary = end
    } else if (closedQuote || pause && (atBoundary || /[；;]/u.test(pause))) {
      boundary = end
    }
  }
  if (namedStart !== undefined) cues.push({ start: namedStart, end: line.length })
  return cues.map(cue => ({ ...cue, next: scriptVideoNextTurnStart(line, cue.end) }))
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
