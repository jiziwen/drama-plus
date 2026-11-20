// Only explicit pause cues are non-spoken inside a dialogue quotation. Other
// parenthesized content and quoted mentions of the cues remain literal speech.
const pauseCue = /（[ \t]*(?:微顿|停顿)[ \t]*）|\([ \t]*(?:微顿|停顿)[ \t]*\)/gu
const literalQuote = /“[^”\r\n]*(?:”|$)|‘[^’\r\n]*(?:’|$)|「[^」\r\n]*(?:」|$)|『[^』\r\n]*(?:』|$)|"[^"\r\n]*"|'[^'\r\n]*'/gu
const punctuation = /[\s“”‘’「」『』"',.，。；;、！？!?…：:]/u

function pauseRanges(text: string) {
  const literals = [...text.matchAll(literalQuote)].map(match => ({
    start: match.index!, end: match.index! + match[0].length,
  }))
  // A continued shot/remaining queue may start inside an existing quotation.
  // Its unmatched closing delimiter still identifies the preceding literal text.
  for (const [open, close] of [['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』']]) {
    const closing = text.indexOf(close), opening = text.indexOf(open)
    if (closing >= 0 && (opening < 0 || closing < opening))
      literals.push({ start: 0, end: closing + close.length })
  }
  return [...text.matchAll(pauseCue)].filter(match => !literals.some(range =>
    range.start <= match.index! && range.end >= match.index! + match[0].length,
  )).map(match => ({ start: match.index!, end: match.index! + match[0].length }))
}

export function withoutScriptVideoPauseCues(text: string): string {
  let start = 0
  let result = ''
  for (const range of pauseRanges(text)) {
    result += text.slice(start, range.start)
    start = range.end
  }
  return result + text.slice(start)
}

/** Each spoken UTF-16 unit maps to its original position. Comparison, dialogue
 * boundaries and checkpoint slicing therefore share exactly the same cursor. */
export function projectScriptVideoSpokenText(text: string) {
  const ranges = pauseRanges(text)
  const rawOffsets: number[] = []
  let spoken = ''
  let rangeIndex = 0
  for (let index = 0; index < text.length; index++) {
    const range = ranges[rangeIndex]
    if (range && index === range.start) {
      index = range.end - 1
      rangeIndex++
      continue
    }
    if (punctuation.test(text[index])) continue
    spoken += text[index]
    rawOffsets.push(index)
  }
  return { text: spoken, rawOffsets }
}

export function scriptVideoSpokenText(text: string): string {
  return projectScriptVideoSpokenText(text).text
}
