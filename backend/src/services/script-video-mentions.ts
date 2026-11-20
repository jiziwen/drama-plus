import { isScriptVideoChibiAppearance, scriptVideoCharacterBase, scriptVideoCharacterName } from './script-video-asset-identity.js'
import { hasScriptVideoInnerOs } from './script-video-inner-os.js'
import { isScriptVideoNonvisualMention, scriptVideoAssetScopeRanges, scriptVideoShotHeadings } from './script-video-asset-scope.js'

export type MentionAsset = {
  id: string
  name: string
  kind?: string
  originalName?: string
  sourcePath?: string
}
export type AssetMention = {
  id: string
  name: string
  start: number
  end: number
  spoken: boolean
  literal: boolean
  explicit: boolean
  usage: 'visual' | 'speaker' | 'context'
}
export type ScriptVideoReferenceProblem = { type: 'unknown' | 'ambiguous'; name: string; start: number; candidates?: string[] }
type Options = {
  dialogue?: boolean
  protectedPrefix?: string
  excludedIds?: readonly string[]
  autoBind?: boolean
  characters?: string
  cast?: ReadonlyArray<{ name: string }>
  detectUnboundSpeakers?: boolean
}

const wordEnd = /[A-Za-z0-9_-]/u
const unknownName = /^[^\s@，。、；：！？“”‘’「」()（）\[\]【】=,.!?;:]+/u
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const soundHeading = /^\s*(?:对白\s*[/／]\s*音效|对白|台词|画外音|心声)\s*[:：]\s*/u
const unquotedSpeaker = /^\s*@?[\p{L}\p{N}·・、_ /-]+(?:\s*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*\s*[:：]\s*/u
// Build short forms only from identities actually selected for this segment.
const chineseWords = new Intl.Segmenter('zh', { granularity: 'word' })
const collectiveRole = /(?:兵|卫|士|军|卒|众|队|臣|官|民|百姓|侍从)$/u
const individualRole = /(?:小旗|侍卫长|指挥使|太医)$/u
const qQualifier = /(?:3D)?Q版[ \t]*小?[ \t]*$/iu
const foley = /^\s*(?:音效|环境音|环境声|拟音|音乐|配乐|BGM|SFX)\s*[:：]/iu
const visualField = /^[ \t]*(?:←承上|→衔接|末镜停在|开场画面|场景(?:[一二三四五六七八九十\d]+)?|人物|角色设定|景别[^：:\n]*|画面与动作)[ \t]*[:：]/u
const shotTitle = /^[ \t]*镜头[ \t]*\d/u
const otherField = /^[ \t]*(?:总时长|独立生成|本段事件|(?:编辑|制作|导演|手写)?备注|后续(?:计划|说明)|校验说明)[ \t]*[:：]/u
const storyboardField = (text: string) => visualField.test(text) || shotTitle.test(text) || otherField.test(text)
const speakerCue = /^(?<cue>(?:[ \t]*(?:[（(【\[][^\n）)】\]]+[）)】\]]|心声|内心独白|内心|画外音|旁白|说|问|道|答))*)[ \t]*[：:][ \t]*(?<words>.+)/u
const attributionLabel = /^[ \t]*(?<label>@?[\p{L}\p{N}·・、_. /／-]{1,120}?)(?=[ \t]*(?:[（(【\[]|[：:]))/u
const genericSoundLabel = /^(?:音效|拟音|(?:物理|背景)音效|环境(?:音|声)|(?:动作|背景)音|音乐|配乐|BGM|SFX|旁白|画外音|心声|O\.?[SV]\.?|V\.?O\.?|系统(?:面板|界面|播报|提示音|提示|音)?|广播(?:音|声)?|录音|字幕|音色|(?:屏幕|牌匾)(?:显示|文字|字样)?|对白|台词|无台词|无对白|无声|静默|沉默)$/iu
const silentWords = /^(?:(?:[（(【\[]\s*)?(?:无台词|无对白|无对话|无声|沉默|静默|不说话)(?:\s*[）)】\]])?|[-—/]+|“\s*”|「\s*」|『\s*』|"\s*"|\{\s*\})\s*(?:[。，；;]|$)/u
const speechClosers: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"', '{': '}' }

type PromptLine = { value: string; start: number; end: number; inDialogue: boolean; inVisual: boolean; headingLength: number }

function promptLines(text: string, dialogue: boolean): PromptLine[] {
  const matches = [...text.matchAll(/[^\r\n]+/gu)]
  const structured = matches.some(match => storyboardField(match[0]))
  const lines: PromptLine[] = []
  let inDialogue = dialogue, inVisual = !structured && !dialogue, previousEnd = 0
  for (const match of matches) {
    const value = match[0], start = match.index!, end = start + value.length
    const headingLength = soundHeading.exec(value)?.[0].length || 0
    const separated = !value.trim() || /(?:\r?\n){2}/u.test(text.slice(previousEnd, start))
    if (headingLength) {
      inDialogue = true
      inVisual = false
    } else if (!dialogue && (storyboardField(value) || separated)) {
      inDialogue = false
      inVisual = visualField.test(value) || shotTitle.test(value) || !structured
    }
    lines.push({ value, start, end, inDialogue, inVisual, headingLength })
    previousEnd = end
  }
  return lines
}

function isSpeakerAt(text: string, start: number, end: number, line: PromptLine, quoteEnds: ReadonlySet<number>) {
  const lineBodyStart = line.start + line.headingLength
  const before = text.slice(lineBodyStart, start).trimEnd()
  if (before && (!line.inDialogue || !/[；;]$/u.test(before) && !quoteEnds.has(lineBodyStart + before.length))) return false
  if (foley.test(line.value.slice(line.headingLength)) && !before.trim()) return false
  const cue = speakerCue.exec(text.slice(end, line.end))?.groups
  if (!cue || silentWords.test(cue.words)) return false
  const innerOs = hasScriptVideoInnerOs(cue.cue)
  if (!innerOs && /未出声|不出声|无声|静默|沉默/u.test(cue.cue)) return false
  return line.inDialogue || !storyboardField(line.value) && (innerOs || /^[“「『"{]/u.test(cue.words))
}

function unboundSpeakers(
  text: string,
  lines: readonly PromptLine[],
  scopes: ReturnType<typeof scriptVideoAssetScopeRanges>,
  protectedText: ReadonlyArray<[number, number]>,
  quoteEnds: ReadonlySet<number>,
  mentions: readonly AssetMention[],
  problems: readonly ScriptVideoReferenceProblem[],
) {
  const resolved = new Set(mentions.filter(mention => mention.usage === 'speaker').map(mention => mention.start))
  const ambiguous = new Set(problems.filter(problem => problem.type === 'ambiguous').map(problem => problem.name))
  const names = new Set<string>()
  for (const line of lines) {
    if (storyboardField(line.value) && !line.headingLength) continue
    const body = line.value.slice(line.headingLength)
    const start = line.start + line.headingLength
    const offsets = [0]
    if (line.inDialogue) {
      for (const separator of body.matchAll(/[；;]/gu)) {
        const offset = separator.index!
        if (!protectedText.some(([from, to]) => from <= start + offset && start + offset < to)) offsets.push(offset + 1)
      }
      for (const end of quoteEnds) {
        if (end > start && end < line.end && !protectedText.some(([from, to]) => from <= end && end < to)) offsets.push(end - start)
      }
    }
    for (const offset of offsets) {
      const match = attributionLabel.exec(body.slice(offset))
      const label = match?.groups?.label?.trimEnd()
      if (!label) continue
      const name = label.replace(/^@/u, '')
      const position = start + offset + match![0].indexOf(label)
      if (resolved.has(position) || ambiguous.has(name) || !isSpeakerAt(text, position, position + label.length, line, quoteEnds)) continue
      if (scopes.some(scope => scope.start <= position && position < scope.end)) continue
      if (!name.split(/[／/]/u).every(part => genericSoundLabel.test(part.trim()))) names.add(name)
    }
  }
  return [...names]
}

/** Bounds use offsets in the original text, so editing, hover hit-testing and
 * the provider formatter can all address the same occurrence. */
function quotedRanges(text: string): Array<[number, number]> {
  // Quoted speech and verbatim text on a prop or screen stay byte-for-byte
  // intact. This also covers quoted lines embedded in action descriptions.
  return Array.from(text.matchAll(/“[^”\n]*[”\n]?|「[^」\n]*[」\n]?|『[^』\n]*[』\n]?|"[^"\n]*["\n]?|\{[^}\n]*[}\n]?/gu),
    m => [m.index!, m.index! + m[0].length])
}

function literalRanges(lines: PromptLine[], quoted: Array<[number, number]>) {
  const ranges = [...quoted]
  for (const { value, start, inDialogue, headingLength } of lines) {
    if (!inDialogue) continue
    const body = value.slice(headingLength)
    const origin = start + headingLength
    let continuingSpeech = false
    for (const piece of body.matchAll(/[^；;]+/gu)) {
      if (foley.test(piece[0])) {
        continuingSpeech = false
        continue
      }
      const labelLength = unquotedSpeaker.exec(piece[0])?.[0].length || 0
      const speech = piece[0].slice(labelLength)
      if (labelLength) continuingSpeech = !/^[“「『"{]/u.test(speech)
      if (continuingSpeech) {
        const start = origin + piece.index! + labelLength
        ranges.push([start, start + speech.length])
      }
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

function assetNames(asset: MentionAsset) {
  const names = new Set([asset.name])
  if (asset.kind === 'character' || !asset.kind) {
    const characterNames = [asset]
    if (asset.originalName && asset.originalName !== asset.name) {
      characterNames.push({ ...asset, name: asset.originalName })
    }
    const stylized = isScriptVideoChibiAppearance(asset)
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
  return [...names].filter(name => name && (name === asset.name || (name.length > 1 && name !== '群体')))
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
      if (term.length > 1 && filename.includes(term) && candidates.some(item => item.kind === asset.kind)) register(term, asset)
    }
  }
  addCastAliases(options, byName, register)
  const names = [...byName.keys()].sort((a, b) => b.length - a.length)
  // Include bare @ in the same scan: an unknown explicit name cannot fall back
  // to a valid substring later in the token.
  const matcher = new RegExp(names.length ? '@?(' + names.map(escaped).join('|') + ')|@' : '@', 'gu')
  const excluded = new Set(options.excludedIds)
  const mentions: AssetMention[] = []
  const ambiguous = new Set<string>()
  const ambiguityKeys = new Set<string>()
  const unknown = new Set<string>()
  const assetIds = new Set<string>()
  const contextAssetIds = new Set<string>()
  const problems: ScriptVideoReferenceProblem[] = []
  const lines = promptLines(text, options.dialogue || false)
  const quoted = quotedRanges(text)
  const quoteEnds = new Set(quoted.filter(([from, to]) => to - from > 1 && text[to - 1] === speechClosers[text[from]])
    .map(([, to]) => to))
  const protectedText = literalRanges(lines, quoted)
  const scopes = scriptVideoAssetScopeRanges(text, options.dialogue)
  const prefix = options.protectedPrefix?.trim().replace(/\r\n?/gu, '\n')
  if (prefix) {
    const match = new RegExp('^' + prefix.split('\n').map(escaped).join('(?:\\r\\n|\\r|\\n)')).exec(text)
    matcher.lastIndex = match?.[0].length || 0
  }
  let output = '', previous = 0, range = 0, scopeIndex = 0, lineIndex = 0
  for (let match; (match = matcher.exec(text));) {
    const start = match.index, end = matcher.lastIndex
    const name = match[1]
    const explicit = text[start] === '@'
    while (protectedText[range] && protectedText[range][1] <= start) range++
    const spoken = !!protectedText[range] && protectedText[range][0] <= start
    while (scopes[scopeIndex] && scopes[scopeIndex].end <= start) scopeIndex++
    while (lines[lineIndex] && lines[lineIndex].end <= start) lineIndex++
    const activeScope = scopes[scopeIndex]
    const scope = activeScope && activeScope.start <= start ? activeScope.kind : undefined
    const line = lines[lineIndex]
    const invalidEnd = wordEnd.test(text[end] || '')
    const token = explicit && (!name || invalidEnd) ? unknownName.exec(text.slice(start + 1))?.[0] || '' : ''
    const referenceEnd = token ? start + token.length + 1 : end
    const attribution = line && isSpeakerAt(text, start, referenceEnd, line, quoteEnds)
    const contextual = spoken || scope === 'handoff' || scope === 'sound' || scope === 'summary' && !explicit ||
      line && !attribution && (line.inDialogue || !explicit && !line.inVisual) || isScriptVideoNonvisualMention(text, start, referenceEnd)
    if (!name || invalidEnd) {
      if (explicit) {
        if (!contextual && !unknown.has('@' + token)) {
          unknown.add('@' + token)
          problems.push({ type: 'unknown', name: '@' + token, start })
        }
        matcher.lastIndex = Math.max(end, start + token.length + 1)
      }
      continue
    }
    if (!explicit && /[A-Za-z0-9_-]/u.test(text[start - 1] || '') && /^[A-Za-z0-9_-]/u.test(name)) continue
    // An unbound Q figure must never fall back to the live character's name.
    if (!explicit && qQualifier.test(text.slice(Math.max(0, start - 16), start))) continue
    // The bare category may denote the single group in this card. Never
    // select a project-wide 群体.png from this generic word alone.
    if (!explicit && name === '群体' && boundCrowds.length !== 1) continue
    const namedCandidates = byName.get(name)!
    const speakers = !contextual && attribution ? namedCandidates.filter(asset => !asset.kind || asset.kind === 'character') : []
    const usage = contextual || attribution && !speakers.length ? 'context' : speakers.length ? 'speaker' : 'visual'
    const candidates = speakers.length ? speakers : namedCandidates
    const exact = candidates.filter(a => a.name === name)
    const selected = candidates.filter(a => bound.has(a.id))
    if (usage === 'context') for (const asset of selected) contextAssetIds.add(asset.id)
    if (!explicit && exact.some(a => excluded.has(a.id)) && !exact.some(a => bound.has(a.id))) continue
    let available = selected.length ? selected : (explicit || options.autoBind || usage === 'context' ? candidates.filter(a => !excluded.has(a.id)) : [])
    // Explicit @ names are deliberate asset choices. Bare character names
    // stand for the on-camera costume if it is already bound to this card.
    if (explicit && exact.length === 1) available = exact
    else if (selected.length > 1) {
      const named = selected.filter(a => a.name === name)
      if (named.length === 1) available = named
    }
    if (available.length !== 1) {
      const ambiguityKey = `${explicit ? 'explicit' : 'implicit'}:${name}`
      if (available.length > 1 && usage !== 'context' && !ambiguityKeys.has(ambiguityKey)) {
        ambiguityKeys.add(ambiguityKey)
        ambiguous.add(name)
        problems.push({ type: 'ambiguous', name, start, candidates: [...new Set(available.map(asset => asset.name))] })
      }
      continue
    }
    const asset = available[0]
    // Keep the declared nickname in “@造型（张浩）”. Rewriting the definition
    // would erase the name used in the source and make recovery ambiguous.
    const prior = mentions.at(-1)
    const declaredAlias = prior?.id === asset.id && !explicit
      && /^[（(]$/u.test(text.slice(prior.end, start)) && /^[）)]/u.test(text.slice(end))
    const literal = usage === 'context' || declaredAlias
    mentions.push({ id: asset.id, name: asset.name, start, end, explicit, spoken, literal, usage })
    if (usage !== 'context') assetIds.add(asset.id)
    else contextAssetIds.add(asset.id)
    if (literal) continue
    output += text.slice(previous, start) + '@' + asset.name
    previous = end
  }
  return { text: output + text.slice(previous), mentions, assetIds: [...assetIds], contextAssetIds: [...contextAssetIds],
    unboundSpeakers: options.detectUnboundSpeakers ? unboundSpeakers(text, lines, scopes, protectedText, quoteEnds, mentions, problems) : [],
    problems, ambiguous: [...ambiguous], unknown: [...unknown] }
}

/** Keep explicit library selections that have no textual evidence against their
 * use, including older prompts. A contextual mention alone never ships a picture. */
export function scriptVideoVisualAssetIds(
  scan: { mentions: readonly AssetMention[]; contextAssetIds: readonly string[] }, boundIds: readonly string[],
) {
  const visual = new Set(scan.mentions.filter(hit => hit.usage === 'visual').map(hit => hit.id))
  const contextual = new Set([...scan.contextAssetIds, ...scan.mentions.filter(hit => hit.usage === 'speaker').map(hit => hit.id)])
  return [...new Set([...boundIds.filter(id => !contextual.has(id) || visual.has(id)), ...visual])]
}

const cardSection = /^[ \t]*(?:(←承上|开场画面)|(场景(?:[一二三四五六七八九十\d]+)?)|前镜回顾|人物|角色设定|总时长|独立生成|本段事件|→衔接|末镜停在)[ \t]*[：:]/gmu

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
      shot.camera?.trim() && !/^景别(?:[／/]机位[／/]运动)?[：:]/mu.test(block) && '景别／机位／运动：' + shot.camera,
      shot.action?.trim() && !/^画面与动作[：:]/mu.test(block) && '画面与动作：' + shot.action,
    ].filter(Boolean)
    if (!fields.length) return block
    const end = block.indexOf('\n')
    if (end < 0) return block + '\n' + fields.join('\n')
    return block.slice(0, end + 1) + fields.join('\n') + '\n' + block.slice(end + 1)
  }).join('')
}

export function scriptVideoMaterialIds(
  card: {
    assetIds: readonly string[]
    excludedAssetIds?: readonly string[]
    openingAssetIds?: readonly string[]
    shots: ReadonlyArray<{ dialogue?: string; visualAssetIds?: readonly string[]; speakerAssetIds?: readonly string[] }>
  },
  body: string,
  scan: { mentions: readonly AssetMention[]; contextAssetIds: readonly string[] },
) {
  const shots = scriptVideoShotHeadings(body)
  const excluded = new Set(card.excludedAssetIds)
  const pictures = new Set(card.openingAssetIds)
  const speakers = new Set<string>()
  if (!shots.length) {
    return {
      imageIds: scriptVideoVisualAssetIds(scan, card.assetIds),
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
    if (hit.usage === 'context') continue
    while ((shots[shotIndex + 1]?.start ?? Infinity) <= hit.start) shotIndex++
    while ((sections[sectionIndex + 1]?.index ?? Infinity) <= hit.start) sectionIndex++
    const shot = shots[shotIndex]
    const section = sections[sectionIndex]
    const inShot = shot && shot.start > (section?.index ?? -1)
    if (inShot) {
      if (hit.usage === 'speaker') speakers.add(hit.id)
      else if (!card.shots[shot.index]?.visualAssetIds) pictures.add(hit.id)
    } else if (hit.usage === 'visual' && (section?.[2] || section?.[1] && !card.openingAssetIds)) {
      pictures.add(hit.id)
    }
  }
  return {
    imageIds: [...pictures].filter(id => !excluded.has(id)),
    speakerIds: [...speakers].filter(id => !excluded.has(id)),
  }
}
