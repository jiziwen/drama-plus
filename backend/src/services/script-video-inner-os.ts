import { mapScriptVideoSoundLine, scriptVideoInlineVoiceCue, scriptVideoNamedAudioCue, speechClosers } from './script-video-foley.js'

export const SCRIPT_VIDEO_INNER_OS_DIRECTION = '(OS)'
const legacyDirection = '（内心 OS，角色闭口，嘴唇不动，不对口型）'
type InnerOsOptions = { protectedPrefix?: string; speakers?: readonly string[]; referenceAudioNames?: readonly string[] }
const bareOs = /(?:内心(?:独白|声|[ \t]*O\.?S\.?)?|心声|(?:^|[ \t])O\.?S\.?)[ \t]*$/iu
const cueOs = /(?:^|[ \t，,、；;／/])(?:内心(?:独白|声|[ \t]*O\.?S\.?)?|心声|O\.?S\.?)(?=$|[ \t，,、；;／/])/iu
const simpleOs = /^(?:内心(?:独白|声|[ \t]*O\.?S\.?)?|心声|O\.?S\.?)$/iu
const legacyOsDirection = /^内心[ \t]*O\.?S\.?[ \t]*[,，][ \t]*角色闭口[ \t]*[,，][ \t]*嘴唇不动[ \t]*[,，][ \t]*不对口型$/iu
const aside = /（[^）\r\n]*）|\([^)\r\n]*\)|【[^】\r\n]*】|\[[^\]\r\n]*\]/gu
function osSpeaker(audioCue = '') {
  const cues = audioCue ? scriptVideoInlineVoiceCue.source + '|[ \\t]*' + audioCue : scriptVideoInlineVoiceCue.source
  return new RegExp(/^([ \t]*@?[\p{L}\p{N}·・、_ /／-]{1,120})/u.source + '(' + cues + ')?' +
    /((?:[ \t]*(?:（[^）\r\n]*）|\([^)\r\n]*\)|【[^】\r\n]*】|\[[^\]\r\n]*\]))*)[ \t]*(?=[：:])/u.source, 'u')
}
const defaultSpeaker = osSpeaker()
const soundHeading = /^[ \t]*(?:对白[ \t]*[／/][ \t]*音效|对白|台词|画外音)[ \t]*[：:][ \t]*/u
const quotedOrSeparator = /“[^”\r\n]*(?:”|$)|「[^」\r\n]*(?:」|$)|『[^』\r\n]*(?:』|$)|"[^"\r\n]*(?:"|$)|\{[^}\r\n]*(?:\}|$)|（[^）\r\n]*）|\([^)\r\n]*\)|【[^】\r\n]*】|\[[^\]\r\n]*\]|[；;]/gu

export function hasScriptVideoInnerOs(attribution: string): boolean {
  const label = attribution.normalize('NFKC').replace(/[：:][ \t]*$/u, '')
  return bareOs.test(label.replace(aside, '')) ||
    Array.from(label.matchAll(aside)).some(match => cueOs.test(match[0].slice(1, -1)))
}

function annotateSpeaker(clause: string, knownSpeakers: ReadonlySet<string>, speaker: RegExp, legacy = false): string {
  const match = speaker.exec(clause)
  if (!match) return clause
  const [, label, voice = '', directions] = match
  const knownName = knownSpeakers.has(label.trim().replace(/^@/u, ''))
  const baseName = label.replace(bareOs, '')
  // Bare Chinese suffixes may be part of a literal name. Only an established
  // base character or an explicit Latin OS label identifies a removable suffix;
  // bracketed voice cues never authorize truncating an otherwise unknown name.
  const removableSuffix = !knownName && (
    knownSpeakers.has(baseName.trim().replace(/^@/u, '')) ||
    /(?:^|[ \t])O\.?S\.?[ \t]*$/iu.test(label)
  )
  if (!hasScriptVideoInnerOs(directions) &&
      !(removableSuffix && hasScriptVideoInnerOs(label))) return clause
  const name = (removableSuffix ? baseName : label).trimEnd()
  const cues = directions.replace(aside, cue => {
    const body = cue.slice(1, -1).trim().normalize('NFKC')
    return simpleOs.test(body) || legacyOsDirection.test(body) ? '' : cue
  }).trimEnd()
  const words = clause.slice(match[0].length)
  return name + (voice ? ' ' + voice.trimStart() : '') + cues + (legacy
    ? legacyDirection + words
    : SCRIPT_VIDEO_INNER_OS_DIRECTION + words.replace(/^[：:][ \t]*/u, ' ：'))
}

/** Normalize inner speech to a short OS label. Quoted speech and the
 * original delimiter between different lines in the same shot are preserved. */
export function annotateScriptVideoInnerOs(
  prompt: string,
  options: InnerOsOptions = {},
): string {
  return formatInnerOs(prompt, options)
}

/** Reproduce pre-compaction fingerprints for renders that are already running.
 * This representation is never displayed or sent in a new generation request. */
export function legacyScriptVideoInnerOs(prompt: string, options: InnerOsOptions = {}): string {
  return formatInnerOs(prompt, options, true)
}

function formatInnerOs(
  prompt: string, options: InnerOsOptions, legacy = false,
): string {
  const { protectedPrefix, speakers } = options
  const audioCue = options.referenceAudioNames?.length ? scriptVideoNamedAudioCue(options.referenceAudioNames) : ''
  const speaker = audioCue ? osSpeaker(audioCue) : defaultSpeaker
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
        result += annotateSpeaker(body.slice(cursor, end), knownSpeakers, speaker, legacy) + separator
        cursor = end + separator.length
      }
      return result + annotateSpeaker(body.slice(cursor), knownSpeakers, speaker, legacy)
    })
  })
}
