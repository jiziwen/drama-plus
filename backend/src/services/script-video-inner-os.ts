import { mapScriptVideoSoundLine, speechClosers } from './script-video-foley.js'

export const SCRIPT_VIDEO_INNER_OS_DIRECTION = '（内心 OS，角色闭口，嘴唇不动，不对口型）'
const bareOs = /(?:内心(?:独白|声|[ \t]*O\.?S\.?)?|心声|(?:^|[ \t])O\.?S\.?)[ \t]*$/iu
const cueOs = /(?:^|[ \t，,、；;／/])(?:内心(?:独白|声|[ \t]*O\.?S\.?)?|心声|O\.?S\.?)(?=$|[ \t，,、；;／/])/iu
const simpleOs = /^(?:内心(?:独白|声|[ \t]*O\.?S\.?)?|心声|O\.?S\.?)$/iu
const aside = /（[^）\r\n]*）|\([^)\r\n]*\)|【[^】\r\n]*】|\[[^\]\r\n]*\]/gu
const speaker = /^([ \t]*@?[\p{L}\p{N}·・、_ /／-]{1,120})((?:[ \t]*(?:（[^）\r\n]*）|\([^)\r\n]*\)|【[^】\r\n]*】|\[[^\]\r\n]*\]))*)[ \t]*(?=[：:])/u
const soundHeading = /^[ \t]*(?:对白[ \t]*[／/][ \t]*音效|对白|台词|画外音)[ \t]*[：:][ \t]*/u
const quotedOrSeparator = /“[^”\r\n]*(?:”|$)|「[^」\r\n]*(?:」|$)|『[^』\r\n]*(?:』|$)|"[^"\r\n]*(?:"|$)|\{[^}\r\n]*(?:\}|$)|（[^）\r\n]*）|\([^)\r\n]*\)|【[^】\r\n]*】|\[[^\]\r\n]*\]|[；;]/gu

export function hasScriptVideoInnerOs(attribution: string): boolean {
  const label = attribution.normalize('NFKC').replace(/[：:][ \t]*$/u, '')
  return bareOs.test(label.replace(aside, '')) ||
    Array.from(label.matchAll(aside)).some(match => cueOs.test(match[0].slice(1, -1)))
}

function annotateSpeaker(clause: string, knownSpeakers: ReadonlySet<string>): string {
  const match = speaker.exec(clause)
  if (!match || match[0].includes(SCRIPT_VIDEO_INNER_OS_DIRECTION)) return clause
  const knownName = knownSpeakers.has(match[1].trim().replace(/^@/u, ''))
  const baseName = match[1].replace(bareOs, '')
  // Bare Chinese suffixes may be part of a literal name. Only an established
  // base character or an explicit Latin OS label identifies a removable suffix;
  // bracketed voice cues never authorize truncating an otherwise unknown name.
  const removableSuffix = !knownName && (
    knownSpeakers.has(baseName.trim().replace(/^@/u, '')) ||
    /(?:^|[ \t])O\.?S\.?[ \t]*$/iu.test(match[1])
  )
  if (!hasScriptVideoInnerOs(match[2]) &&
      !(removableSuffix && hasScriptVideoInnerOs(match[1]))) return clause
  const name = (removableSuffix ? baseName : match[1]).trimEnd()
  const cues = match[2].replace(aside, cue =>
    simpleOs.test(cue.slice(1, -1).trim().normalize('NFKC')) ? '' : cue)
  return name + cues + SCRIPT_VIDEO_INNER_OS_DIRECTION + clause.slice(match[0].length)
}

/** Add performance instructions to the speaker label. Quoted speech and the
 * original delimiter between different lines in the same shot are preserved. */
export function annotateScriptVideoInnerOs(
  prompt: string,
  options: { protectedPrefix?: string; speakers?: readonly string[] } = {},
): string {
  const { protectedPrefix, speakers } = options
  const knownSpeakers = new Set(speakers)
  for (const name of speakers ?? []) {
    const baseName = name.split('_', 1)[0].trim()
    if (baseName) knownSpeakers.add(baseName)
  }
  const start = protectedPrefix && prompt.startsWith(protectedPrefix) ? protectedPrefix.length : 0
  return prompt.slice(0, start) + prompt.slice(start).replace(/[^\r\n]+/gu, line => {
    const heading = soundHeading.exec(line)?.[0] || ''
    return heading + mapScriptVideoSoundLine(line.slice(heading.length), body => {
      const first = speaker.exec(body)
      if (!heading && (!first || !hasScriptVideoInnerOs(first[0]) &&
          !/^[：:][ \t]*[“「『"{]/u.test(body.slice(first[0].length)))) return body
      let result = '', cursor = 0
      for (const match of body.matchAll(quotedOrSeparator)) {
        const token = match[0]
        if (token !== '；' && token !== ';' && !(token.length > 1 && speechClosers[token[0]] === token.at(-1))) continue
        const end = match.index + token.length
        const separator = /^[ \t，,。.!！？?]*/u.exec(body.slice(end))![0]
        result += annotateSpeaker(body.slice(cursor, end), knownSpeakers) + separator
        cursor = end + separator.length
      }
      return result + annotateSpeaker(body.slice(cursor), knownSpeakers)
    })
  })
}
