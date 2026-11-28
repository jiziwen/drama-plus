import { scriptVideoFoleyCues, scriptVideoNamedAudioCue, scriptVideoNextTurnStart, scriptVideoPerformanceBracket, scriptVideoPerformanceDirections, scriptVideoSpeakerLabel, scriptVideoSpeakerSeparator, scriptVideoSpeechQuote, speechClosers, unquotedSpeaker } from './script-video-foley.js'
import { isScriptVideoChibiAppearance, scriptVideoCharacterBase, scriptVideoCharacterName } from './script-video-asset-identity.js'
import { hasScriptVideoInnerOs } from './script-video-inner-os.js'
import { scriptVideoVocalSubjects } from './script-video-vocal-subjects.js'
import { isScriptVideoCameraHeading, isScriptVideoNonvisualMention, plainScriptVideoCameraFields, plainScriptVideoCameraText, scriptVideoAssetScopeRanges, scriptVideoCameraRanges, scriptVideoShotHeadings } from './script-video-asset-scope.js'
import type { ScriptVideoAssetBindingRequirement } from './script-video-asset-scenes.js'

export type MentionAsset = {
  id: string
  name: string
  kind?: string
  originalName?: string
  sourcePath?: string
  assetIdentity?: string
  aliases?: readonly string[]
}
export type AssetMention = {
  id: string
  name: string
  start: number
  end: number
  spoken: boolean
  literal: boolean
  explicit: boolean
  usage: 'visual' | 'speaker' | 'audio' | 'context'
  vocalization?: true
  manualAudioId?: string
}

/** Named audio cues are saved with the prompt. Attachment numbers are assigned at delivery. */
export function scriptVideoAudioReferences<A extends MentionAsset>(assets: readonly A[], prompt?: string) {
  const names = new Map(assets.filter(asset => asset.kind === 'audio').map(asset => [asset.name, asset]))
  if (prompt !== undefined && !prompt.includes('@音色[')) return names
  const used = new Set(assets.map(asset => asset.name))
  for (const asset of assets) {
    if (asset.kind !== 'character') continue
    const base = `音色[${asset.name}]`
    let name = base
    for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`
    used.add(name)
    if (prompt === undefined || prompt.includes('@' + name)) names.set(name, asset)
  }
  return names
}
// Offsets use the original prompt, including @ when it was typed explicitly.
type ReferenceRange = { start: number; end: number }
export type ScriptVideoReferenceProblem = ReferenceRange & {
  type: 'unknown' | 'ambiguous'
  name: string
  candidates?: string[]
  candidateIds?: string[]
  occurrences?: ReferenceRange[]
}
type CardReferences = {
  openingAssetIds?: readonly string[]
  manualAssetIds?: readonly string[]
  sourceSceneIds?: readonly string[]
  assetBindingRequirements?: readonly ScriptVideoAssetBindingRequirement[]
  shots: ReadonlyArray<{ dialogue?: string; visualAssetIds?: readonly string[]; speakerAssetIds?: readonly string[] }>
}
type Options = {
  dialogue?: boolean
  protectedPrefix?: string
  excludedIds?: readonly string[]
  autoBind?: boolean
  characters?: string
  cast?: ReadonlyArray<{ name: string }>
  detectUnboundSpeakers?: boolean
  card?: CardReferences
}

const wordEnd = /[A-Za-z0-9_-]/u
const unknownName = /^[^\s@，。、；：！？“”‘’「」()（）\[\]【】=,.!?;:]+/u
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const soundHeading = /^\s*(?:对白\s*[/／]\s*音效|对白|台词|画外音|旁白|心声)\s*[:：]\s*/u
// Build short forms only from identities actually selected for this segment.
const chineseWords = new Intl.Segmenter('zh', { granularity: 'word' })
const collectiveRole = /(?:兵|卫|士|军|卒|众|队|臣|官|民|百姓|侍从)$/u
const individualRole = /(?:小旗|侍卫长|指挥使|太医)$/u
const genericCharacterRole = /(?:掌柜|老板娘|老板|店主|店家|店小二|小二|伙计|账房|客人|路人|捕头|捕快|衙役|官差|大夫|郎中|护卫|侍卫|丫鬟|仆人)$/u
const qQualifier = /(?:3D)?Q版[ \t]*小?[ \t]*$/iu
const foley = /^\s*(?:物理音效|背景音效|音效|环境音|环境声|背景音|动作音|拟音|音乐|配乐|BGM|SFX)\s*[:：]/iu
const visualField = /^[ \t]*(?:←承上|→衔接|末镜停在|开场画面|场景(?:[一二三四五六七八九十\d]+)?|人物|角色设定|画面与动作)[ \t]*[:：]/u
const visualDirection = /^[ \t]*补充(?:镜头指示|画面(?:说明|指示)?|动作)[ \t]*[:：]/u
const shotTitle = /^[ \t]*镜头[ \t]*\d/u
const otherField = /^[ \t]*(?:总时长|独立生成|本段事件|(?:编辑|制作|导演|手写)?备注|后续(?:计划|说明)|校验说明)[ \t]*[:：]/u
const cardSection = /^[ \t]*(?:(←承上|开场画面)|(场景(?:[一二三四五六七八九十\d]+)?)|(独立生成|本段事件|→衔接|末镜停在)|前镜回顾|(人物|角色设定)|总时长)[ \t]*[：:]/gmu
const storyboardField = (text: string) => visualField.test(text) || visualDirection.test(text) || isScriptVideoCameraHeading(text) || shotTitle.test(text) || otherField.test(text)
const speakerCue = new RegExp('^(?<cue>(?:[ \\t]*(?:' + scriptVideoPerformanceBracket.source +
  '|心声|内心独白|内心|画外音|旁白|说|问|道|答))*)[ \\t]*[：:][ \\t]*(?<words>.+)', 'u')
const attributionLabel = new RegExp(`^[ \\t]*(?<label>${scriptVideoSpeakerLabel.source}(?:${scriptVideoSpeakerSeparator.source}${scriptVideoSpeakerLabel.source})*)(?=[ \\t]*(?:[（(【\\[]|[：:]))`, 'u')
const genericSoundLabel = /^(?:音效|拟音|(?:物理|背景)音效|环境(?:音|声)|(?:动作|背景)音|音乐|配乐|BGM|SFX|旁白|画外音|心声|O\.?[SV]\.?|V\.?O\.?|系统(?:面板|界面|播报|提示音|提示|音)?|广播(?:音|声)?|录音|字幕|音色|(?:屏幕|牌匾)(?:显示|文字|字样)?|对白|台词|无台词|无对白|无声|静默|沉默)$/iu
const silentWords = /^(?:(?:[（(【\[]\s*)?(?:无台词|无对白|无对话|无声|沉默|静默|不说话)(?:\s*[）)】\]])?|[-—/]+|“\s*”|「\s*」|『\s*』|"\s*"|\{\s*\})\s*(?:[。，；;]|$)/u
type PromptLine = {
  value: string; start: number; end: number; inDialogue: boolean; inVisual: boolean; headingLength: number
  foleyCues: ReturnType<typeof scriptVideoFoleyCues>
}

function isSoundContinuation(value: string, byName: ReadonlyMap<string, MentionAsset[]>) {
  if (foley.test(value) || scriptVideoFoleyCues(value.trimStart())[0]?.start === 0 || scriptVideoVocalSubjects(value, byName).length) return true
  const attribution = attributionLabel.exec(value)
  const label = attribution?.groups?.label?.trim()
  if (!attribution || !label) return false
  return label.includes('@') || genericSoundLabel.test(label) ||
    byName.get(label)?.some(asset => !asset.kind || asset.kind === 'character') ||
    /^[：:][ \t]*[“「『"{]/u.test(value.slice(attribution[0].length))
}

function promptLines(text: string, dialogue: boolean, byName: ReadonlyMap<string, MentionAsset[]>): PromptLine[] {
  const matches = [...text.matchAll(/[^\r\n]+/gu)]
  const structured = matches.some(match => storyboardField(match[0]))
  const lines: PromptLine[] = []
  let inDialogue = dialogue, inVisual = !structured && !dialogue, previousEnd = 0
  let completedDialogueLine = false
  for (const match of matches) {
    let value = match[0], start = match.index!
    const end = start + value.length
    const headingLength = soundHeading.exec(value)?.[0].length || 0
    const separated = !value.trim() || /(?:\r?\n){2}/u.test(text.slice(previousEnd, start))
    if (headingLength) {
      inDialogue = true
      inVisual = false
    } else if (!dialogue && (storyboardField(value) || separated || completedDialogueLine && !isSoundContinuation(value, byName))) {
      inDialogue = false
      inVisual = visualField.test(value) || visualDirection.test(value) || shotTitle.test(value) || !structured
    }
    let lineInDialogue = inDialogue || foley.test(value)
    let foleyCues = lineInDialogue ? scriptVideoFoleyCues(value.slice(headingLength)) : []
    // A manually entered visual column can follow dialogue on the same line.
    if (lineInDialogue && !dialogue) {
      const spans = quotedRanges(value)
      for (const cue of foleyCues) spans.push([headingLength + cue.start, headingLength + cue.end])
      const visual = [...value.matchAll(/[;；][ \t]*/gu)].find(separator => {
        const offset = separator.index! + separator[0].length
        const rest = value.slice(offset)
        return (visualField.test(rest) || visualDirection.test(rest)) &&
          !spans.some(([from, to]) => from <= separator.index! && separator.index! < to)
      })
      if (visual) {
        const offset = visual.index! + visual[0].length
        lines.push({ value: value.slice(0, offset), start, end: start + offset, inDialogue: lineInDialogue, inVisual, headingLength,
          foleyCues: foleyCues.filter(cue => headingLength + cue.end <= offset) })
        value = value.slice(offset)
        start += offset
        inDialogue = lineInDialogue = false
        inVisual = true
        foleyCues = []
      }
    }
    const activeHeading = start === match.index ? headingLength : 0
    lines.push({ value, start, end, inDialogue: lineInDialogue, inVisual, headingLength: activeHeading, foleyCues })
    const speech = value.slice(activeHeading).trimEnd()
    completedDialogueLine = inDialogue && (/[”」』"}][。！？.!?]?$/u.test(speech) || /^无[。！？.!?]?$/u.test(speech) || silentWords.test(speech))
    previousEnd = end
  }
  return lines
}

function isSpeakerAt(text: string, start: number, end: number, line: PromptLine, turnEnds: ReadonlySet<number>) {
  const lineBodyStart = line.start + line.headingLength
  const before = text.slice(lineBodyStart, start).trimEnd()
  if (before && (!line.inDialogue || !/[；;]$/u.test(before) && !turnEnds.has(start) && !turnEnds.has(lineBodyStart + before.length))) return false
  if (foley.test(line.value.slice(line.headingLength)) && !before.trim()) return false
  const cue = speakerCue.exec(text.slice(end, line.end))?.groups
  if (!cue || silentWords.test(cue.words)) return false
  const innerOs = hasScriptVideoInnerOs(cue.cue)
  if (!innerOs && /未出声|不出声|无声|静默|沉默/u.test(cue.cue)) return false
  return line.inDialogue || !storyboardField(line.value) && (innerOs || /^[“「『"{]/u.test(cue.words))
}

function speakerLabels(
  text: string,
  lines: readonly PromptLine[],
  scopes: ReturnType<typeof scriptVideoAssetScopeRanges>,
  protectedText: ReadonlyArray<[number, number]>,
  turnEnds: Set<number>,
  byName: ReadonlyMap<string, MentionAsset[]>,
  selectedSpeakersAt: (position: number) => readonly MentionAsset[],
) {
  const labels = new Map<number, { name: string; end: number; attributionStart?: number; selectedAsset?: MentionAsset; vocalization?: true }>()
  const ignoredBareRanges: ReferenceRange[] = []
  for (const line of lines) {
    if (storyboardField(line.value) && !line.headingLength) continue
    const body = line.value.slice(line.headingLength)
    const start = line.start + line.headingLength
    const offsets = [0]
    if (line.inDialogue) {
      const directions = scriptVideoPerformanceDirections(body, line.foleyCues)
      for (const direction of directions)
        ignoredBareRanges.push({ start: start + direction.start, end: start + direction.end })
      const canStart = (offset: number) => !directions.some(({ start, end }) => start <= offset && offset < end) &&
        !protectedText.some(([from, to]) => from <= start + offset && start + offset < to)
      for (const actor of scriptVideoVocalSubjects(body, byName, directions)) {
        const from = start + actor.start
        if (scopes.some(scope => scope.kind !== 'sound' && scope.start <= from && from < scope.end)) continue
        const inEffect = line.foleyCues.some(cue => cue.start <= actor.start && actor.start < cue.end)
        if (!inEffect && protectedText.some(([a, b]) => a <= from && from < b)) continue
        const candidates = byName.get(actor.name)
        if (candidates && !candidates.some(asset => !asset.kind || asset.kind === 'character')) continue
        labels.set(from, { name: actor.name, end: start + actor.end, vocalization: true })
        if (actor.nextTurn !== undefined) turnEnds.add(start + actor.nextTurn)
      }
      for (const separator of body.matchAll(/[；;]/gu)) {
        const offset = separator.index!
        if (canStart(offset)) offsets.push(offset + 1)
      }
      for (const end of turnEnds) {
        if (end > start && end < line.end && canStart(end - start)) offsets.push(end - start)
      }
    }
    for (const offset of offsets) {
      const match = attributionLabel.exec(body.slice(offset))
      const label = match?.groups?.label?.trimEnd()
      if (!label) continue
      const position = start + offset + match![0].indexOf(label)
      if (!isSpeakerAt(text, position, position + label.length, line, turnEnds)) continue
      if (scopes.some(scope => scope.start <= position && position < scope.end)) continue
      // A list shares one performance cue and one utterance, but every member
      // still has its own image and voice settings. Preserve named assets that contain 、.
      const wholeName = label.replace(/^@/u, '')
      const parts = byName.has(wholeName) ? [label] : label.split(scriptVideoSpeakerSeparator)
      let partEnd = 0
      for (const part of parts) {
        const partOffset = label.indexOf(part, partEnd)
        partEnd = partOffset + part.length
        const raw = part.trim()
        const marker = raw.indexOf('@')
        const name = raw.slice(marker + 1)
        if (name.split(/[／/]/u).every(piece => genericSoundLabel.test(piece.trim()))) continue
        const partStart = position + partOffset + part.indexOf(raw)
        if (marker < 0 && line.inDialogue && !byName.has(name.replaceAll('／', '/'))) {
          // A bare clan or title prefix is only evidence with the shot's speaker list.
          const candidates = selectedSpeakersAt(partStart).flatMap(asset => {
            const suffix = [asset.name, scriptVideoCharacterName(asset), scriptVideoCharacterBase(asset)]
              .find(form => form.length >= 2 && form.length < name.length && name.endsWith(form) &&
                byName.get(form)?.some(candidate => candidate.id === asset.id))
            return suffix ? [{ asset, suffix }] : []
          })
          if (candidates.length === 1) {
            const [{ asset, suffix }] = candidates
            const from = partStart + raw.length - suffix.length
            ignoredBareRanges.push({ start: partStart, end: from })
            labels.set(from, { name: suffix, end: partStart + raw.length, attributionStart: position, selectedAsset: asset })
            continue
          }
        }
        // The prefix identifies the role in prose, while @ locates the actual asset.
        labels.set(partStart + Math.max(marker, 0), { name, end: partStart + raw.length,
          ...(marker > 0 && { attributionStart: position }) })
      }
    }
  }
  return { labels, ignoredBareRanges: ignoredBareRanges.sort((a, b) => a.start - b.start) }
}

/** Bounds use offsets in the original text, so editing, hover hit-testing and
 * the provider formatter can all address the same occurrence. */
const quotedSpeech = new RegExp(scriptVideoSpeechQuote.source, 'gu')
const dialogueClauses = new RegExp('(?:' + scriptVideoSpeechQuote.source + '|' + /[^；;“「『"{]/u.source + ')+', 'gu')

function quotedRanges(text: string): Array<[number, number]> {
  // Quoted speech and verbatim text on a prop or screen stay byte-for-byte
  // intact. This also covers quoted lines embedded in action descriptions.
  return Array.from(text.matchAll(quotedSpeech),
    m => [m.index!, m.index! + m[0].length])
}

function literalRanges(lines: PromptLine[], quoted: Array<[number, number]>) {
  const ranges = [...quoted]
  for (const { value, start, inDialogue, headingLength, foleyCues } of lines) {
    if (!inDialogue) continue
    const body = value.slice(headingLength)
    const origin = start + headingLength
    let from = 0
    for (const cue of [...foleyCues, { start: body.length, end: body.length, next: body.length }]) {
      let continuingSpeech = false
      for (const piece of body.slice(from, cue.start).matchAll(dialogueClauses)) {
        if (foley.test(piece[0])) {
          continuingSpeech = false
          continue
        }
        const labelLength = unquotedSpeaker.exec(piece[0])?.[0].length || 0
        const speech = piece[0].slice(labelLength)
        if (labelLength) continuingSpeech = !/^[“「『"{]/u.test(speech)
        if (continuingSpeech) {
          const start = origin + from + piece.index! + labelLength
          ranges.push([start, start + speech.length])
        }
      }
      if (cue.end > cue.start) ranges.push([origin + cue.start, origin + cue.end])
      from = cue.next
    }
  }
  return ranges.sort((a, b) => a[0] - b[0])
}

export function describeScriptVideoReferenceProblem(text: string, problem: ScriptVideoReferenceProblem) {
  const shot = [...text.slice(0, problem.start).matchAll(/^[ \t]*镜头[ \t]*(\d+)/gmu)].at(-1)?.[1]
  const location = shot ? `镜头 ${shot}` : '本段提示词'
  if (problem.type === 'unknown') return `${location}找不到素材 ${problem.name}`
  return `${location}的「${problem.name}」有多个匹配，请用 @ 选定具体素材${problem.candidates?.length ? `（${problem.candidates.join('、')}）` : ''}`
}

export function isScriptVideoSingleHanName(name: string) {
  return /^\p{Script=Han}$/u.test(name.normalize('NFKC'))
}

export function isScriptVideoGenericCharacterRole(name: string) {
  return genericCharacterRole.exec(name)?.[0] === name
}

function assetNames(asset: MentionAsset) {
  if (asset.kind === 'audio') return [asset.name]
  const names = new Set([asset.name])
  let chibiSubject: string | undefined
  if (asset.kind === 'character' || !asset.kind) {
    const characterNames = [asset]
    if (asset.originalName && asset.originalName !== asset.name) {
      characterNames.push({ ...asset, name: asset.originalName })
    }
    const stylized = isScriptVideoChibiAppearance(asset)
    if (stylized) chibiSubject = scriptVideoCharacterBase(asset).normalize('NFKC')
    for (const candidate of characterNames) {
      const base = scriptVideoCharacterBase(candidate)
      names.add(scriptVideoCharacterName(candidate))
      if (stylized) {
        for (const prefix of ['3DQ版小', '3DQ版', 'Q版小', 'Q版']) names.add(prefix + base)
      } else {
        names.add(base)
        if (base.endsWith('/群体')) names.add(base.slice(0, -3))
      }
    }
  } else {
    const filename = asset.originalName || asset.sourcePath?.split('/').at(-1)?.replace(/\.[^.]+$/u, '') || asset.name
    names.add(filename)
    if (asset.kind === 'scene') {
      const location = filename.split(/[-_]/u).at(-1)
      if (location && location.length >= 2) names.add(location)
    }
  }
  // Generic character labels need evidence beyond a catalog alias. The
  // underlying display name, a declared cast alias, or a confirmed selection
  // can establish the role without trusting an unrelated extracted alias.
  const character = !asset.kind || asset.kind === 'character'
  const roleName = character && !chibiSubject
    ? scriptVideoCharacterBase({ ...asset, assetIdentity: undefined })
    : undefined
  const usableAlias = (name: string) => name && name !== '群体' && name.normalize('NFKC') !== chibiSubject &&
    (!character || !isScriptVideoGenericCharacterRole(name) || roleName?.endsWith(name))
  const resolvedNames = [...names].filter(name => name === asset.name || name.length > 1 && usableAlias(name))
  for (const saved of asset.aliases ?? []) {
    const alias = saved.trim()
    if (usableAlias(alias)) resolvedNames.push(alias)
  }
  return resolvedNames
}

const aliasLabel = /^(?:(?:本段)?(?:报姓名|名为|本名|名叫|又名|别名|真名|化名)\s*[：:]?\s*)?([\p{Script=Han}·]{2,8})$/u
const notAnAlias = /心声|画外|低声|内心|群体|受伤|表情|造型|角色|原音|本段|重伤|合声|齐声|独白|系统|穿越者|小剧场/u

/** Character bindings may explicitly declare aliases in the cast, e.g.
 * 火枪卫小旗_飞鱼服（张浩）. Never infer identity from a similar-sounding name. */
function addCastAliases(
  options: Options,
  byName: Map<string, MentionAsset[]>,
  register: (name: string, asset: MentionAsset) => void,
) {
  const bind = (full: string, alias: string) => {
    const name = aliasLabel.exec(alias.trim())?.[1]
    if (!name || notAnAlias.test(name)) return
    for (const asset of byName.get(full.trim().replace(/^@/u, '')) || []) {
      if (!asset.kind || asset.kind === 'character') register(name, asset)
    }
  }
  for (const role of Array.isArray(options.cast) ? options.cast : []) {
    if (typeof role?.name !== 'string') continue
    const declared = /^(.+?)[（(]([^（）()]+)[）)]$/u.exec(role.name.trim())
    if (declared) bind(declared[1], declared[2])
    const [name, ...aliases] = role.name.split(/\s+[/／]\s+/u)
    for (const alias of aliases) bind(name, alias)
  }
  // Only accept the character header before its description, not an arbitrary
  // parenthetical embedded in a shot's action or performance.
  for (const m of (options.characters || '').matchAll(/(?:^|[。；;\n])\s*@?([^：:（）()，。；;\n]+)[（(]([^（）()]+)[）)]\s*[:：]/gu)) {
    bind(m[1], m[2])
  }
}

export function annotateScriptVideoAssets(
  text: string,
  assets: readonly MentionAsset[],
  boundIds: readonly string[],
  options: Options = {},
) {
  const byName = new Map<string, MentionAsset[]>()
  const register = (name: string, asset: MentionAsset) => {
    const matching = byName.get(name)
    if (!matching) byName.set(name, [asset])
    else if (!matching.some(item => item.id === asset.id)) matching.push(asset)
  }
  const declaredRoles = new Map<string, Set<string>>()
  const declareRole = (name: string, asset: MentionAsset) => {
    register(name, asset)
    if (!isScriptVideoGenericCharacterRole(name)) return
    const declared = declaredRoles.get(name)
    if (declared) declared.add(asset.id)
    else declaredRoles.set(name, new Set([asset.id]))
  }
  for (const asset of assets) {
    if (asset.name) for (const name of assetNames(asset)) register(name, asset)
  }
  // A card's established item/location gives meaning to shorthand that is
  // also the title of a different project asset: 金算盘 can refer to the
  // already selected 迷你金算盘, and 院落 to the current palace, for example.
  const bound = new Set(boundIds)
  const boundCrowds: MentionAsset[] = []
  for (const asset of assets) {
    if (!bound.has(asset.id)) continue
    if (asset.kind === 'character') {
      if (isScriptVideoChibiAppearance(asset)) continue
      const identity = scriptVideoCharacterBase(asset)
      if (identity.endsWith('/群体')) {
        boundCrowds.push(asset)
        register('群体', asset)
        const owner = identity.slice(0, -3)
        // 皇家亲军火枪卫 → 火枪卫. Start at a word boundary; 枪卫 is not a
        // cast label. A competing bound group shares this candidate and makes
        // it ambiguous instead of letting project import order decide.
        for (const part of chineseWords.segment(owner)) {
          const role = owner.slice(part.index)
          if (role.length >= 2 && collectiveRole.test(role)) register(role, asset)
        }
      } else {
        const short = individualRole.exec(identity)?.[0]
        if (short) register(short, asset)
      }
      continue
    }
    if (!['scene', 'prop', 'creature'].includes(asset.kind || '')) continue
    const filename = asset.originalName || asset.name.split('/').at(-1) || asset.name
    for (const [term, candidates] of byName) {
      const describesAsset = asset.kind === 'prop' ? filename.endsWith(term) : filename.includes(term)
      if (term.length > 1 && describesAsset && candidates.some(item => item.kind === asset.kind)) register(term, asset)
    }
  }
  addCastAliases(options, byName, declareRole)
  const card = options.card
  const shots = card && Array.isArray(card.shots) ? card.shots as CardReferences['shots'] : []
  const headings = shots.length ? scriptVideoShotHeadings(text) : []
  const sections = headings.length ? [...text.matchAll(cardSection)] : []
  const headingsFromEnd = [...headings].reverse()
  const excluded = new Set(options.excludedIds)
  let charactersById: Map<string, MentionAsset> | undefined
  const selectedSpeakersAt = (position: number) => {
    const heading = headingsFromEnd.find(item => item.start <= position)
    if (!heading || sections.some(section => heading.start < section.index! && section.index! <= position)) return []
    const ids = shots[heading.index]?.speakerAssetIds
    if (!ids?.length) return []
    const byId = charactersById ??= new Map(assets.filter(asset => (!asset.kind || asset.kind === 'character') && !excluded.has(asset.id))
      .map(asset => [asset.id, asset]))
    return [...new Set(ids)].flatMap(id => byId.get(id) ?? [])
  }
  for (const binding of card?.assetBindingRequirements ?? []) {
    if (binding.kind !== 'character' || !binding.confirmed || !binding.assetId ||
      binding.sceneId && (card?.sourceSceneIds?.length !== 1 || card.sourceSceneIds[0] !== binding.sceneId)) continue
    const asset = assets.find(item => item.id === binding.assetId && item.kind === 'character')
    if (asset && isScriptVideoGenericCharacterRole(binding.label)) declareRole(binding.label, asset)
  }
  // A shot may call its foreground lead “家丁” while the household servants
  // laugh together. The crowd shorthand belongs only to a sound attribution.
  const servants = boundCrowds.filter(asset => scriptVideoCharacterBase(asset).endsWith('家丁/群体'))
  const speakerNames = servants.length && !byName.has('家丁') ? new Map(byName).set('家丁', servants) : byName
  const quoted = quotedRanges(text)
  const audioNames = scriptVideoAudioReferences(assets, text)
  for (const [name, asset] of audioNames) if (asset.kind === 'character') register(name, asset)
  const audioPattern = scriptVideoNamedAudioCue([...audioNames.keys()])
  const audioAt = new Map<number, MentionAsset>()
  const cameraRanges = options.dialogue ? [] : scriptVideoCameraRanges(text)
  const cameraMentions: { id: string; start: number }[] = []
  let cameraEnd = 0, withoutCamera = ''
  for (const { start, end } of cameraRanges) {
    withoutCamera += text.slice(cameraEnd, start) + ' '.repeat(end - start)
    cameraEnd = end
  }
  withoutCamera += text.slice(cameraEnd)
  // Ignore an adjacent hand-picked sound when parsing the speaker, but keep
  // the original offsets and text for the editable token and provider payload.
  const speakerText = audioPattern ? withoutCamera.replace(new RegExp(audioPattern, 'gu'), (token, start: number) => {
    if (quoted.some(([from, to]) => from <= start && start < to)) return token
    audioAt.set(start, audioNames.get(token.slice(1))!)
    return ' '.repeat(token.length)
  }) : withoutCamera
  const lines = promptLines(speakerText, options.dialogue || false, speakerNames)
  const turnEnds = new Set(quoted.filter(([from, to]) => to - from > 1 && text[to - 1] === speechClosers[text[from]])
    .flatMap(([, to]) => [to, scriptVideoNextTurnStart(text, to)]))
  const cueEnds = new Map<number, number>()
  for (const line of lines) {
    const origin = line.start + line.headingLength
    for (const cue of line.foleyCues) {
      turnEnds.add(origin + cue.end)
      turnEnds.add(origin + cue.next)
      cueEnds.set(origin + cue.start, origin + cue.end)
    }
  }
  const protectedText = literalRanges(lines, quoted)
  const scopes = scriptVideoAssetScopeRanges(text, options.dialogue).map(scope => {
    if (scope.kind !== 'sound') return scope
    // A generic sound-field scope can include the following speaker when
    // a bracketed effect and an utterance share a line without punctuation.
    const start = scope.start + /^[ \t]*/u.exec(text.slice(scope.start, scope.end))![0].length
    const end = cueEnds.get(start)
    return end !== undefined && end < scope.end ? { ...scope, end } : scope
  })
  const { labels, ignoredBareRanges } = speakerLabels(speakerText, lines, scopes, protectedText, turnEnds, speakerNames, selectedSpeakersAt)
  const speakerAliases = new Map<string, MentionAsset[]>()
  for (const { name } of labels.values()) {
    if (byName.has(name) || speakerAliases.has(name)) continue
    const known = speakerNames.get(name.replaceAll('／', '/'))
    if (known) speakerAliases.set(name, known)
  }
  const names = [...byName.keys(), ...speakerAliases.keys()].sort((a, b) => b.length - a.length)
  // Include bare @ in the same scan: an unknown explicit name cannot fall back
  // to a valid substring later in the token.
  const matcher = new RegExp(names.length ? '@?(' + names.map(escaped).join('|') + ')|@' : '@', 'gu')
  const mentions: AssetMention[] = []
  const ambiguous = new Set<string>()
  const problemsByKey = new Map<string, ScriptVideoReferenceProblem>()
  const unknown = new Set<string>()
  const assetIds = new Set<string>()
  const contextAssetIds = new Set<string>()
  const problems: ScriptVideoReferenceProblem[] = []
  function addProblem(key: string, problem: ScriptVideoReferenceProblem) {
    const prior = problemsByKey.get(key)
    if (prior) {
      const occurrences = prior.occurrences ??= [{ start: prior.start, end: prior.end }]
      occurrences.push({ start: problem.start, end: problem.end })
    } else {
      problemsByKey.set(key, problem)
      problems.push(problem)
    }
  }
  function addUnknown(name: string, start: number, end: number) {
    const reference = '@' + name
    unknown.add(reference)
    addProblem(reference, { type: 'unknown', name: reference, start, end })
  }
  const visibleIds = [...new Set([...(card?.openingAssetIds || []), ...shots.flatMap(shot => shot?.visualAssetIds || [])])]
  const hasCompleteVisuals = shots.length > 0 && shots.every(shot => Array.isArray(shot?.visualAssetIds))
  const prefix = options.protectedPrefix?.trim().replace(/\r\n?/gu, '\n')
  if (prefix) {
    const match = new RegExp('^' + prefix.split('\n').map(escaped).join('(?:\\r\\n|\\r|\\n)')).exec(text)
    matcher.lastIndex = match?.[0].length || 0
  }
  let output = '', previous = 0, range = 0, ignoredBareIndex = 0, scopeIndex = 0, lineIndex = 0, shotIndex = -1, sectionIndex = -1, cameraIndex = 0
  for (let match; (match = matcher.exec(text));) {
    const start = match.index, end = matcher.lastIndex
    const name = match[1]
    const label = labels.get(start)
    const namedCandidates = label && label.name === name && label.selectedAsset ? [label.selectedAsset]
      : byName.get(name) ?? (label?.name === name ? speakerAliases.get(name) : undefined)
    const explicit = text[start] === '@'
    if (!explicit && name && isScriptVideoSingleHanName(name)) continue
    while ((cameraRanges[cameraIndex]?.end ?? Infinity) <= start) cameraIndex++
    const camera = cameraRanges[cameraIndex]
    if (camera && camera.start <= start) {
      if (namedCandidates?.length && !wordEnd.test(text[end] || '')) {
        // Do not guess which asset an ambiguous camera landmark meant.
        const exact = namedCandidates.filter(asset => asset.name === name)
        const candidates = exact.length ? exact : namedCandidates
        const selected = candidates.length === 1 ? candidates : candidates.filter(asset => bound.has(asset.id))
        if (selected.length === 1) cameraMentions.push({ id: selected[0].id, start })
      }
      continue
    }
    while ((ignoredBareRanges[ignoredBareIndex]?.end ?? Infinity) <= start) ignoredBareIndex++
    const ignoredBare = ignoredBareRanges[ignoredBareIndex]
    if (!explicit && ignoredBare && ignoredBare.start <= start) {
      matcher.lastIndex = Math.min(end, ignoredBare.end)
      continue
    }
    while (protectedText[range] && protectedText[range][1] <= start) range++
    const vocalization = label?.vocalization && label.end === end
    const spoken = !!vocalization || !!protectedText[range] && protectedText[range][0] <= start
    while (scopes[scopeIndex] && scopes[scopeIndex].end <= start) scopeIndex++
    while (lines[lineIndex] && lines[lineIndex].end <= start) lineIndex++
    const activeScope = scopes[scopeIndex]
    const scope = activeScope && activeScope.start <= start ? activeScope.kind : undefined
    const line = lines[lineIndex]
    const invalidEnd = wordEnd.test(text[end] || '')
    const token = explicit && (!namedCandidates || invalidEnd) ? unknownName.exec(text.slice(start + 1))?.[0] || '' : ''
    const referenceEnd = token ? start + token.length + 1 : end
    const attribution = label?.end === referenceEnd || line && isSpeakerAt(speakerText, label?.attributionStart ?? start, referenceEnd, line, turnEnds)
    // In a full prompt an explicit @ can add an image even on a sound line.
    // Actual speech and sound effects have their own protected spans.
    let contextual = !vocalization && (spoken || scope === 'handoff' || scope === 'sound' ||
      scope === 'summary' && (!explicit || namedCandidates?.every(asset => asset.kind === 'character')) ||
      line && !attribution && (options.dialogue || !explicit && (line.inDialogue || !line.inVisual)) ||
      isScriptVideoNonvisualMention(text, start, referenceEnd))
    if (!namedCandidates || invalidEnd) {
      if (explicit) {
        if (!contextual) addUnknown(token, start, referenceEnd)
        matcher.lastIndex = Math.max(end, start + token.length + 1)
      }
      continue
    }
    const audio = explicit ? audioAt.get(start) : undefined
    if (audio && audioNames.get(name) === audio) {
      mentions.push({ id: audio.id, name, start, end, explicit, spoken: false, literal: false, usage: 'audio' })
      assetIds.add(audio.id)
      continue
    }
    const visualCandidates = namedCandidates.filter(asset => asset.kind !== 'audio' && audioNames.get(name) !== asset)
    if (!visualCandidates.length) continue
    if (!explicit && /[A-Za-z0-9_-]/u.test(text[start - 1] || '') && /^[A-Za-z0-9_-]/u.test(name)) continue
    // An unbound Q figure must never fall back to the live character's name.
    if (!explicit && qQualifier.test(text.slice(Math.max(0, start - 16), start))) continue
    // The bare category may denote the single group in this card. Never
    // select a project-wide 群体.png from this generic word alone.
    if (!explicit && name === '群体' && boundCrowds.length !== 1) continue
    while ((headings[shotIndex + 1]?.start ?? Infinity) <= start) shotIndex++
    while ((sections[sectionIndex + 1]?.index ?? Infinity) <= start) sectionIndex++
    const heading = headings[shotIndex]
    const section = sections[sectionIndex]
    const shot = heading && heading.start > (section?.index ?? -1) ? shots[heading.index] : undefined
    const speakers = !contextual && attribution ? visualCandidates.filter(asset => !asset.kind || asset.kind === 'character') : []
    let candidates = speakers.length ? speakers : visualCandidates
    // A general title is meaningful if the specific role is in this shot or
    // it has been declared for this card. Legacy cards can use their own
    // selection when they have no shot list for that use.
    const usageIds = attribution ? shot?.speakerAssetIds : shot?.visualAssetIds
    if (isScriptVideoGenericCharacterRole(name)) {
      candidates = candidates.filter(asset =>
        asset.kind && asset.kind !== 'character' || asset.name === name ||
        usageIds?.includes(asset.id) || declaredRoles.get(name)?.has(asset.id) ||
        usageIds === undefined && bound.has(asset.id))
      if (!candidates.length) {
        if (explicit && !contextual) addUnknown(name, start, end)
        continue
      }
    }
    const explicitMatches = explicit ? candidates.filter(asset => asset.name === name) : []
    if (explicitMatches.length > 1) candidates = explicitMatches
    let scoped: MentionAsset[] | undefined
    const exactSelection = explicitMatches.length === 1
    if (!contextual && !exactSelection) {
      if (speakers.length) {
        const ids = shot?.speakerAssetIds
        const sameShot = ids?.length ? candidates.filter(asset => ids.includes(asset.id) && !excluded.has(asset.id)) : []
        if (sameShot.length) scoped = sameShot
      } else if (!attribution) {
        const castHeader = !shot && !!section?.[4]
        const ids = shot ? shot.visualAssetIds
          : castHeader ? hasCompleteVisuals ? visibleIds : [...visibleIds, ...bound]
          : section?.[1] ? card?.openingAssetIds ?? shots[0]?.visualAssetIds
          : section?.[2] && hasCompleteVisuals ? visibleIds
          : section?.[3] && /^(?:→衔接|末镜停在)$/u.test(section[3]) ? shots.at(-1)?.visualAssetIds
          : undefined
        if (Array.isArray(ids)) {
          const visible = candidates.filter(asset => ids.includes(asset.id) && !excluded.has(asset.id))
          // Descriptive cast headers can cover several different costumes. The
          // executable references belong to the individual shots. Explicit
          // aliases can also add a reference that was absent from the shot.
          if (visible.length && (!castHeader || visible.length === 1)) scoped = visible
          else if (!explicit && !(shot && candidates.length === 1 && candidates[0].name === name &&
              /^[\t ]*画面与动作[\t ]*[：:]/u.test(line?.value ?? ''))) contextual = true
        }
      }
    }
    const usage = contextual || attribution && !speakers.length ? 'context' : speakers.length ? 'speaker' : 'visual'
    if (scoped) candidates = scoped
    const exact = candidates.filter(a => a.name === name)
    const selected = candidates.filter(a => bound.has(a.id))
    if (usage === 'context') for (const asset of selected) contextAssetIds.add(asset.id)
    if (!explicit && exact.some(a => excluded.has(a.id)) && !exact.some(a => bound.has(a.id))) continue
    let available = scoped ?? (selected.length ? selected : (explicit || options.autoBind || usage === 'context' ? candidates.filter(a => !excluded.has(a.id)) : []))
    // Explicit @ names are deliberate asset choices. Bare character names
    // stand for the on-camera costume if it is already bound to this card.
    if (explicit && exact.length === 1) available = exact
    else if (!scoped && selected.length > 1) {
      const named = selected.filter(a => a.name === name)
      if (named.length === 1) available = named
    }
    const soundDirection = !quoted.some(([from, to]) => from <= start && start < to) &&
      (scope === 'sound' || !!line?.foleyCues.some(cue => {
        const origin = line.start + line.headingLength
        return origin + cue.start <= start && start < origin + cue.end
      }))
    if (available.length !== 1) {
      const characterReference = (!spoken || soundDirection) && available.some(asset => asset.kind === 'character')
      if (available.length > 1 && (usage !== 'context' || characterReference)) {
        // Shared descriptive aliases are not evidence that unrelated assets are
        // in this segment. Keep explicit, canonical, and locally scoped choices.
        if (!explicit && shots.length && !scoped && available.every(asset => {
          const identity = asset.assetIdentity?.split(/[｜|]/u, 1)[0]
          return !visibleIds.includes(asset.id) && !declaredRoles.get(name)?.has(asset.id) && identity !== name &&
            !assetNames({ ...asset, aliases: [] }).includes(name)
        })) {
          const families = new Set(available.map(asset => asset.assetIdentity?.split(/[｜|]/u, 1)[0] ||
            (asset.kind === 'character' ? scriptVideoCharacterBase(asset) : asset.originalName || asset.name)))
          if (families.size > 1) continue
        }
        const candidateIds = available.map(asset => asset.id)
        const key = JSON.stringify([explicit, name, [...candidateIds].sort()])
        ambiguous.add(name)
        addProblem(key, {
          type: 'ambiguous', name, start, end, candidateIds, candidates: [...new Set(available.map(asset => asset.name))],
        })
      }
      continue
    }
    const asset = available[0]
    // Keep the declared nickname in “@造型（张浩）”. Rewriting the definition
    // would erase the name used in the source and make recovery ambiguous.
    const prior = mentions.at(-1)
    const declaredAlias = prior?.id === asset.id && !explicit
      && /^[（(]$/u.test(text.slice(prior.end, start)) && /^[）)]/u.test(text.slice(end))
    // Character identity remains a formal reference outside the words being
    // spoken, including recaps and sound directions. Context still describes
    // whether the role belongs on camera; it no longer suppresses its reference.
    const literal = declaredAlias || !vocalization &&
      (spoken && !soundDirection || usage === 'context' && asset.kind !== 'character')
    const manualAudioId = usage === 'speaker' ? audioAt.get(end + (/^[ \t]*/u.exec(text.slice(end))?.[0].length ?? 0))?.id : undefined
    mentions.push({ id: asset.id, name: asset.name, start, end, explicit, spoken, literal, usage,
      ...(manualAudioId && { manualAudioId }),
      ...(vocalization && { vocalization: true }) })
    if (usage !== 'context' || !literal) assetIds.add(asset.id)
    if (usage === 'context') contextAssetIds.add(asset.id)
    if (literal) continue
    output += text.slice(previous, start) + '@' + asset.name
    previous = end
  }
  const resolvedSpeakers = new Set(mentions.filter(mention => mention.usage === 'speaker' || mention.usage === 'audio').map(mention => mention.start))
  return { text: output + text.slice(previous), mentions, cameraMentions, assetIds: [...assetIds], contextAssetIds: [...contextAssetIds],
    unboundSpeakers: options.detectUnboundSpeakers ? [...new Set([...labels].filter(([start, { name }]) =>
      !resolvedSpeakers.has(start) && !ambiguous.has(name) &&
      (!isScriptVideoSingleHanName(name) || text[start] === '@')).map(([, { name }]) => name))] : [],
    problems, ambiguous: [...ambiguous], unknown: [...unknown] }
}

/** Keep explicit library selections that have no textual evidence against their
 * use, including older prompts. A contextual mention alone never ships a picture. */
export function scriptVideoVisualAssetIds(
  scan: { mentions: readonly AssetMention[]; contextAssetIds: readonly string[] }, boundIds: readonly string[],
) {
  const visual = new Set(scan.mentions.filter(hit => hit.usage === 'visual').map(hit => hit.id))
  const contextual = new Set([...scan.contextAssetIds, ...scan.mentions.filter(hit => hit.usage === 'speaker' || hit.usage === 'audio').map(hit => hit.id)])
  return [...new Set([...boundIds.filter(id => !contextual.has(id) || visual.has(id)), ...visual])]
}

/** Older prompts sometimes omit their structured camera/action fields. Use the
 * missing fields to determine materials while preserving the authored prompt. */
export function scriptVideoMaterialEvidenceText(
  prompt: string, shots: ReadonlyArray<{ camera?: string; action?: string }>,
) {
  const headings = scriptVideoShotHeadings(prompt)
  if (!headings.length) return prompt
  return prompt.slice(0, headings[0].start) + headings.map(({ start, index }, i) => {
    const block = prompt.slice(start, headings[i + 1]?.start)
    const shot = shots[index]
    if (!shot) return block
    const fields = [
      shot.camera?.trim() && !scriptVideoCameraRanges(block).length && '景别／机位／运动：' + shot.camera.replace(/\r?\n/gu, ' '),
      shot.action?.trim() && !/^画面与动作[：:]/mu.test(block) && '画面与动作：' + shot.action,
    ].filter(Boolean)
    if (!fields.length) return block
    const end = block.indexOf('\n')
    if (end < 0) return block + '\n' + fields.join('\n')
    return block.slice(0, end + 1) + fields.join('\n') + '\n' + block.slice(end + 1)
  }).join('')
}

type CameraReferenceCard = Omit<CardReferences, 'shots'> & {
  prompt?: string
  scene?: string
  opening?: string
  characters?: string
  assetIds: readonly string[]
  manuallyAdded?: true
  shots: ReadonlyArray<CardReferences['shots'][number] & { camera?: string; action?: string }>
}

/** Older automatic bindings can contain a camera landmark as a shot asset.
 * Keep selections supported by another field, another shot or manual confirmation. */
export function withoutCameraOnlyScriptVideoAssets<T extends CameraReferenceCard>(
  card: T, assets: readonly MentionAsset[], scan?: ReturnType<typeof annotateScriptVideoAssets>,
  evidenceText?: string, evidenceScan?: ReturnType<typeof annotateScriptVideoAssets>,
): T {
  const prompt = card.prompt ?? ''
  const ranges = scriptVideoCameraRanges(prompt)
  if (!ranges.length && !card.shots.some(shot => shot.camera?.trim())) return card
  const nextPrompt = plainScriptVideoCameraFields(prompt, ranges)
  const shots = card.shots.map(shot => {
    const camera = shot.camera && plainScriptVideoCameraText(shot.camera)
    return camera === shot.camera ? shot : { ...shot, camera }
  })
  const normalized = nextPrompt === prompt && shots.every((shot, index) => shot === card.shots[index])
    ? card : { ...card, ...(card.prompt !== undefined && { prompt: nextPrompt }), shots }
  if (card.manuallyAdded) return normalized

  const body = evidenceText ?? scriptVideoMaterialEvidenceText(prompt, card.shots)
  const evidence = evidenceScan ?? (body === prompt ? scan : undefined) ?? annotateScriptVideoAssets(body, assets, card.assetIds, { card })
  const cameraById = new Map<string, Set<number>>()
  const headings = scriptVideoShotHeadings(body)
  const recordCameraAsset = (id: string, index: number) => {
    const positions = cameraById.get(id) ?? new Set<number>()
    positions.add(index)
    cameraById.set(id, positions)
  }
  let headingIndex = -1
  for (const { id, start } of evidence.cameraMentions) {
    while ((headings[headingIndex + 1]?.start ?? Infinity) <= start) headingIndex++
    recordCameraAsset(id, headings[headingIndex]?.index ?? -1)
  }
  // A structured edit can be newer than the rendered prompt.
  const detached = card.shots.flatMap((shot, index) => {
    const camera = shot.camera?.trim().replace(/\r?\n/gu, ' ')
    return camera && !body.includes(camera) ? [`镜头 ${index + 1}\n机位：${camera}`] : []
  })
  if (detached.length) {
    const text = detached.join('\n')
    const detachedHeadings = scriptVideoShotHeadings(text)
    let index = 0
    for (const mention of annotateScriptVideoAssets(text, assets, card.assetIds).cameraMentions) {
      while ((detachedHeadings[index + 1]?.start ?? Infinity) <= mention.start) index++
      recordCameraAsset(mention.id, detachedHeadings[index].index)
    }
  }
  if (!cameraById.size) return normalized

  const retained = new Set([
    ...(card.openingAssetIds ?? []),
    ...(card.manualAssetIds ?? []),
    ...(card.assetBindingRequirements ?? []).flatMap(binding => binding.confirmed && binding.assetId ? [binding.assetId] : []),
    ...evidence.mentions.filter(hit => !hit.literal).map(hit => hit.id),
  ])
  card.shots.forEach((shot, index) => {
    for (const id of shot.speakerAssetIds ?? []) retained.add(id)
    for (const id of shot.visualAssetIds ?? []) {
      if (!cameraById.get(id)?.has(index)) retained.add(id)
    }
  })
  const candidates = assets.filter(asset => cameraById.has(asset.id) && !retained.has(asset.id) && asset.kind !== 'audio')
  if (!candidates.length) return normalized
  const shotText = [card.scene && '场景：' + card.scene, card.opening && '开场画面：' + card.opening,
    card.characters && '人物：' + card.characters, ...card.shots.flatMap(shot => [shot.action && '画面与动作：' + shot.action,
      shot.dialogue && '对白：' + shot.dialogue])].filter(Boolean).join('\n')
  const structured = annotateScriptVideoAssets(shotText, candidates, card.assetIds)
  for (const hit of structured.mentions) if (!hit.literal) retained.add(hit.id)
  const removed = new Set(candidates.filter(asset => !retained.has(asset.id)).map(asset => asset.id))
  if (!removed.size) return normalized
  const keep = (id: string) => !removed.has(id)
  return { ...normalized, assetIds: card.assetIds.filter(keep), shots: shots.map(shot => shot.visualAssetIds?.some(id => removed.has(id))
    ? { ...shot, visualAssetIds: shot.visualAssetIds.filter(keep) } : shot) }
}

export function scriptVideoMaterialIds(
  card: {
    assetIds: readonly string[]
    excludedAssetIds?: readonly string[]
    openingAssetIds?: readonly string[]
    manualAssetIds?: readonly string[]
    shots: ReadonlyArray<{ dialogue?: string; visualAssetIds?: readonly string[]; speakerAssetIds?: readonly string[] }>
  },
  body: string,
  scan: { mentions: readonly AssetMention[]; contextAssetIds: readonly string[] },
) {
  const shots = scriptVideoShotHeadings(body)
  const excluded = new Set(card.excludedAssetIds)
  const pictures = new Set([...(card.openingAssetIds ?? []), ...(card.manualAssetIds ?? [])])
  const speakers = new Set<string>()
  if (!shots.length) {
    return {
      imageIds: [...new Set([...scriptVideoVisualAssetIds(scan, card.assetIds), ...(card.manualAssetIds ?? [])])].filter(id => !excluded.has(id)),
      speakerIds: scan.mentions.filter(hit => hit.usage === 'speaker').map(hit => hit.id),
    }
  }
  const sections = [...body.matchAll(cardSection)]
  for (const { index } of shots) {
    const shot = card.shots[index]
    for (const id of shot?.visualAssetIds ?? []) pictures.add(id)
    if (shot?.dialogue?.trim() && !/^(?:无|无对白|无台词|沉默|静默)[。！!]?$/u.test(shot.dialogue.trim()))
      for (const id of shot.speakerAssetIds ?? []) speakers.add(id)
  }
  let shotIndex = -1, sectionIndex = -1
  for (const hit of scan.mentions) {
    if (hit.usage !== 'visual' && hit.usage !== 'speaker') continue
    while ((shots[shotIndex + 1]?.start ?? Infinity) <= hit.start) shotIndex++
    while ((sections[sectionIndex + 1]?.index ?? Infinity) <= hit.start) sectionIndex++
    const shot = shots[shotIndex]
    const section = sections[sectionIndex]
    const inShot = shot && shot.start > (section?.index ?? -1)
    if (inShot) {
      if (hit.usage === 'speaker') speakers.add(hit.id)
      else pictures.add(hit.id)
    } else if (hit.usage === 'visual' && (section?.[2] || section?.[1] && (hit.explicit || !card.openingAssetIds) ||
      hit.explicit && (!section || section[3]))) {
      pictures.add(hit.id)
    }
  }
  return {
    imageIds: [...pictures].filter(id => !excluded.has(id)),
    speakerIds: [...speakers].filter(id => !excluded.has(id)),
  }
}
