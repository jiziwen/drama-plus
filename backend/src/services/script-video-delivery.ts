import { omitScriptVideoRecapQuotes, replaceScriptVideoPromptStyle } from './script-video-format.js'
import type { ScriptVideoReferenceSettings } from './script-video-reference-settings.js'
import { annotateScriptVideoInnerOs, hasExplicitScriptVideoInnerOs, hasScriptVideoInnerOs, SCRIPT_VIDEO_INNER_OS_DIRECTION } from './script-video-inner-os.js'
import { mapScriptVideoSoundLine, scriptVideoSpeakerSeparator, speechClosers, unquotedSpeaker, withoutScriptVideoVoiceCues } from './script-video-foley.js'
import { annotateScriptVideoAssets, describeScriptVideoReferenceProblem, scriptVideoAudioReferences, scriptVideoMaterialEvidenceText, scriptVideoMaterialIds, type AssetMention } from './script-video-mentions.js'
import type { ScriptVideoAssetBindingRequirement } from './script-video-asset-scenes.js'
import { scriptVideoShotHeadings, splitScriptVideoHandoff } from './script-video-asset-scope.js'
import { declaredScriptVideoSceneName } from './script-video-scene-continuity.js'
import { bindScriptVideoLighting, sceneGradedStyle, type ScriptVideoLightingRange, type ScriptVideoReferenceLimits } from './script-video-lighting-delivery.js'
import { scriptVideoCapabilities } from './script-video-capabilities.js'
import { scriptVideoPromptStylePrefix, type ScriptVideoStylePreset } from './script-video-style.js'
import { isSeedance25Model, seedanceModelLimits } from './seedance-models.js'
import { jimengVideoModel } from './jimeng-video-models.js'
import { libtvVideoModel, LIBTV_SEEDANCE_20_MINI_MODEL } from './libtv-video-models.js'
import { aicostVideoModelCapabilities, isAicostMiniMaxH3Model, isAicostSeedance25Model } from './aicost-video-models.js'
import type { ScriptVideoVoiceMode } from './script-video-types.js'
import type { ScriptVideoPromptMode } from './video-prompt-mode.js'
import { renderScriptVideoCultivationTimeline } from './script-video-cultivation.js'

export type { ScriptVideoLightingRange, ScriptVideoReferenceLimits } from './script-video-lighting-delivery.js'
export type { ScriptVideoPromptMode } from './video-prompt-mode.js'

export interface ScriptVideoDeliveryAsset {
  id: string
  name: string
  kind?: string
  image: string
  originalName?: string
  sourcePath?: string
  aliases?: string[]
  assetIdentity?: string
  voiceAudio?: { url: string; name: string; duration?: number; mimeType?: string }
  voiceMode?: ScriptVideoVoiceMode
}

export interface ScriptVideoDeliveryCard {
  prompt: string
  duration: number
  assetIds: string[]
  shots: ReadonlyArray<{ duration: number; camera?: string; action?: string; dialogue?: string; visualAssetIds?: string[]; speakerAssetIds?: string[] }>
  openingAssetIds?: string[]
  scene?: string
  sourceSceneIds?: string[]
  assetBindingRequirements?: ScriptVideoAssetBindingRequirement[]
  openingRecap?: string
  characters?: string
  excludedAssetIds?: string[]
  manuallyAdded?: true
  referenceFrameSettings?: ScriptVideoReferenceSettings
}

export interface ScriptVideoContinuation {
  previousCardId: string
  previousEpisodeId?: string
  previousTaskId?: number
  previousVideoUrl?: string
  manualSeconds?: number
  imageUrl: string
  mode: 'first-frame' | 'reference'
}

export interface ScriptVideoDeliveryOptions {
  model?: string
  provider?: string
  /** App settings supply the layout; unspecified preserves the original inline format. */
  promptMode?: ScriptVideoPromptMode
  stylePreset?: ScriptVideoStylePreset
  cast?: readonly { name: string }[]
  continuation?: ScriptVideoContinuation
  lightingRanges?: readonly ScriptVideoLightingRange[]
  referenceLimits?: ScriptVideoReferenceLimits
  duration?: number
  /** Show the available prompt and report unresolved materials without submitting. */
  preview?: true
}

const pictureDuties: Record<string, string> = {
  scene: '场景布局', prop: '道具形态', character: '人物造型', creature: '生物外形',
}
const shotHeading = /^镜头\s+(\d+)[（(](\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)秒[）)]$/gmu
const shotBoundary = /(?=^镜头[ \t]*\d+[^\r\n]*$)/mu
const actionField = /^画面与动作[：:]/u
const cameraField = /^景别(?:[／/]机位[／/]运动)?[：:]/u
const soundField = /^(?:对白[ \t]*[／/][ \t]*音效|对白|台词)[：:][ \t]*/u
const legacyShotBody = new RegExp([cameraField.source, actionField.source, soundField.source].join('|'), 'mu')
const soundEffect = /^(?:音效|拟音|环境音|环境声|动作音)$/u
const leadingMovement = /^[ \t]*(?:迈步|走向|走到|走上|走近|起身|起步|上前|向前|前移|出列|跑向|冲向)/u

function retimeShotText(body: string, card: ScriptVideoDeliveryCard, duration: number) {
  let elapsed = 0
  const boundaries = [0, ...card.shots.map((shot, index) => {
    elapsed += shot.duration
    return index === card.shots.length - 1 ? duration : Number((elapsed * duration / card.duration).toFixed(6))
  })]
  return body.replace(/^([ \t]*(?:总时长[ \t]*[：:]|全段)[ \t]*)\d+(?:\.\d+)?([ \t]*秒)/gmu,
    (_, label, unit) => `${label}${duration}${unit}`)
    .replace(/^[ \t]*镜头[ \t]*(\d+)[ \t]*[（(][ \t]*\d+(?:\.\d+)?[ \t]*(?:秒|s)?[ \t]*[–—-][ \t]*\d+(?:\.\d+)?[ \t]*(?:秒|s)[ \t]*[）)][ \t]*$/gmu,
      (heading, number: string) => {
        const index = Number(number)
        if (index < 1 || index >= boundaries.length) return heading
        return `镜头 ${number}（${boundaries[index - 1]}–${boundaries[index]}秒）`
      })
}

/** Use shot action to resolve first appearance. Camera notes may name later
 * subjects before the shot actually shows them, and the cast list is not a shot. */
function seedanceVisualOrder(body: string, visual: readonly AssetMention[]) {
  let offset = 0
  const order: string[] = []
  for (const block of body.split(shotBoundary)) {
    const start = offset
    offset += block.length
    if (!/^镜头[ \t]*\d+/u.test(block)) continue
    const actions = [...block.matchAll(/^画面与动作[：:][^\r\n]*/gmu)]
    const inAction = (position: number) => actions.some(action =>
      action.index! <= position - start && position - start < action.index! + action[0].length)
    const mentions = visual.filter(item => start <= item.start && item.start < offset)
    order.push(...mentions.filter(item => inAction(item.start)).map(item => item.id), ...mentions.map(item => item.id))
  }
  return order.length ? order : visual.map(item => item.id)
}

type SeedanceSoundContext = {
  audioOnlySpeakers: readonly string[]
  visualSpeakerNames: readonly string[]
  hasMultipleCharacters: boolean
  vocalizationShots: ReadonlySet<number>
}
type ShotSound = { hasInnerVoice: boolean; onCameraSpeakers: Set<string>; hasOnScreenSpeech: boolean; hasVocalization: boolean }

function seedanceShotText(body: string, duration: number, context: SeedanceSoundContext) {
  const headings = [...body.matchAll(shotHeading)]
  // Seedance 2.5 uses whole seconds. Round shared boundaries together, and keep
  // shot order alone if rounding would collapse a shot or the timeline is invalid.
  const secondsFit = headings.length > 0 && Number.isInteger(duration) &&
    headings.every((m, i) => Math.round(+m[3]) > Math.round(+m[2]) &&
      (i ? +m[2] === +headings[i - 1][3] : +m[2] === 0)) &&
    +headings[headings.length - 1][3] === duration
  const blocks = body.replace(shotHeading, (_, n, start, end) =>
    secondsFit ? `镜头${n}（${Math.round(Number(start))}–${Math.round(Number(end))}秒）` : `镜头${n}`)
    .replace(/^←承上[：:]/gmu, '开场画面：')
    .replace(/^→衔接[：:]/gmu, '末镜停在：')
    .replace(/^独立生成[：:]/gmu, '本段事件：')
    .split(shotBoundary).map(block => renderSeedanceShot(block, context))
  const text = blocks.map((block, index) => {
    const next = blocks[index + 1]
    const [nextSpeaker] = next?.sound.onCameraSpeakers || []
    if (context.hasMultipleCharacters && next?.sound.onCameraSpeakers.size === 1 &&
        block.isShot && !block.hasVocalization && !block.sound.hasOnScreenSpeech && !block.sound.hasInnerVoice && block.actionIndex >= 0) {
      const action = block.lines[block.actionIndex]
      if (action.split(nextSpeaker).slice(1).some(part => leadingMovement.test(part))) {
        block.lines[block.actionIndex] += ` ${nextSpeaker}是该动作的主体，沿用对应参考图的脸、发型和服装，由同一人接续下一镜。`
      }
    }
    return block.lines.join('\n')
  }).join('')
  return { text, hasInnerVoice: blocks.some(block => block.sound.hasInnerVoice) }
}

function renderSeedanceShot(block: string, context: SeedanceSoundContext) {
  let inDialogue = false
  const shotNumber = /^镜头[ \t]*(\d+)/u.exec(block)?.[1]
  const isShot = shotNumber !== undefined
  const hasVocalization = isShot && context.vocalizationShots.has(Number(shotNumber))
  const sound: ShotSound = { hasInnerVoice: false, onCameraSpeakers: new Set(), hasOnScreenSpeech: false, hasVocalization }
  const lines = block.split(/\r?\n/u).map(line => {
    const heading = soundField.exec(line)
    if (heading) {
      inDialogue = true
      return heading[0] + soundText(line.slice(heading[0].length), context, sound)
    }
    if (!line.trim() || /^(?:镜头\s*\d|开场画面|末镜停在|景别|画面与动作|场景|人物|本段事件)/u.test(line)) inDialogue = false
    const attribution = /^[^：:]+[：:]/u.exec(line)?.[0] || ''
    const handwritten = /^@图片\d+[^：:]+[：:][ \t]*[“「『"{]/u.test(line) ||
      isNamedVisualSpeaker(attribution, context) && /^[“「『"{]/u.test(line.slice(attribution.length).trimStart()) ||
      hasScriptVideoInnerOs(attribution) || isAudioOnlySpeaker(attribution, context.audioOnlySpeakers)
    return inDialogue || handwritten ? soundText(line, context, sound) : line
  })
  const actionIndex = lines.findIndex(line => actionField.test(line))
  if (isShot) {
    if (context.hasMultipleCharacters && sound.onCameraSpeakers.size === 1 && actionIndex >= 0) {
      const [speaker] = sound.onCameraSpeakers
      lines[actionIndex] += hasVocalization
        ? ` ${speaker}保持对应参考图的造型，说出本镜标注的台词。`
        : ` ${speaker}保持对应参考图的造型，是本镜画内发声者。其他在画人物按本镜安排动作，嘴唇闭合。`
    }
  }
  return { lines, sound, isShot, hasVocalization, actionIndex }
}

function isAudioOnlySpeaker(attribution: string, names: readonly string[]) {
  const label = attribution.trimStart()
  return names.some(name => label.startsWith(name) && /^(?:\s|[（(【\[：:]|$)/u.test(label.slice(name.length)))
}

function isNamedVisualSpeaker(attribution: string, context: SeedanceSoundContext) {
  const label = attribution.trimStart()
  return context.visualSpeakerNames.some(name => label.startsWith(name) &&
    /^(?:\s|[（(【\[：:]|$)/u.test(label.slice(name.length)))
}

function soundText(line: string, context: SeedanceSoundContext, sound: ShotSound): string {
  return mapScriptVideoSoundLine(line, part => renderSpeech(part, context, sound), cue => {
    const labelled = /^[\p{L}]+[ \t]*[：:][ \t]*(.*)$/u.exec(cue)
    if (!labelled) return cue
    const words = labelled[1]
    const closer = speechClosers[words[0]] ?? (words.startsWith('<') ? '>' : undefined)
    const content = closer && words.endsWith(closer) ? words.slice(1, -1) : words
    return '<' + content + '>'
  })
}

function renderSpeech(line: string, context: SeedanceSoundContext, sound: ShotSound): string {
  // Split cues only outside the quotation holding the original spoken words.
  return line.replace(/(^|[;；][ \t]*|(?<=[”」』"}])[ \t，,。.!！？?]*)([^;；：:“”「」『』"{}]+?)[：:][ \t]*(?:“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"]*)"|\{([^}]*)\}|([^;；]+))/gu,
    (_match, sep: string, speaker: string, ...parts: string[]) => {
      const speech = parts.slice(0, 6).find(part => part !== undefined) || ''
      // A bare sound direction can precede a real speaker on the same line.
      // Preserve the direction, then format only the attributed speech.
      if (sound.hasVocalization) {
        for (const pause of speaker.matchAll(/[，,。.!！？?][ \t]*/gu)) {
          const next = pause.index + pause[0].length
          const label = speaker.slice(next)
          if (!/^@图片\d+/u.test(label) && !isNamedVisualSpeaker(label, context) &&
            !isAudioOnlySpeaker(label, context.audioOnlySpeakers)) continue
          if (!unquotedSpeaker.test(label + '：')) continue
          sep += speaker.slice(0, next)
          speaker = hasScriptVideoInnerOs(label)
            ? annotateScriptVideoInnerOs(label + '：', { preserveExplicitInnerOs: true }).slice(0, -1) : label
          break
        }
      }
      if (soundEffect.test(speaker.trim())) return sep + '<' + speech.replace(/^<(.*)>$/u, '$1') + '>'
      const explicitInnerOs = hasExplicitScriptVideoInnerOs(speaker)
      if (explicitInnerOs || speaker.includes(SCRIPT_VIDEO_INNER_OS_DIRECTION)) {
        const label = explicitInnerOs ? speaker.trim()
          : annotateScriptVideoInnerOs(speaker + '：').slice(0, -1).replace(SCRIPT_VIDEO_INNER_OS_DIRECTION, '').trim() + SCRIPT_VIDEO_INNER_OS_DIRECTION
        sound.hasInnerVoice = true
        return `${sep}${label} ：“${speech}”`
      }
      const offscreen = /(?:V\.?O\.?|O\.?V\.?)[）)】\]]|画外|旁白|只闻其声/iu.test(speaker)
      const labels = withoutScriptVideoVoiceCues(speaker).split(/[【（(\[]/u, 1)[0].split(scriptVideoSpeakerSeparator)
      for (const label of labels) {
        if (offscreen || isAudioOnlySpeaker(label.trimEnd(), context.audioOnlySpeakers)) continue
        sound.hasOnScreenSpeech = true
        const onCamera = /^\s*(@图片\d+.+)/u.exec(label)?.[1].trimEnd() ||
          (isNamedVisualSpeaker(label, context) ? label.trim() : undefined)
        if (onCamera) sound.onCameraSpeakers.add(onCamera)
      }
      if (!/^\s*(?:@图片\d+|旁白|画外音|心声)/u.test(speaker) &&
        !isNamedVisualSpeaker(speaker, context) &&
        !labels.some(label => isAudioOnlySpeaker(label.trimEnd(), context.audioOnlySpeakers))) return _match
      return sep + speaker + '：{' + speech + '}'
    })
}

function screenTextNotes(body: string): string {
  const carriers = new Set<string>()
  for (const field of body.matchAll(/^画面与动作[：:]([^\n\r]*)/gmu)) {
    for (const m of field[1].matchAll(/(圣旨|诏书|牌匾|匾额|系统面板|系统界面|手机屏幕|屏幕|门牌|路牌)[^。！？；;：:\n]{0,18}?(?:显示出?|写着|写有|题着|刻着|文字为|字幕为|浮现)(?:文字|字样|一行字)?[：:\s]*[“「『"〖]/gu)) {
      if (!/(?:禁止|不许|不得|不应|不可|不再|不会|不)\s*(?:显示|写|刻|浮现)/u.test(m[0])) carriers.add(m[1])
    }
  }
  return carriers.size ? '只在' + [...carriers].join('、') + '上呈现本段指定文字，无额外对白字幕。' : ''
}

function voiceReferenceUrl(asset: ScriptVideoDeliveryAsset | undefined) {
  const url = asset?.voiceAudio?.url
  return (asset?.kind === 'character' || asset?.kind === 'audio') && typeof url === 'string' && url.trim() ? url : undefined
}

export function scriptVideoVoiceSource(asset: ScriptVideoDeliveryAsset | undefined) {
  if (asset?.kind === 'audio') return voiceReferenceUrl(asset)
  if (asset?.kind !== 'character') return undefined
  return voiceReferenceUrl(asset) ?? (asset.voiceMode === 'model' ? 'model' : 'reference')
}

function usesPickedAudio(mention: AssetMention, audioIds: ReadonlySet<string>, byId: ReadonlyMap<string, ScriptVideoDeliveryAsset>) {
  return !!mention.manualAudioId && audioIds.has(mention.manualAudioId) && !!voiceReferenceUrl(byId.get(mention.manualAudioId))
}

function automaticSpeakers(
  talking: ReadonlySet<string>, mentions: readonly AssetMention[],
  audioIds: ReadonlySet<string>, byId: ReadonlyMap<string, ScriptVideoDeliveryAsset>,
) {
  const picked = new Set<string>()
  const automatic = new Set<string>()
  for (const mention of mentions) {
    if (mention.usage !== 'speaker') continue
    const group = usesPickedAudio(mention, audioIds, byId) ? picked : automatic
    group.add(mention.id)
  }
  return new Set([...talking].filter(id => !picked.has(id) || automatic.has(id)))
}

function inspectScriptVideoDelivery<A extends ScriptVideoDeliveryAsset>(
  card: ScriptVideoDeliveryCard, assets: readonly A[], options: ScriptVideoDeliveryOptions,
) {
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const assetIds = card.assetIds || []
  const style = options.stylePreset && scriptVideoPromptStylePrefix(options.stylePreset)
  const prompt = typeof card.prompt === 'string' ? card.prompt : ''
  let body = options.stylePreset ? replaceScriptVideoPromptStyle(prompt, options.stylePreset) : prompt
  if (style) body = body.slice(style.length).replace(/^(?:\r?\n)+/u, '')
  const legend = assetIds.map((id, i) => `图${i + 1} = @${byId.get(id)?.name ?? ''}`).join('，')
  if (legend && body.split(/\r?\n/u, 1)[0] === legend) body = body.slice(legend.length).replace(/^\r?\n/u, '')
  body = annotateScriptVideoInnerOs(omitScriptVideoRecapQuotes(body, card.shots || []), {
    preserveExplicitInnerOs: true,
    referenceAudioNames: [...scriptVideoAudioReferences(assets, body).keys()],
    speakers: [...assets.filter(asset => asset.kind === 'character').map(asset => asset.name),
      ...(options.cast?.map(role => role.name) ?? [])],
  })
  const scanOptions = {
    card, autoBind: true, characters: card.characters, cast: options.cast, excludedIds: card.excludedAssetIds,
    detectUnboundSpeakers: true,
  }
  const scan = annotateScriptVideoAssets(body, assets, assetIds, scanOptions)
  const materialText = scriptVideoMaterialEvidenceText(body, card.shots)
  const evidence = materialText === body ? scan : annotateScriptVideoAssets(materialText, assets, assetIds, scanOptions)
  const materials = scriptVideoMaterialIds(card, materialText, evidence)
  // A character named outside verbatim speech needs an actual reference image
  // even in a recap or an offscreen attribution. Keep its narrative usage so
  // attaching the image does not turn a contextual name into an on-camera role.
  const excluded = new Set(card.excludedAssetIds)
  const referenceGuide = options.promptMode === 'reference-guide'
  const characterReferences = evidence.mentions.filter(hit => !hit.literal && hit.usage !== 'audio' &&
    byId.get(hit.id)?.kind === 'character' && !excluded.has(hit.id))
  const selectedImages = referenceGuide ? assetIds.filter(id => !excluded.has(id) && byId.get(id)?.kind !== 'audio') : []
  const imageIds = [...new Set([...selectedImages, ...materials.imageIds, ...characterReferences.map(hit => hit.id)])]
    .filter(id => byId.get(id)?.kind !== 'audio')
  const referenceOnlyImages = new Set(imageIds.filter(id => !materials.imageIds.includes(id)))
  const speakerIds = materials.speakerIds.filter(id => byId.get(id)?.kind !== 'audio')
  const audioIds = new Set(scan.mentions.filter(hit => hit.usage === 'audio').map(hit => hit.id))
  if (referenceGuide) {
    for (const id of excluded) audioIds.delete(id)
    for (const id of assetIds) {
      const asset = byId.get(id)
      if (!excluded.has(id) && asset?.kind === 'audio' && voiceReferenceUrl(asset)) audioIds.add(id)
    }
  }
  if (card.manuallyAdded) {
    const bound = new Set(assetIds)
    return {
      byId, body, style, scan, referenceOnlyImages,
      imageIds: imageIds.filter(id => bound.has(id) && (referenceGuide || byId.get(id)?.image)),
      talking: new Set(speakerIds.filter(id => bound.has(id))),
      audioIds: new Set([...audioIds].filter(id => bound.has(id))),
      missingVoices: [],
    }
  }
  const talking = new Set(speakerIds)
  const missingVoices = new Set(scan.unboundSpeakers)
  for (const id of automaticSpeakers(talking, scan.mentions, audioIds, byId)) {
    const asset = byId.get(id)
    const source = scriptVideoVoiceSource(asset)
    if (asset && (!source || source === 'reference')) missingVoices.add(asset.name)
  }
  return { byId, body, style, scan, talking, imageIds, referenceOnlyImages, audioIds, missingVoices: [...missingVoices] }
}

export function getScriptVideoMaterialUse(
  card: ScriptVideoDeliveryCard, assets: readonly ScriptVideoDeliveryAsset[], options: ScriptVideoDeliveryOptions = {},
) {
  const { imageIds, talking, audioIds, scan, missingVoices } = inspectScriptVideoDelivery(card, assets, options)
  const speakers = [...talking]
  const mentionedIds = new Set([...scan.contextAssetIds, ...scan.mentions.map(hit => hit.id)])
  const contextIds = [...mentionedIds].filter(id => !imageIds.includes(id) && !talking.has(id) && !audioIds.has(id))
  return { imageIds, speakerIds: speakers, audioIds: [...audioIds], contextIds, missingVoices }
}

export function getScriptVideoMissingVoices(
  card: ScriptVideoDeliveryCard, assets: readonly ScriptVideoDeliveryAsset[], options: ScriptVideoDeliveryOptions = {},
) {
  return inspectScriptVideoDelivery(card, assets, options).missingVoices
}

function voiceAssetIds(
  card: ScriptVideoDeliveryCard, body: string, automatic: ReadonlySet<string>, talking: ReadonlySet<string>,
  visual: readonly string[], seedance25: boolean, referenceOnlyImages: ReadonlySet<string>,
) {
  const knownDialogue = card.shots.some(shot => typeof shot.dialogue === 'string') || /^对白[／/]音效[：:]/mu.test(body)
  const includeVisualVoices = !seedance25 && !knownDialogue
  return [...new Set([...visual, ...automatic])].filter(id => automatic.has(id) ||
    includeVisualVoices && !talking.has(id) && !referenceOnlyImages.has(id))
}

/** Compare the audio sent to the provider and the mode of speakers without a reference. */
export function getScriptVideoVoiceInputs(
  card: ScriptVideoDeliveryCard, assets: readonly ScriptVideoDeliveryAsset[], options: ScriptVideoDeliveryOptions,
) {
  // Old outline cards can be missing shots and bindings.
  const source = {
    ...card,
    assetIds: Array.isArray(card.assetIds) ? card.assetIds : [],
    shots: Array.isArray(card.shots)
      ? card.shots.filter(shot => shot && (shot.dialogue == null || typeof shot.dialogue === 'string'))
      : [],
  }
  const { byId, body, imageIds, referenceOnlyImages, talking, audioIds, scan } = inspectScriptVideoDelivery(source, assets, options)
  const model = options.model || ''
  const seedance25 = options.provider ? scriptVideoDeliveryTags(options).seedance25
    : isSeedance25Model(model) || isAicostSeedance25Model(model)
  const inputByAsset = new Map<string, string>()
  const automatic = automaticSpeakers(talking, scan.mentions, audioIds, byId)
  for (const id of [...voiceAssetIds(source, body, automatic, talking, imageIds,
    seedance25 || options.promptMode === 'reference-guide', referenceOnlyImages), ...audioIds]) {
    const asset = byId.get(id)
    const input = talking.has(id) ? scriptVideoVoiceSource(asset) : voiceReferenceUrl(asset)
    if (input) inputByAsset.set(id, input)
  }
  return inputByAsset
}

export function scriptVideoDeliveryTags(options: Pick<ScriptVideoDeliveryOptions, 'model' | 'provider'>) {
  const model = options.model || ''
  const usesAicost = options.provider?.toLowerCase() === 'aicost'
  const jimeng = options.provider === 'jimeng' ? jimengVideoModel(model) : undefined
  const aicost = usesAicost ? aicostVideoModelCapabilities(model) : null
  const seedance25 = options.provider === 'libtv' && model !== LIBTV_SEEDANCE_20_MINI_MODEL && Boolean(libtvVideoModel(model)) ||
    aicost?.version === '2.5' || isSeedance25Model(model) || (!model && !options.provider)
  const minimax = options.provider === 'minimax' || model === 'wf-minimax-h3' || (usesAicost && isAicostMiniMaxH3Model(model)) || (!options.provider && /^minimax-h3/iu.test(model))
  const wan = options.provider === 'aliyun' || (usesAicost && /^wan3\.0-/iu.test(model)) || (!options.provider && /^wan3\.0-video/iu.test(model))
  const imageTag = (index: number) => minimax ? `<Picture ${index}>` : wan ? `图${index}` : `@图片${index}`
  const audioTag = (index: number) => minimax ? `<Audio ${index}>` : jimeng || options.provider === 'libtv' || seedance25 ? `@音频${index}` : `音频${index}`
  return { aicostSeedance20: aicost?.version === '2.0', seedance25, minimax, imageTag, audioTag }
}

function orderedVisualIds(card: ScriptVideoDeliveryCard, body: string, visual: readonly AssetMention[], activeImages: ReadonlySet<string>, seedance25: boolean) {
  return [...new Set([
    ...(seedance25 ? seedanceVisualOrder(body, visual) : []),
    ...card.assetIds.filter(id => activeImages.has(id)), ...activeImages,
  ])]
}

function groupReferenceVoices<A extends ScriptVideoDeliveryAsset>(
  card: ScriptVideoDeliveryCard, body: string, automatic: ReadonlySet<string>, talking: ReadonlySet<string>,
  orderedIds: readonly string[], byId: ReadonlyMap<string, A>, seedance25: boolean, audioIds: ReadonlySet<string>,
  referenceOnlyImages: ReadonlySet<string>,
) {
  const groups = new Map<string, { asset: A; roles: A[] }>()
  for (const id of new Set([...voiceAssetIds(card, body, automatic, talking, orderedIds, seedance25, referenceOnlyImages), ...audioIds])) {
    const asset = byId.get(id)
    const url = voiceReferenceUrl(asset)
    if (!asset || !url) continue
    const group = groups.get(url)
    if (group) group.roles.push(asset)
    else groups.set(url, { asset, roles: [asset] })
  }
  return [...groups.values()]
}

/** Audio numbers in the editor follow the same attachment order as delivery. */
export function getScriptVideoPromptVoices<A extends ScriptVideoDeliveryAsset>(
  card: ScriptVideoDeliveryCard, assets: readonly A[], options: ScriptVideoDeliveryOptions = {},
) {
  const { byId, body, scan, talking, imageIds, referenceOnlyImages, audioIds } = inspectScriptVideoDelivery(card, assets, options)
  const { seedance25 } = scriptVideoDeliveryTags(options)
  const activeImages = new Set(imageIds)
  const visual = scan.mentions.filter(mention => mention.usage === 'visual' && activeImages.has(mention.id))
  const ordered = orderedVisualIds(card, body, visual, activeImages, seedance25)
  const automatic = automaticSpeakers(talking, scan.mentions, audioIds, byId)
  return groupReferenceVoices(card, body, automatic, talking, ordered, byId,
    seedance25 || options.promptMode === 'reference-guide', audioIds, referenceOnlyImages)
}

export function buildScriptVideoDelivery<A extends ScriptVideoDeliveryAsset>(
  card: ScriptVideoDeliveryCard, assets: readonly A[], options: ScriptVideoDeliveryOptions = {},
) {
  const model = options.model || ''
  const referenceGuide = options.promptMode === 'reference-guide'
  const { aicostSeedance20, seedance25, minimax, imageTag, audioTag } = scriptVideoDeliveryTags(options)
  const { byId, body, style, scan, talking, imageIds, referenceOnlyImages, audioIds, missingVoices } = inspectScriptVideoDelivery(card, assets, options)
  const warnings = new Set<string>()
  const unavailable = new Set<string>()
  const activeImages = new Set(imageIds)
  function referenceIssue(message: string) {
    if (!options.preview) throw new Error(message)
    warnings.add(message)
  }
  if (options.preview) for (const id of card.assetIds || []) {
    if (!byId.has(id)) warnings.add('分镜绑定的资产已不存在：' + id)
  }
  if (!card.manuallyAdded) {
    for (const problem of scan.problems) referenceIssue(describeScriptVideoReferenceProblem(body, problem))
    const boundIds = new Set(card.assetIds)
    if (referenceGuide) for (const id of activeImages) {
      if (boundIds.has(id)) continue
      referenceIssue('@' + (byId.get(id)?.name || id) + ' 尚未绑定该卡素材')
      unavailable.add(id)
      activeImages.delete(id)
      talking.delete(id)
    }
    for (const m of scan.mentions) {
      if (m.explicit && ((m.usage === 'visual' || m.usage === 'context' && !m.literal) && activeImages.has(m.id) || m.usage === 'speaker' && talking.has(m.id) || m.usage === 'audio' && audioIds.has(m.id)) && !boundIds.has(m.id)) {
        referenceIssue('@' + m.name + ' 尚未绑定该卡素材')
        unavailable.add(m.id)
        activeImages.delete(m.id)
        talking.delete(m.id)
        audioIds.delete(m.id)
      }
    }
  }
  for (const id of activeImages) {
    if (!byId.get(id)?.image) {
      referenceIssue('找不到分镜绑定的资产或图片：' + (byId.get(id)?.name || id))
      unavailable.add(id)
      activeImages.delete(id)
    }
  }
  for (const id of audioIds) {
    if (!voiceReferenceUrl(byId.get(id))) referenceIssue('找不到分镜绑定的音频：' + (byId.get(id)?.name || id))
  }
  const visual = scan.mentions.filter(mention => mention.usage === 'visual' && activeImages.has(mention.id))
  const orderedIds = orderedVisualIds(card, body, visual, activeImages, seedance25)
  const automatic = automaticSpeakers(talking, scan.mentions, audioIds, byId)
  const voices = groupReferenceVoices(card, body, automatic, talking, orderedIds, byId,
    seedance25 || referenceGuide, audioIds, referenceOnlyImages)
  const audioByAssetId = new Map(voices.flatMap(({ roles }, i) => roles.map(asset => [asset.id, audioTag(i + 1)] as const)))
  // Providers which require a visual reference alongside audio can anchor an
  // audio-only clip to one speaker image without staging that speaker on camera.
  if (!orderedIds.length && voices.length && (minimax || options.provider === 'volcengine' && seedanceModelLimits(model)?.version === '2.0')) {
    const speaker = [...talking, ...voices.flatMap(voice => voice.roles.map(asset => asset.id))]
      .map(id => byId.get(id)).find(asset => asset?.kind === 'character' && asset.image)
    if (speaker) orderedIds.push(speaker.id)
  }
  const ordered = orderedIds.flatMap(id => {
    const asset = byId.get(id)
    if (asset?.image) return [asset]
    referenceIssue('找不到分镜绑定的资产或图片：' + (asset?.name || id))
    unavailable.add(id)
    return []
  })
  const includedImageIds = new Set(ordered.map(asset => asset.id))
  const images: A[] = []
  const indexByImage = new Map<string, number>()
  for (const asset of ordered) {
    if (indexByImage.has(asset.image)) continue
    images.push(asset)
    indexByImage.set(asset.image, images.length)
  }

  let cursor = 0, output = ''
  const audioOnlySpeakers = new Set<string>()
  const visualSpeakerNames = new Set<string>()
  const vocalizations = scan.mentions.filter(mention => mention.vocalization)
  const vocalizingRoles = new Set(vocalizations.map(mention => mention.id))
  const vocalizationShots = new Set<number>()
  if (seedance25 && vocalizations.length) {
    const headings = scriptVideoShotHeadings(body).reverse()
    for (const mention of vocalizations) {
      const shot = headings.find(heading => heading.start <= mention.start)
      if (shot) vocalizationShots.add(shot.index + 1)
    }
  }
  let previousMention: AssetMention | undefined
  for (const mention of scan.mentions) {
    const { start, end, id, spoken, usage, vocalization } = mention
    const asset = byId.get(id)!
    const surface = body.slice(start, end).replace(/^@/u, '')
    const imageIndex = includedImageIds.has(id) ? indexByImage.get(asset.image) : undefined
    if (usage === 'speaker' && !vocalization && (!imageIndex || referenceOnlyImages.has(id))) {
      audioOnlySpeakers.add(surface)
      if (imageIndex) audioOnlySpeakers.add((referenceGuide ? '@' : imageTag(imageIndex)) + surface)
    }
    if (referenceGuide && imageIndex && asset.kind === 'character' && !mention.literal && !unavailable.has(id)) {
      visualSpeakerNames.add('@' + surface)
    }
    const voiceTag = audioByAssetId.get(id)
    const rendered = mention.literal && (spoken || usage !== 'context') || unavailable.has(id) ? body.slice(start, end) : usage === 'audio' ? voiceTag ?? body.slice(start, end)
      : (usage !== 'context' || !mention.literal) && imageIndex ? (referenceGuide ? '@' : imageTag(imageIndex)) + surface : surface
    const inlineVoice = usage === 'speaker' && voiceTag && (!spoken || vocalization)
      && !usesPickedAudio(mention, audioIds, byId) ? ' ' + voiceTag : ''
    const separator = usage === 'audio' && cursor === start && previousMention?.manualAudioId === id ? ' ' : ''
    output += body.slice(cursor, start) + separator + rendered + inlineVoice
    cursor = end
    previousMention = mention
  }
  output = splitScriptVideoHandoff(output + body.slice(cursor)).body

  const header = ordered.flatMap(asset => {
    const referenceOnly = referenceOnlyImages.has(asset.id)
    const voiceOnly = referenceOnly && talking.has(asset.id) || !activeImages.has(asset.id)
    if (!referenceGuide && !seedance25 && !voiceOnly && !referenceOnly) return []
    const duty = voiceOnly ? '画外声音来源，不安排出镜' : referenceOnly
      ? '人物外观参考，是否出镜以当前分镜为准' : pictureDuties[asset.kind || ''] || '外观'
    return [referenceGuide
      ? `${imageTag(indexByImage.get(asset.image)!)} 是 @${asset.name} 的${pictureDuties[asset.kind || ''] || '外观'}参考图${voiceOnly ? '（画外声音来源，不安排出镜）' : referenceOnly ? '（是否出镜以当前分镜为准）' : ''}。`
      : `${imageTag(indexByImage.get(asset.image)!)} ${asset.name}（${duty}）`]
  }).join(referenceGuide ? '\n' : '，')
  let hasInnerVoice = seedance25 && output.includes(SCRIPT_VIDEO_INNER_OS_DIRECTION)
  const hasMultipleCharacters = images.filter(asset => asset.kind === 'character').length > 1
  const duration = options.duration ?? card.duration
  if (!card.manuallyAdded && duration !== card.duration) output = retimeShotText(output, card, duration)
  const cultivationTimeline = renderScriptVideoCultivationTimeline(output)
  if (cultivationTimeline) output = cultivationTimeline
  else if (seedance25) {
    const rendered = seedanceShotText(output, duration, {
      audioOnlySpeakers: [...audioOnlySpeakers], visualSpeakerNames: [...visualSpeakerNames], hasMultipleCharacters, vocalizationShots,
    })
    output = rendered.text
    hasInnerVoice ||= rendered.hasInnerVoice
  } else if (aicostSeedance20 || seedanceModelLimits(model)?.version === '2.0') output = output.replace(shotHeading, '镜头$1')
  const castContinuity = (referenceGuide && images.some(asset => asset.kind === 'character') || seedance25 && hasMultipleCharacters)
    ? '各角色沿用各自参考图的脸、发型和服装。各镜的走位、动作与画内对白由该镜指定的人物完成。'
    : ''
  const voiceLabel = (asset: A) => {
    if (referenceGuide) return '@' + asset.name
    const index = indexByImage.get(asset.image)
    return index ? imageTag(index) + asset.name : asset.name
  }
  function voiceSpeakers(roles: A[]) {
    const ids = new Set(roles.map(asset => asset.id))
    const picks = scan.mentions.filter(mention => mention.usage === 'speaker' && mention.manualAudioId && ids.has(mention.manualAudioId))
    const picked = picks.flatMap(mention => {
      const asset = byId.get(mention.id)
      return asset?.kind === 'character' ? [asset] : []
    })
    const owners = roles.filter(asset => asset.kind === 'character' &&
      (automatic.has(asset.id) || !picks.some(mention => mention.manualAudioId === asset.id)))
    return [...new Map([...owners, ...picked].map(asset => [asset.id, asset])).values()]
  }
  const referenceVoiceText = referenceGuide ? voices.map(({ roles }, i) => {
    const speakers = voiceSpeakers(roles)
    const names = (speakers.length ? speakers : roles).map(asset => '@' + asset.name).join('、')
    const pickedAudioNames = roles.filter(asset => asset.kind === 'audio').map(asset => '@' + asset.name)
    const pickedNames = speakers.length && pickedAudioNames.length ? '（声音素材：' + pickedAudioNames.join('、') + '）' : ''
    return speakers.length
      ? `${audioTag(i + 1)} 是 ${names} 的配音音色参考${pickedNames}，只参考音色，不照搬音频中的内容。`
      : `${audioTag(i + 1)} 是 ${names} 的声音参考，按本段标注使用。`
  }) : voices.flatMap(({ roles }, i) => voiceSpeakers(roles).map(asset =>
    `${voiceLabel(asset)}的${hasInnerVoice || vocalizingRoles.has(asset.id) ? '角色' : '对白'}音色参考${audioTag(i + 1)}，只参考音色，不照搬音频中的内容。`,
  ))
  const modelVoiceText: string[] = []
  for (const id of automatic) {
    const asset = byId.get(id)
    if (asset && scriptVideoVoiceSource(asset) === 'model') {
      modelVoiceText.push(`${voiceLabel(asset)}由模型生成音色，遵循本段的角色和表演设定，各镜保持同一音色。`)
    }
  }
  const voiceText = [...referenceVoiceText, ...modelVoiceText].join('\n')
  if (voiceText && !referenceGuide) {
    const firstShot = output.search(cultivationTimeline ? /^【\d+(?:\.\d+)?s-/mu : shotBoundary)
    const insertion = firstShot < 0 ? Math.max(0, output.search(legacyShotBody)) : firstShot
    const header = output.slice(0, insertion)
    const separator = header && !/(?:\r?\n){2}$/u.test(header) ? '\n' : ''
    output = header + separator + voiceText + '\n\n' + output.slice(insertion)
  }

  const sceneHeading = /^场景[：:]([^\r\n]*)/mu.exec(body)
  const declaredScene = declaredScriptVideoSceneName(sceneHeading?.[1])
  const sceneMentions = visual.filter(mention => byId.get(mention.id)?.kind === 'scene')
  const anchor = sceneHeading && declaredScene && sceneMentions.find(mention =>
    mention.name.normalize('NFKC') === declaredScene &&
    mention.start >= sceneHeading.index && mention.end <= sceneHeading.index + sceneHeading[0].length)
  const space = anchor && sceneMentions.every(mention => mention.id === anchor.id)
    ? '本段全程在' + imageTag(indexByImage.get(byId.get(anchor.id)!.image)!) + anchor.name + '，机位和景别随分镜变化，拍摄空间保持一致。'
    : ''
  const continuation = options.continuation
  const openingFrame = continuation && {
    ...continuation,
    imageIndex: continuation.mode === 'reference' ? images.length + 1 : undefined,
  }
  const selectedFrame = openingFrame?.manualSeconds !== undefined ? '从上一段成片手动选取的续接画面。' : '从上一段成片尾镜选取的续接画面。'
  const opening = openingFrame && (openingFrame.imageIndex
    ? `以${imageTag(openingFrame.imageIndex)}作为本段首帧，这是${selectedFrame}`
    : '本次提交的首帧是' + selectedFrame) + '开场保持该帧的构图、机位、角色站位和道具状态，接着完成当前动作，再按本段分镜继续。'
  // Custom ComfyUI workflows can reuse a model label with a different count.
  // Their server-filtered ranges are authoritative when previewing a snapshot.
  const limits = options.referenceLimits ?? (options.provider && options.provider !== 'comfyui'
    ? scriptVideoCapabilities(options.provider, model) ?? undefined : undefined)
  const lighting = bindScriptVideoLighting(options.lightingRanges ?? [], card.shots.length, images, voices.length, openingFrame, limits, imageTag, card.referenceFrameSettings)
  const materialGuide = referenceGuide && [header,
    openingFrame?.imageIndex && `${imageTag(openingFrame.imageIndex)} 是续接参考图。`,
    ...lighting.lightingImages.map((url, index) => {
      const sceneName = lighting.lightingRanges.find(range => range.imageUrl === url)?.sceneName
      return `${imageTag(images.length + Number(!!openingFrame?.imageIndex) + index + 1)} 是${sceneName || '同场'}的光线与影调参考图。`
    }),
  ].filter(Boolean).join('\n')
  const styleInstructions = style && sceneGradedStyle(style, lighting.lightingRanges)
  const guide = [materialGuide, voiceText].filter(Boolean).join('\n')
  const prefix = referenceGuide
    ? [guide && '参考素材：\n' + guide,
      guide && '请同时参考以上素材，保持人物形象、人物音色、场景、道具和画面的连续性。',
      castContinuity, opening, space, lighting.prompt, styleInstructions]
    : [styleInstructions, opening, header, castContinuity, space, lighting.prompt]
  const prompt = [...prefix,
    seedance25 && screenTextNotes(body), output]
    .filter(Boolean).join('\n\n').trim()
  const imageBindings = ordered.map(asset => ({ assetId: asset.id, index: indexByImage.get(asset.image)! }))
  return { prompt, images, voices, missingVoices, imageBindings, openingFrame,
    ...(warnings.size && { warnings: [...warnings] }),
    lightingImages: lighting.lightingImages, lightingRanges: lighting.lightingRanges }
}
