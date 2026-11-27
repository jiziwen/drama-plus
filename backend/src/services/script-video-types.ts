import { z } from 'zod'
import type { ScriptVideoDialogueBoundary } from './script-video-speech-planning.js'
import { isScriptVideoStylePreset, type ScriptVideoStylePreset } from './script-video-style.js'
export type { ScriptVideoStylePreset } from './script-video-style.js'
import { omitScriptVideoRecapQuotes, replaceScriptVideoPromptStyle } from './script-video-format.js'
import { hasScriptVideoInnerOs } from './script-video-inner-os.js'
import { projectScriptVideoSpokenText, scriptVideoSpokenText, withoutScriptVideoPauseCues } from './script-video-spoken-text.js'
import { parseScriptVideoPromptDialogue } from './script-video-prompt-dialogue.js'
import { getScriptVideoSceneContinuityIssues } from './script-video-scene-continuity.js'
import { annotateScriptVideoAssets, describeScriptVideoReferenceProblem } from './script-video-mentions.js'
import type { ScriptVideoAssetBindingRequirement, ScriptVideoAssetOccurrence } from './script-video-asset-scenes.js'
import type { ScriptVideoReferenceSettings } from './script-video-reference-settings.js'
import type { ScriptVideoStoryboardMode } from './script-video-storyboard-mode.js'

export type ScriptVideoVoiceAudio = {
  url: string
  name: string
  mimeType?: string
  duration?: number
}
export type ScriptVideoVoiceMode = 'model' | 'reference'
export const scriptVideoVoiceDescriptionSchema = z.strictObject({
  text: z.string().trim().min(1).max(500),
  sourceLabel: z.string().trim().min(1).max(120).optional(),
})
export type ScriptVideoVoiceDescription = z.infer<typeof scriptVideoVoiceDescriptionSchema>
export const scriptVideoAssetImageStatuses = ['pending', 'generating', 'completed', 'failed', 'delivery_pending'] as const
export type ScriptVideoAssetImageFields = {
  imagePrompt?: string
  imageStatus?: typeof scriptVideoAssetImageStatuses[number]
  imageError?: string
  imageTaskId?: number
}
export type ScriptVideoAssetExtractionFields = {
  assetIdentity?: string
  aliases?: string[]
  sourceTitles?: string[]
  sourceEpisodes?: number[]
  occurrences?: ScriptVideoAssetOccurrence[]
}
export type ScriptVideoAsset = ScriptVideoAssetExtractionFields & {
  id: string
  name: string
  kind: string
  sourcePath?: string
  originalName?: string
  image?: string
  voiceAudio?: ScriptVideoVoiceAudio
  voiceMode?: ScriptVideoVoiceMode
}
export type ScriptVideoInput = {
  projectTitle?: string
  episodeNumber?: number
  script: string
  assets: ScriptVideoAsset[]
  signal?: AbortSignal
  configId?: number
  model?: string
  combatEnabled?: boolean
  autoSelectCharacterBases?: string[]
  characterAppearanceNotes?: string
  systemPrompt?: string
  storyboardMode?: ScriptVideoStoryboardMode
  production?: ScriptVideoProduction
  stylePreset?: ScriptVideoStylePreset
  deliverySpecs?: { aspectRatio?: string; resolution?: string; videoModel?: string }
}
const content = z.string().trim().min(1)
const seconds = z.number().positive().max(30)
export const outlineFields = z.object({
  title: content,
  duration: seconds,
  summary: content,
  assetIds: z.array(content),
  sourceSceneIds: z.array(content).optional(),
  combat: z.boolean(),
})
export const shotFields = z.object({
  duration: seconds,
  camera: content,
  action: content,
  dialogue: z.string(),
  visualAssetIds: z.array(content).optional(),
  speakerAssetIds: z.array(content).optional(),
})
export const formalContext = z.object({
  openingRecap: z.string().trim().optional(),
  opening: content,
  openingAssetIds: z.array(content).optional(),
  scene: content,
  characters: content,
  independentGeneration: content,
  ending: content,
})
export const productionFields = z.object({
  coreRhythm: content,
  visualSpecs: content,
  shotRhythm: content,
  dialogueRules: content,
  interfaceRules: content,
  costumeRules: content,
  sceneAndCamera: content,
  soundAndEditing: content,
  continuityReview: content,
  characters: z.array(z.object({ name: content, appearance: content, voice: content })),
  interfacePrompt: content.optional(),
})
export type ScriptVideoProduction = z.infer<typeof productionFields> & {
  stylePreset?: ScriptVideoStylePreset
}
const savedFields = outlineFields.extend({
  id: content,
  shots: z.array(shotFields).min(1),
  prompt: content,
})
// Legacy records have the earlier fields. Storyboard generation must fill the entire formal template.
export const formalFields = savedFields
  .omit({ prompt: true })
  .extend(formalContext.shape)
  .extend({
    shots: z.array(shotFields.extend({ dialogue: content })).min(1),
  })
export type ScriptVideoShot = z.infer<typeof shotFields> & { id: string }
export type ScriptVideoCard = z.infer<typeof outlineFields> &
  Partial<z.infer<typeof formalContext>> & {
    excludedAssetIds?: string[]
    assetBindingRequirements?: ScriptVideoAssetBindingRequirement[]
    manuallyAdded?: true
    referenceFrameSettings?: ScriptVideoReferenceSettings
    promptNeedsSync?: boolean
    dialogueThrough?: ScriptVideoDialogueBoundary
    id: string
    shots: ScriptVideoShot[]
    prompt: string
    status: 'draft' | 'queued' | 'generating' | 'ready'
    version: number
  }
export type ScriptVideoIssue = { code: string; message: string }
export class ScriptVideoAIError extends Error {
  constructor(
    public code: string,
    message: string,
    public issues: ScriptVideoIssue[] = [],
    public status = 422,
  ) {
    super(message)
    this.name = 'ScriptVideoAIError'
  }
}

/** Applied when planning a new episode, and when confirming that kind of plan.
 * Formal boards keep the exact timings their author previously approved. */
export function getScriptVideoOutlineDurationIssues(
  cards: ReadonlyArray<{ duration: number }>,
): ScriptVideoIssue[] {
  if (!cards.length) return [{ code: 'OUTLINE_REQUIRED', message: '本集大纲至少需要一个片段。' }]
  const issues: ScriptVideoIssue[] = []
  for (const [index, card] of cards.entries()) {
    const duration = card?.duration
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30) {
      issues.push({
        code: 'OUTLINE_DURATION_RANGE',
        message: `第${index + 1}段须大于0秒且不超过30秒。`,
      })
    }
  }
  return issues
}

export function resolveScriptVideoMentions(
  prompt: string,
  assets: Array<{ id: string; name: string }>,
) {
  const known = [...assets].filter((a) => a.name).sort((a, b) => b.name.length - a.name.length)
  const mentions: Array<{
    id: string
    name: string
    start: number
    end: number
  }> = []
  const unknown = new Set<string>()
  for (let start = prompt.indexOf('@'); start !== -1; start = prompt.indexOf('@', start + 1)) {
    const asset = known.find((a) => prompt.startsWith(a.name, start + 1))
    const end = start + 1 + (asset?.name.length || 0)
    if (asset && !/[A-Za-z0-9_\-]/u.test(prompt[end] || '')) {
      mentions.push({ id: asset.id, name: asset.name, start, end })
      start = end - 1
    } else {
      const word = prompt
        .slice(start + 1)
        .match(/^[^\s@，。、；：！？“”‘’「」()（）\[\]【】=,.!?;:]+/u)?.[0]
      unknown.add('@' + (word || ''))
    }
  }
  return { mentions, unknown: [...unknown] }
}

type Utterance = { speaker: string; text: string; voiceMode?: '心声' | '画外音' }
function declaredSpeakers(script: string) {
  const names = new Set<string>()
  for (const m of script
    .replaceAll('**', '')
    .matchAll(/^\s*(?:人物|角色|出场人物)\s*[：:]\s*(.+)$/gmu)) {
    for (const name of m[1].split(/[、，,；;｜|]/u))
      names.add(name.replace(/[（(][^）)]*[）)]$/u, '').trim())
  }
  return names
}

/** A timeline of ranges covers a complete card. Natural-language shots and
 * isolated cues such as “第5秒切镜” need no timestamp markup. */
export function hasInvalidScriptVideoTimeline(prompt: string, duration: number): boolean {
  const ranges = prompt.matchAll(
    /^\s*(?:镜头\s*\d+\s*)?[（(【\[]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/gimu,
  )
  let end = 0
  for (const range of ranges) {
    const start = Number(range[1]), next = Number(range[2])
    if (Math.abs(start - end) > 1e-7 || next <= start || next > duration + 1e-7) return true
    end = next
  }
  return end > 0 && Math.abs(end - duration) > 1e-7
}
function spokenIdentity(raw: string, declared: ReadonlySet<string>) {
  const name = raw.trim()
  return declared.has(name)
    ? name
    : name.replace(/(?:的)?(?:内心(?:独白|声|[ \t]*OS)?|心声|画外音|画外)$|[ \t]+OS$/iu, '') || name
}
function withoutOpeningDirections(text: string) {
  // An annotation before the first spoken word is stage direction. Text inside
  // opening quotes (including a literal “【警报】”) belongs to the actor.
  return text.replace(/^(?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))+\s*/u, '')
}
const quotes = /[“「『"]([^”」』"\n]+)[”」』"]/gu
const speakerLabel =
  /^\s*@?([\p{L}\p{N}·・、_ /-]{1,64})(?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*\s*[：:]\s*(.*)$/u
const speechDirection = /（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/u
const quoteAttribution =
  /([\p{L}\p{N}·・、_ /-]{1,64})((?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*)\s*[：:]((?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*)\s*$/u
const speechToken = new RegExp(quotes.source + '|' + speechDirection.source, 'gu')
const nonSpeaker =
  /^(?:(?:3D)?场景\s*[\d一二三四五六七八九十-]*|场次\s*[\d-]*|第[零一二三四五六七八九十百\d]+[集章场幕]|地点|时间|天气(?:\/环境)?|身份\/阶级|角色|人物|出场人物|镜头\s*\d*|镜号|画面|动作|转场|道具|生物|群众|音色|场景描述|环境|环境音|音效|枪声|呼吸声|脚步声|撞击声|衣料声|拟音|环境音效|字幕|提示词|视频编号|承上|衔接|时长|标题|集数|题材|背景|内景|外景)$/u
const soundOnly =
  /^(?:[-—/]|无|无对白|无台词|无对话|无声|静默|沉默|[（(]?无对白[）)]?|(?:音效|环境音|环境声|拟音|配乐|音乐|BGM|SFX)\s*[:：].*)$/iu
const words = scriptVideoSpokenText
function attributedSpeech(
  rawSpeaker: string, text: string, cue: string, declared: ReadonlySet<string>, withVoice: boolean,
): Utterance {
  const name = rawSpeaker.trim()
  const speaker = spokenIdentity(name, declared)
  const utterance: Utterance = { speaker, text }
  if (!withVoice) return utterance
  const suffix = name.slice(speaker.length)
  if (hasScriptVideoInnerOs(cue) || hasScriptVideoInnerOs(suffix)) utterance.voiceMode = '心声'
  else if (/[（(【\[]\s*(?:OV|VO|V\.O\.|画外音)\s*[）)】\]]/iu.test(cue) || /画外/u.test(suffix))
    utterance.voiceMode = '画外音'
  return utterance
}

// The formal sound column also contains foley and natural-sound prose. Extract
// character utterances from that column without treating an unquoted footstep as a line.
function shotSpeech(cell: string, declared: ReadonlySet<string>, withVoice = false): Utterance[] {
  const result: Utterance[] = []
  for (const raw of cell.split(/\r\n|[\r\n]/)) {
    const line = raw.trim()
    let attributed = false
    let afterQuote = 0
    let previous: Utterance | undefined
    for (const quote of line.matchAll(speechToken)) {
      if (quote[1] === undefined) continue
      const between = line.slice(afterQuote, quote.index)
      const firstQuote = afterQuote === 0
      const attribution = quoteAttribution.exec(between)
      afterQuote = quote.index + quote[0].length
      if (!attribution) {
        // Consecutive quoted pieces in a sound field continue the same voice.
        // Prose such as 门轴发出“吱呀” establishes a sound effect instead.
        const continuation = between.replace(new RegExp(speechDirection.source, 'gu'), '')
        if ((previous || firstQuote) && /^[\s，,；;。.!！?？：:]*$/u.test(continuation)) {
          previous = { ...(previous ?? { speaker: '' }), text: quote[1] }
          result.push(previous)
          attributed = true
        } else previous = undefined
        continue
      }
      const label = attribution[1].trim()
      if (!label || nonSpeaker.test(label) || soundOnly.test(label + '：拟音')) {
        previous = undefined
        continue
      }
      previous = attributedSpeech(label, quote[1], attribution[2] + attribution[3], declared, withVoice)
      result.push(previous)
      attributed = true
    }
    if (attributed || !line || soundOnly.test(line)) continue
    const plain = speakerLabel.exec(line)
    if (plain && !nonSpeaker.test(plain[1].trim()) && !/[“「『"]/u.test(plain[2])) {
      const spoken = withoutOpeningDirections(plain[2])
      const cue = line.slice(plain[1].length, line.length - spoken.length)
      const utterance = attributedSpeech(plain[1], spoken, cue, declared, true)
      if (/(?:未出声|无声|不出声|静默)/u.test(cue) && utterance.voiceMode !== '心声') continue
      result.push(withVoice ? utterance : { speaker: utterance.speaker, text: utterance.text })
    } else {
      const quote = /^[“「『"]([^”」』"\n]+)[”」』"]\s*$/u.exec(line)
      if (quote) result.push({ speaker: '', text: quote[1] })
    }
  }
  return result.filter((item) => words(item.text))
}

// Legacy prose can still establish speech with an actual speaker attribution.
// A reference such as “说完…” is not a new performance, and a picture label
// such as 屏幕显示：“…” never establishes a speaker.
function promptQuoteSpeech(before: string, text: string, declared: ReadonlySet<string>, names: readonly string[]): Utterance | undefined {
  const attribution = quoteAttribution.exec(before)
  const bareCue = /(?:心声|旁白|对白|内心[ \t]*OS|内心独白)[ \t]*$/iu.exec(before)
  const narrated = /([\p{L}\p{N}·・、_ /-]{1,64})((?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*)\s*$/u.exec(before)
  if (!attribution && !bareCue && !narrated) return
  const raw = attribution?.[1].trim() ?? (bareCue ? before.slice(0, bareCue.index).trim() : narrated![1].trim())
  const speechVerb = /(?:轻声|低声|高声|大声|冷声|沉声|颤声|厉声|急声)?(?:说道|问道|答道|喊道|叫道|吼道|喝道|说|问|答|喊|叫|吼|喝)$/u
  if (!attribution && !bareCue && (!speechVerb.test(raw) || names.includes(raw))) return
  const literalName = names.includes(spokenIdentity(raw, declared))
  const label = (literalName ? raw : raw.replace(speechVerb, '')).trimEnd()
  const base = spokenIdentity(label, declared)
  const named = names.find(name => base === name || base.endsWith(name))
  if (!named && !speechVerb.test(raw) && !bareCue) return
  const speaker = named ?? base
  const cues = (attribution ? attribution[2] + attribution[3] : bareCue?.[0] ?? narrated?.[2] ?? '')
    + (named ? label.slice(label.lastIndexOf(named) + named.length) : '')
  return attributedSpeech(speaker, text, cues, declared, true)
}

function legacyPromptSpeech(text: string, declared: ReadonlySet<string>, names: readonly string[]) {
  const utterances: Utterance[] = []
  for (const line of text.split(/\r\n|[\r\n]/u)) {
    const quoted = [...line.matchAll(speechToken)].filter(quote => quote[1] !== undefined)
    if (!quoted.length) {
      const speech = shotSpeech(line, declared, true)
      utterances.push(...speech.filter(item => names.includes(item.speaker)))
      continue
    }
    let previous: Utterance | undefined
    let afterQuote = 0
    for (const quote of quoted) {
      const before = line.slice(afterQuote, quote.index)
      const speech = promptQuoteSpeech(before, quote[1], declared, names)
      if (speech) previous = speech
      else if (previous && /^[\s，,；;。.!！?？：:]*$/u.test(before.replace(new RegExp(speechDirection.source, 'gu'), '')))
        previous = { ...previous, text: quote[1] }
      else previous = undefined
      if (previous) utterances.push(previous)
      afterQuote = quote.index! + quote[0].length
    }
  }
  return utterances
}
/** Recognize the screenplay's numeric metadata, never words within a line of
 * dialogue, an action or an on-screen quotation. */
export function isScriptVideoEstimateLine(line: string): boolean {
  if (!line.includes('预计')) return false
  const field = line.trim().normalize('NFKC').replaceAll('**', '')
  return /^(?:#{1,6}\s*)?[【\[]?\s*(?:本[场集章段])?预计(?:总)?时长\s*[】\]]?\s*:\s*(?:约\s*)?(?:\d+(?:\.\d+)?\s*(?:小时|分钟?|秒钟?|s)\s*)+[。.]?$/iu.test(
    field,
  )
}

function linesOfSpeech(
  text: string,
  declared: ReadonlySet<string>,
  withVoice: boolean,
): Utterance[] {
  const utterance = (name: string, text: string, cue: string) =>
    attributedSpeech(name, text, cue, declared, withVoice)
  const lines: Utterance[] = []
  for (const line of text.split(/\r\n|[\r\n]/)) {
    if (isScriptVideoEstimateLine(line)) continue
    const trimmed = line
      .trim()
      .replace(/\*\*/g, '')
      .replace(/^(?:[△▲▸]|[-*]\s)\s*/u, '')
    if (!trimmed || soundOnly.test(trimmed)) continue
    const label = speakerLabel.exec(trimmed)
    if (label && !nonSpeaker.test(label[1].trim())) {
      const spoken = withoutOpeningDirections(label[2])
      let cue = trimmed.slice(label[1].length, trimmed.length - spoken.length)
      // Some scripts put two speakers in one paragraph. A later attribution belongs to the next quote.
      const quoted = [...spoken.matchAll(speechToken)].filter(match => match[1] !== undefined)
      if (quoted.length && /^[“「『"]/u.test(spoken)) {
        let speaker = label[1].trim()
        let end = 0
        for (const match of quoted) {
          const attribution = quoteAttribution.exec(spoken.slice(end, match.index))
          if (attribution) {
            speaker = attribution[1]
            cue = attribution[2] + attribution[3]
          }
          lines.push(utterance(speaker, match[1], cue))
          end = match.index + match[0].length
        }
      } else if (spoken) lines.push(utterance(label[1].trim(), spoken, cue))
      continue
    }
    if (label && nonSpeaker.test(label[1].trim())) continue
    const quoted = [...trimmed.matchAll(speechToken)].filter(
      (m) => m[1] !== undefined && (m.index === 0 ||
        /[：:道说问喊答喝叫吼念叹]，?\s*$/u.test(trimmed.slice(0, m.index))),
    )
    if (quoted.length) {
      for (const match of quoted) {
        const before = trimmed.slice(0, match.index)
        const attribution = quoteAttribution.exec(before)
        lines.push(utterance(attribution?.[1] || '', match[1], attribution ? attribution[2] + attribution[3] : ''))
      }
    }
  }
  return lines.filter((line) => words(line.text))
}
export function sameShotDialogue(before: string, after: string, script = '') {
  const declared = declaredSpeakers(script)
  const speech = (text: string) => shotSpeech(text, declared).map(line => ({
    ...line, text: withoutScriptVideoPauseCues(line.text),
  }))
  return (
    JSON.stringify(speech(before)) === JSON.stringify(speech(after))
  )
}

export function sourceDialogue(script: string, withVoice = false) {
  return linesOfSpeech(script, declaredSpeakers(script), withVoice)
}

/** Convert a validated outline boundary to the same character offset used by the formal dialogue audit. */
export function scriptVideoDialogueBoundaryCharacters(
  lines: ReadonlyArray<{ text: string }>,
  boundary: ScriptVideoDialogueBoundary,
) {
  if (!boundary.line) return 0
  const index = boundary.line - 1
  const text = lines[index].text
  const rawEnd = boundary.endCue
    ? text.indexOf(boundary.endCue) + boundary.endCue.length
    : text.length
  const through = projectScriptVideoSpokenText(text).rawOffsets.filter(offset => offset < rawEnd).length
  return lines.slice(0, index).reduce((total, line) => total + words(line.text).length, through)
}

/** Preserve spoken characters and order, including a line split over adjacent shots.
 * Unlabelled prose is only treated as dialogue when it has positive speech markers. */
function checkDialogue(
  script: string,
  cards: ScriptVideoCard[],
  scope: 'episode' | 'card' | 'prefix',
  production?: ScriptVideoProduction,
) {
  const wholeEpisode = scope !== 'card'
  const declared = declaredSpeakers(script)
  const source = linesOfSpeech(script, declared, true)
  // Spoken identity is independent of the image ID. A costume suffix can be
  // dropped in the sound column, and explicit aliases may be established by the
  // script and the production cast table; this never chooses an asset binding.
  const baseName = (s: string) => s.split('_')[0].trim()
  const originalSpeakers = new Set(source.map((line) => line.speaker))
  const castNames = (production?.characters || []).map((role) =>
    role.name
      .split(/\s+[／/]\s+|[（(）)]/u)
      .map((s) => s.trim())
      .filter(Boolean),
  )
  const sameSpeaker = (spoken: string, original: string) => {
    if (spoken === original || baseName(original) === spoken) return true
    if (!spoken || originalSpeakers.has(spoken)) return false
    if (
      script.includes(spoken) &&
      castNames.some(
        (group) =>
          group.some((name) => name === original || name === baseName(original)) &&
          group.includes(spoken),
      )
    )
      return true
    if (/Q版/iu.test(original) && spoken === '小' + baseName(original)) {
      return (production?.characters || []).some(
        (role) => role.name.includes(original) && role.appearance.includes(spoken),
      )
    }
    // A unique suffix of an established role/group label may be spoken as a
    // short credit (e.g. 小旗 or 九名火枪卫). Never infer an image variant here.
    const group = /[／/]群体$/u.test(original)
    const short = group
      ? spoken
          .replace(/^[零一二三四五六七八九十百千万两\d]+(?:名|人|位)/u, '')
          .replace(/(?:[／/])?群体$/u, '')
      : spoken
    if (short.length < 2) return false
    const candidates = [...originalSpeakers]
      .filter((name) => group === /[／/]群体$/u.test(name))
      .map((name) => baseName(name).replace(/[／/]群体$/u, ''))
      .filter((name) => name.endsWith(short))
    const stem = baseName(original).replace(/[／/]群体$/u, '')
    return new Set(candidates).size === 1 && candidates.includes(stem)
  }
  const promptSpeakers = [...new Set([
    ...declared, ...source.map(line => line.speaker), ...castNames.flat(),
    ...cards.flatMap(card => card.shots.flatMap(shot => shotSpeech(shot.dialogue, declared).map(line => line.speaker))),
  ].filter(Boolean))].sort((a, b) => b.length - a.length)
  function promptDialogueIssues(card: ScriptVideoCard): ScriptVideoIssue[] {
    const issues: ScriptVideoIssue[] = []
    const parsed = parseScriptVideoPromptDialogue(card.prompt)
    const expected = card.shots.map(shot => shotSpeech(shot.dialogue, declared, true))
    const readSound = (sound: (typeof parsed.sounds)[number]) =>
      shotSpeech(sound.text, declared, true).map(line => sound.voiceMode ? { ...line, voiceMode: sound.voiceMode } : line)
    const location = (shot?: number) => card.title + (shot === undefined ? '' : '的镜头' + String(shot).padStart(2, '0'))
    function compare(wanted: Utterance[], actual: Utterance[], shot?: number) {
      let length = 0
      const spans = wanted.map(line => {
        const start = length
        length += words(line.text).length
        return { ...line, start, end: length }
      })
      const speech = wanted.map(line => words(line.text)).join('')
      let cursor = 0
      for (const line of actual) {
        const spoken = words(line.text)
        if (!spoken) continue
        if (!speech.startsWith(spoken, cursor)) {
          issues.push({ code: 'PROMPT_DIALOGUE_NEW',
            message: location(shot) + '的对白／音效栏增加、重复或改动了对白「' + line.text + '」。' })
          continue
        }
        const covered = spans.filter(span => span.end > cursor && span.start < cursor + spoken.length)
        if (covered.some(span => span.speaker && !sameSpeaker(line.speaker, span.speaker))) {
          issues.push({ code: line.speaker ? 'PROMPT_DIALOGUE_SPEAKER' : 'PROMPT_DIALOGUE_STRUCTURE',
            message: location(shot) + '的对白／音效栏中「' + line.text + '」'
              + (line.speaker ? '的说话人应是' + covered[0]?.speaker + '。' : '未能确认说话人，请同步本镜对白格式。') })
        }
        if (covered.some(span => span.voiceMode !== line.voiceMode)) {
          issues.push({ code: 'PROMPT_DIALOGUE_MODE',
            message: location(shot) + '的对白／音效栏中「' + line.text + '」的现场对白、心声或画外音标记与分镜不一致。' })
        }
        cursor += spoken.length
      }
      if (cursor !== speech.length) {
        const missing = spans.find(span => span.end > cursor)
        issues.push({ code: 'PROMPT_DIALOGUE',
          message: location(shot) + '的对白／音效栏缺少原顺序对白「' + (missing?.text ?? speech.slice(cursor)) + '」。' })
      }
    }
    if (parsed.numbered) {
      if (parsed.shotNumbers.length !== card.shots.length || parsed.shotNumbers.some((number, index) => number !== index + 1)) {
        issues.push({ code: 'PROMPT_DIALOGUE_STRUCTURE',
          message: card.title + '的提示词镜号与正式分镜无法逐镜对应，请先同步提示词结构。' })
      } else {
        for (const [index, wanted] of expected.entries()) {
          const sounds = parsed.sounds.filter(sound => sound.shot === index + 1)
          if (!sounds.length) issues.push({ code: 'PROMPT_DIALOGUE_STRUCTURE',
            message: location(index + 1) + '未找到可定位的对白／音效区域，请先同步本镜提示词。' })
          compare(wanted, sounds.flatMap(readSound), index + 1)
        }
        // An extra sound field before the first shot is a performance too.
        for (const sound of parsed.sounds.filter(sound => sound.shot === undefined)) compare([], readSound(sound))
      }
    } else if (parsed.sounds.length) {
      compare(expected.flat(), parsed.sounds.flatMap(readSound))
    } else {
      const actual = parsed.contexts.filter(context => context.kind === 'unscoped')
        .flatMap(context => legacyPromptSpeech(context.text, declared, promptSpeakers))
      if (expected.flat().length && !actual.length) issues.push({ code: 'PROMPT_DIALOGUE_STRUCTURE',
        message: card.title + '的提示词无法可靠定位实际对白，请保留草稿并同步对白／音效格式。' })
      else compare(expected.flat(), actual)
    }
    // References in staging and handoffs are checked independently. A known
    // excerpt, including adjacent source dialogue, never consumes current speech.
    for (const context of parsed.contexts) {
      if (!parsed.numbered && !parsed.sounds.length && context.kind === 'unscoped') continue
      for (const quote of context.text.matchAll(speechToken)) {
        if (quote[1] === undefined) continue
        const utterance = promptQuoteSpeech(context.text.slice(0, quote.index), quote[1], declared, promptSpeakers)
        if (!utterance) continue
        const excerpt = words(utterance.text)
        const originals = source.filter(line => words(line.text).includes(excerpt))
        const inShots = expected.flat().some(line => words(line.text).includes(excerpt))
        const reference = context.kind === 'handoff' || context.kind === 'summary'
        if (!inShots && !(reference && originals.length)) issues.push({ code: 'PROMPT_DIALOGUE_NEW',
          message: location(context.shot) + '的' + (context.text.match(/^[^：:\r\n]+[：:]/u)?.[0] ?? '上下文')
            + '含本段镜头以外的明确口播「' + utterance.text + '」。' })
        else if (originals.length && promptSpeakers.includes(utterance.speaker) &&
            !originals.some(line => !line.speaker || sameSpeaker(utterance.speaker, line.speaker))) {
          issues.push({ code: 'PROMPT_DIALOGUE_SPEAKER',
            message: location(context.shot) + '的上下文引用「' + utterance.text + '」与原稿说话人不一致。' })
        }
      }
    }
    return issues
  }
  const ordered = source.map((line) => words(line.text)).join('')
  const speakerSpans: Array<{ start: number; end: number; speaker: string; innerOs: boolean }> = []
  let offset = 0
  for (const line of source) {
    const end = offset + words(line.text).length
    speakerSpans.push({ start: offset, end, speaker: line.speaker, innerOs: line.voiceMode === '心声' })
    offset = end
  }
  const issues: ScriptVideoIssue[] = []
  let cursor = 0
  const scriptWords = words(script)
  for (const card of cards) {
    const rendered = card.shots.flatMap((shot, index) =>
      shotSpeech(shot.dialogue, declared, true).map(line => ({ ...line, shot: index + 1 })))
    for (const line of rendered) {
      const field = card.title + '的镜头' + String(line.shot).padStart(2, '0') + '的对白／音效栏'
      const spoken = words(line.text)
      const innerOs = line.voiceMode === '心声'
      let pos = wholeEpisode ? cursor : ordered.indexOf(spoken, cursor)
      if (!wholeEpisode && pos >= 0 && line.speaker) {
        // Identical words from different characters are common (e.g. two people saying “好”).
        // A single card may begin with a later speaker or a later utterance mode.
        let firstMatch = -1
        let match = pos
        while (match >= 0) {
          const candidate = speakerSpans.find((span) => span.end > match)
          if (!candidate?.speaker || sameSpeaker(line.speaker, candidate.speaker)) {
            if (firstMatch < 0) firstMatch = match
            if (candidate?.innerOs === innerOs) {
              firstMatch = match
              break
            }
          }
          match = ordered.indexOf(spoken, match + 1)
        }
        if (firstMatch >= 0) pos = firstMatch
      }
      // Atypical prose may carry unattributed speech. Verify verbatim against the
      // source without guessing speaker boundaries or inventing required dialogue.
      if (!source.length) {
        const rawPos = scriptWords.indexOf(spoken, cursor)
        if (rawPos < 0)
          issues.push({
            code: 'DIALOGUE_CHANGED',
            message: field + '：本集剧本中找不到对白「' + line.text + '」。',
          })
        else cursor = rawPos + spoken.length
      } else if (pos < 0 || !ordered.startsWith(spoken, pos)) {
        issues.push({
          code: 'DIALOGUE_CHANGED',
          message: field + '：对白未按原文顺序逐字保留：「' + line.text + '」。',
        })
      } else {
        const span = speakerSpans.find((item) => item.end > pos)
        if (span?.speaker && !sameSpeaker(line.speaker, span.speaker)) {
          issues.push({
            code: 'DIALOGUE_SPEAKER',
            message: field + '中「' + line.text + '」的原文说话人是' + span.speaker + '。',
          })
        }
        if (
          span &&
          pos + spoken.length > span.end &&
          speakerSpans.some(
            (next) =>
              next.end > span.end &&
              next.start < pos + spoken.length &&
              next.speaker &&
              next.speaker !== span.speaker,
          )
        )
          issues.push({
            code: 'DIALOGUE_SPEAKER',
            message: field + '：请将不同人物的台词分别注明说话人。',
          })
        const modeConflict = speakerSpans.find((item) =>
          item.end > pos && item.start < pos + spoken.length &&
          item.speaker && sameSpeaker(line.speaker, item.speaker) && item.innerOs !== innerOs)
        if (modeConflict) {
          const shot = String(line.shot).padStart(2, '0')
          issues.push({
            code: 'DIALOGUE_INNER_OS',
            message: card.title + '的镜头' + shot + '的对白／音效栏中「' + line.text + '」'
              + (modeConflict.innerOs ? '是原稿的心声。保留原词，简短标注 (OS)。'
                : '的原稿未标内心 OS。请恢复原有的对白或画外音标记。'),
          })
        }
        cursor = pos + spoken.length
      }
    }
    issues.push(...promptDialogueIssues(card))
  }
  if (scope === 'episode' && source.length && cursor !== ordered.length) {
    issues.push({
      code: 'DIALOGUE_MISSING',
      message: '本集正式分镜未完整保留全部原文对白，请按台词清单逐字核对。',
    })
  }
  return { issues, consumed: source.length ? cursor : 0 }
}

/** Slice the model’s remaining voice queue using the same punctuation-normalized
 * cursor that the contiguous source-dialogue audit accepted. */
export function remainingScriptVideoDialogue(script: string, consumed: number) {
  const remaining = sourceDialogue(script, true).flatMap((line) => {
    if (consumed === 0) return [line]
    const projected = projectScriptVideoSpokenText(line.text)
    const size = projected.text.length
    if (consumed >= size) {
      consumed -= size
      return []
    }
    const offset = projected.rawOffsets[consumed]
    consumed = 0
    return [{ ...line, text: line.text.slice(offset) }]
  })
  return remaining
}

export function checkAssetIds(ids: string[], assets: ScriptVideoAsset[]) {
  const issues: ScriptVideoIssue[] = []
  const knownIds = new Set(assets.map((a) => a.id))
  for (const id of ids) {
    if (!knownIds.has(id))
      issues.push({
        code: 'ASSET_UNKNOWN',
        message: '资产 ID 不在本项目清单内：' + id,
      })
  }
  if (new Set(ids).size !== ids.length)
    issues.push({ code: 'ASSET_DUPLICATE', message: '资产 ID 重复。' })
  return issues
}

function declaredReferenceIssues(
  card: ScriptVideoCard,
  byId: ReadonlyMap<string, ScriptVideoAsset>,
  bound: ReadonlySet<string>,
): ScriptVideoIssue[] {
  const references = [
    { ids: card.openingAssetIds, label: '开场画面' },
    ...card.shots.flatMap((shot, index) => [
      { ids: shot.visualAssetIds, label: `镜头 ${index + 1} 的配图` },
      { ids: shot.speakerAssetIds, label: `镜头 ${index + 1} 的发声者`, speaker: true },
    ]),
  ]
  const issues: ScriptVideoIssue[] = []
  for (const { ids, label, speaker } of references) {
    for (const id of new Set(ids ?? [])) {
      const asset = byId.get(id)
      if (!asset) {
        issues.push({ code: 'ASSET_UNKNOWN', message: `${card.title} 的${label}使用了项目清单中不存在的资产 ID：${id}` })
      } else if (!bound.has(id)) {
        issues.push({ code: 'ASSET_UNBOUND', message: `${card.title} 的${label}尚未绑定 @${asset.name}` })
      } else if (speaker && asset.kind !== 'character') {
        issues.push({ code: 'ASSET_SPEAKER_KIND', message: `${card.title} 的${label}需要角色资产：@${asset.name}` })
      }
    }
  }
  return issues
}

/** Decimal seconds are compared without floating point addition drift. */
function exactShotDuration(card: ScriptVideoCard) {
  const decimal = (value: number) => {
    const [mantissa, exponent = '0'] = String(value).split('e')
    const [integer, fraction = ''] = mantissa.split('.')
    const scale = fraction.length - Number(exponent)
    return { units: BigInt(integer + fraction) * 10n ** BigInt(Math.max(0, -scale)), scale: Math.max(0, scale) }
  }
  const values = [card.duration, ...card.shots.map(shot => shot.duration)].map(decimal)
  const scale = Math.max(...values.map(value => value.scale))
  const units = values.map(value => value.units * 10n ** BigInt(scale - value.scale))
  return units.slice(1).reduce((sum, value) => sum + value, 0n) === units[0]
}

/** Check execution data only. Dialogue, staging and creative choices are model instructions,
 * not additional pass/fail rules inferred from prose. */
export function assertScriptVideoCards(input: {
  script: string
  assets: ScriptVideoAsset[]
  cards: ScriptVideoCard[]
  scope?: 'episode' | 'card' | 'prefix'
  production?: ScriptVideoProduction
}): void {
  const { cards, assets } = input
  const issues: ScriptVideoIssue[] = []
  const fields = savedFields.extend({
    openingAssetIds: z.array(content).optional(),
    excludedAssetIds: z.array(content).optional(),
    shots: z.array(shotFields.extend({ id: content })).min(1),
  })
  const invalid = z.array(fields).min(1).safeParse(cards)
  if (!invalid.success) {
    throw new ScriptVideoAIError(
      'STORYBOARD_INVALID',
      '正式分镜字段不完整',
      invalid.error.issues.map((i) => ({
        code: 'CARD_FORMAT',
        message: i.path.join('.') + ' ' + i.message,
      })),
    )
  }
  const catalog = z.array(z.object({ id: content, name: content, kind: content })).safeParse(assets)
  if (!catalog.success)
    throw new ScriptVideoAIError('STORYBOARD_INVALID', '项目素材清单字段不完整',
      catalog.error.issues.map(issue => ({ code: 'ASSET_CATALOG_FORMAT', message: issue.path.join('.') + ' ' + issue.message })))
  if (new Set(cards.map(card => card.id)).size !== cards.length)
    issues.push({ code: 'CARD_ID_DUPLICATE', message: '正式分镜 ID 重复。' })
  for (const card of cards) {
    if (new Set(card.shots.map(shot => shot.id)).size !== card.shots.length)
      issues.push({ code: 'SHOT_ID_DUPLICATE', message: card.title + '的镜头 ID 重复。' })
    if (!exactShotDuration(card))
      issues.push({ code: 'DUR009', message: card.title + '的逐镜时长之和与片段时长不符。' })
  }
  if (issues.length) throw new ScriptVideoAIError('STORYBOARD_INVALID', issues[0].message, issues)
}

function assetReferenceWarnings(input: Parameters<typeof assertScriptVideoCards>[0]): ScriptVideoIssue[] {
  const { cards, assets } = input
  const issues: ScriptVideoIssue[] = []
  if (new Set(assets.map(asset => asset.id)).size !== assets.length)
    issues.push({ code: 'ASSET_CATALOG_DUPLICATE', message: '项目资产 ID 重复，无法唯一定位素材。' })
  const assetById = new Map(assets.map(asset => [asset.id, asset]))
  for (const card of cards) {
    issues.push(...checkAssetIds(card.assetIds, assets))
    if (card.excludedAssetIds) issues.push(...checkAssetIds(card.excludedAssetIds, assets))
    const references = [card.openingAssetIds, ...card.shots.flatMap(shot => [shot.visualAssetIds, shot.speakerAssetIds])]
    for (const ids of references) {
      if (ids && new Set(ids).size !== ids.length)
        issues.push({ code: 'ASSET_DUPLICATE', message: card.title + '的素材引用 ID 重复。' })
    }
    const bound = new Set(card.assetIds)
    issues.push(...declaredReferenceIssues(card, assetById, bound))
    // Strip system style text and recaps before resolving deliberate @asset references.
    // The shared resolver limits bare mentions to active shot references.
    const prompt = omitScriptVideoRecapQuotes(
      replaceScriptVideoPromptStyle(card.prompt, undefined, input.production?.stylePreset, input.production),
      card.shots,
    )
    const annotated = annotateScriptVideoAssets(prompt, assets, card.assetIds, {
      card, autoBind: true, characters: card.characters, cast: input.production?.characters, excludedIds: card.excludedAssetIds,
    })
    for (const problem of annotated.problems) {
      issues.push({
        code: problem.type === 'unknown' ? 'ASSET_MENTION_UNKNOWN' : 'ASSET_AMBIGUOUS',
        message: card.title + ' ' + describeScriptVideoReferenceProblem(prompt, problem),
      })
    }
    for (const mention of annotated.mentions) {
      if (mention.explicit && mention.usage !== 'context' && !bound.has(mention.id))
        issues.push({ code: 'ASSET_UNBOUND', message: card.title + '尚未绑定 @' + mention.name })
    }
  }
  return issues
}

/** Advisory content findings never reject a draft or spend automatic repair attempts. */
export function getScriptVideoContentWarnings(
  input: Parameters<typeof assertScriptVideoCards>[0],
): ScriptVideoIssue[] {
  const cards = input.cards.map(card => ({
    ...card,
    prompt: omitScriptVideoRecapQuotes(
      replaceScriptVideoPromptStyle(card.prompt, undefined, input.production?.stylePreset, input.production),
      card.shots,
    ),
  }))
  const timing: ScriptVideoIssue[] = []
  for (const card of cards) {
    for (const target of card.prompt.matchAll(/(?:全段|本段总时长|总时长)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)/giu)) {
      if (Number(target[1]) !== card.duration)
        timing.push({ code: 'PROMPT_DURATION', message: card.title + '的提示词文案时长与卡片不同，可在分镜中核对。' })
    }
    if (hasInvalidScriptVideoTimeline(card.prompt, card.duration))
      timing.push({ code: 'PROMPT_TIMELINE', message: card.title + '的提示词时码可能存在空档、重叠或越界，可在分镜中核对。' })
  }
  return [
    ...assetReferenceWarnings(input),
    ...timing,
    ...getScriptVideoSceneContinuityIssues(input.script, cards, input.assets),
    ...checkDialogue(input.script, cards, input.scope ?? 'episode', input.production).issues,
  ]
}

/** Submitting a video or a formal delivery requires the complete document. Legacy
 * drafts stay editable, but cannot be delivered as though they already had this metadata. */
export function assertScriptVideoFormal(input: Parameters<typeof assertScriptVideoCards>[0]) {
  const production = productionFields.safeParse(input.production)
  const cards = z.array(formalFields).min(1).safeParse(input.cards)
  const issues: ScriptVideoIssue[] = []
  if (
    input.production?.stylePreset !== undefined &&
    !isScriptVideoStylePreset(input.production.stylePreset)
  ) {
    issues.push({ code: 'STYLE_PRESET_INVALID', message: '本集生成时的统一风格快照不完整' })
  }
  if (!production.success)
    issues.push(
      ...production.error.issues.map((i) => ({
        code: 'PRODUCTION_MISSING',
        message: '制作规格或人物声音锁定未完成：' + i.path.join('.'),
      })),
    )
  if (!cards.success)
    issues.push(
      ...cards.error.issues.map((i) => ({
        code: 'FORMAL_METADATA_MISSING',
        message: '正式分镜缺少模板字段：' + i.path.join('.'),
      })),
    )
  if (Array.isArray(input.cards) && input.cards.some((c) => c?.promptNeedsSync))
    issues.push({ code: 'PROMPT_STALE', message: '镜头内容已修改，请先同步本卡提示词。' })
  if (issues.length)
    throw new ScriptVideoAIError(
      'FORMAL_INCOMPLETE',
      issues[0].message + '。请补齐或重新生成正式分镜。',
      issues,
    )
  return assertScriptVideoCards(input)
}
