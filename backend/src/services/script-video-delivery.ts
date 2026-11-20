import { omitScriptVideoRecapQuotes, replaceScriptVideoPromptStyle } from './script-video-format.js'
import { annotateScriptVideoInnerOs, SCRIPT_VIDEO_INNER_OS_DIRECTION } from './script-video-inner-os.js'
import { annotateScriptVideoAssets, describeScriptVideoReferenceProblem, scriptVideoMaterialEvidenceText, scriptVideoMaterialIds, type AssetMention } from './script-video-mentions.js'
import { scriptVideoOsFraming } from './script-video-os-framing.js'
import { splitScriptVideoHandoff } from './script-video-asset-scope.js'
import { declaredScriptVideoSceneName } from './script-video-scene-continuity.js'
import { bindScriptVideoLighting, sceneGradedStyle, type ScriptVideoLightingRange, type ScriptVideoReferenceLimits } from './script-video-lighting-delivery.js'
import { scriptVideoCapabilities } from './script-video-capabilities.js'
import { scriptVideoPromptStylePrefix, type ScriptVideoStylePreset } from './script-video-style.js'
import { isSeedance25Model, seedanceModelLimits } from './seedance-models.js'
import { jimengVideoModel } from './jimeng-video-models.js'
import { libtvVideoModel } from './libtv-video-models.js'
import { aicostVideoModelCapabilities, isAicostMiniMaxH3Model, isAicostSeedance25Model } from './aicost-video-models.js'
import type { ScriptVideoVoiceMode } from './script-video-types.js'

export type { ScriptVideoLightingRange, ScriptVideoReferenceLimits } from './script-video-lighting-delivery.js'

export interface ScriptVideoDeliveryAsset {
  id: string
  name: string
  kind?: string
  image: string
  originalName?: string
  sourcePath?: string
  voiceAudio?: { url: string; name: string; duration?: number; mimeType?: string }
  voiceMode?: ScriptVideoVoiceMode
}

export interface ScriptVideoDeliveryCard {
  prompt: string
  duration: number
  assetIds: string[]
  shots: ReadonlyArray<{ duration: number; camera?: string; action?: string; dialogue?: string; visualAssetIds?: string[]; speakerAssetIds?: string[] }>
  openingAssetIds?: string[]
  openingRecap?: string
  characters?: string
  excludedAssetIds?: string[]
  manuallyAdded?: true
}

export interface ScriptVideoContinuation {
  previousCardId: string
  previousTaskId: number
  imageUrl: string
  mode: 'first-frame' | 'reference'
}

export interface ScriptVideoDeliveryOptions {
  model?: string
  provider?: string
  stylePreset?: ScriptVideoStylePreset
  cast?: readonly { name: string }[]
  continuation?: ScriptVideoContinuation
  lightingRanges?: readonly ScriptVideoLightingRange[]
  referenceLimits?: ScriptVideoReferenceLimits
  duration?: number
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
  voiceTags: ReadonlyMap<string, string>
  hasMultipleCharacters: boolean
}
type ShotSound = { innerSpeakers: string[]; onCameraSpeakers: Set<string>; hasOnScreenSpeech: boolean }

function seedanceShotText(body: string, duration: number, context: SeedanceSoundContext): string {
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
  return blocks.map((block, index) => {
    const next = blocks[index + 1]
    const [nextSpeaker] = next?.sound.onCameraSpeakers || []
    if (context.hasMultipleCharacters && next?.sound.onCameraSpeakers.size === 1 &&
        block.isShot && !block.sound.hasOnScreenSpeech && !block.sound.innerSpeakers.length && block.actionIndex >= 0) {
      const action = block.lines[block.actionIndex]
      if (action.split(nextSpeaker).slice(1).some(part => leadingMovement.test(part))) {
        block.lines[block.actionIndex] += ` ${nextSpeaker}是该动作的主体，沿用对应参考图的脸、发型和服装，由同一人接续下一镜。`
      }
    }
    return block.lines.join('\n')
  }).join('')
}

function renderSeedanceShot(block: string, context: SeedanceSoundContext) {
  let inDialogue = false
  const sound: ShotSound = { innerSpeakers: [], onCameraSpeakers: new Set(), hasOnScreenSpeech: false }
  const lines = block.split(/\r?\n/u).map(line => {
    const heading = soundField.exec(line)
    if (heading) {
      inDialogue = true
      return heading[0] + soundText(line.slice(heading[0].length), context, sound)
    }
    if (!line.trim() || /^(?:镜头\s*\d|开场画面|末镜停在|景别|画面与动作|场景|人物|本段事件)/u.test(line)) inDialogue = false
    const attribution = /^[^：:]+[：:]/u.exec(line)?.[0] || ''
    const handwritten = /^@图片\d+[^：:]+[：:][ \t]*[“「『"{]/u.test(line) ||
      attribution.includes(SCRIPT_VIDEO_INNER_OS_DIRECTION) || isAudioOnlySpeaker(attribution, context.audioOnlySpeakers)
    return inDialogue || handwritten ? soundText(line, context, sound) : line
  })
  const onlyInnerSpeech = sound.innerSpeakers.length > 0 && !sound.hasOnScreenSpeech
  if (onlyInnerSpeech) {
    const soundIndex = lines.findIndex(line => soundField.test(line))
    if (soundIndex >= 0) lines[soundIndex] = lines[soundIndex].replace(soundField, '声音：')
  }
  const isShot = /^镜头[ \t]*\d+/u.test(block)
  const actionIndex = lines.findIndex(line => actionField.test(line))
  if (isShot) {
    const cameraIndex = lines.findIndex(line => cameraField.test(line))
    if (onlyInnerSpeech && cameraIndex >= 0 && actionIndex >= 0) {
      const camera = lines[cameraIndex].replace(cameraField, '')
      const action = lines[actionIndex].replace(actionField, '')
      const cameraRefs = camera.match(/@图片\d+/gu) || []
      const innerRefs = new Set(sound.innerSpeakers.flatMap(speaker => speaker.match(/^@图片\d+/u) || []))
      // If the camera is already on another character's reaction, keep it there.
      if (cameraRefs.length ? cameraRefs.every(ref => innerRefs.has(ref)) :
        sound.innerSpeakers.some(speaker => camera.includes(speaker) || action.includes(speaker))) {
        const framing = scriptVideoOsFraming(camera, action)
        if (framing) {
          lines[cameraIndex] = `景别／机位／运动：${framing.camera}；主体为${[...new Set(sound.innerSpeakers)].join('、')}`
          lines[actionIndex] = `画面与动作：${framing.action}`
        }
      }
    }
    if (context.hasMultipleCharacters && sound.onCameraSpeakers.size === 1 && actionIndex >= 0) {
      const [speaker] = sound.onCameraSpeakers
      lines[actionIndex] += ` ${speaker}保持对应参考图的造型，是本镜画内发声者。其他在画人物按本镜安排动作，嘴唇闭合。`
    }
  }
  return { lines, sound, isShot, actionIndex }
}

function isAudioOnlySpeaker(attribution: string, names: readonly string[]) {
  const label = attribution.trimStart()
  return names.some(name => label.startsWith(name) && /^(?:\s|[（(【\[：:]|$)/u.test(label.slice(name.length)))
}

function soundText(line: string, context: SeedanceSoundContext, sound: ShotSound): string {
  // Split cues only outside the quotation holding the original spoken words.
  return line.replace(/(^|[;；][ \t]*|(?<=[”」』"}])[ \t]*)([^;；：:“”「」『』"{}]+?)[：:][ \t]*(?:“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"]*)"|\{([^}]*)\}|([^;；]+))/gu,
    (_match, sep: string, speaker: string, ...parts: string[]) => {
      const speech = parts.slice(0, 6).find(part => part !== undefined) || ''
      if (soundEffect.test(speaker.trim())) return sep + '<' + speech.replace(/^<(.*)>$/u, '$1') + '>'
      if (speaker.includes(SCRIPT_VIDEO_INNER_OS_DIRECTION)) {
        const label = speaker.replace(SCRIPT_VIDEO_INNER_OS_DIRECTION, '').replace(/（音色参考@音频\d+）/gu, '').trim()
        const speakerName = label.split(/[【（(\[]/u, 1)[0].trimEnd()
        const actor = label.replace(/^@图片\d+[ \t]*/u, '')
        const audio = context.voiceTags.get(speakerName)
        sound.innerSpeakers.push(speakerName)
        return `${sep}画外心声（V.O.，${actor}${audio ? `，音色参考${audio}` : ''}，仅声音，画内闭口不对口型）：{${speech}}`
      }
      const offscreen = /(?:V\.?O\.?|O\.?V\.?)[）)】\]]|画外|旁白|只闻其声/iu.test(speaker) ||
        isAudioOnlySpeaker(speaker, context.audioOnlySpeakers)
      if (!offscreen) sound.hasOnScreenSpeech = true
      const onCamera = /^\s*(@图片\d+[^【（(\[]+)/u.exec(speaker)?.[1].trimEnd()
      if (onCamera && !offscreen) sound.onCameraSpeakers.add(onCamera)
      if (!/^\s*(?:@图片\d+|旁白|画外音|心声)/u.test(speaker) &&
        !isAudioOnlySpeaker(speaker, context.audioOnlySpeakers)) return _match
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
  return asset?.kind === 'character' && typeof url === 'string' && url.trim() ? url : undefined
}

export function scriptVideoVoiceSource(asset: ScriptVideoDeliveryAsset | undefined) {
  if (asset?.kind !== 'character') return undefined
  return voiceReferenceUrl(asset) ?? (asset.voiceMode === 'model' ? 'model' : 'reference')
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
    speakers: [...assets.filter(asset => asset.kind === 'character').map(asset => asset.name),
      ...(options.cast?.map(role => role.name) ?? [])],
  })
  const scanOptions = {
    autoBind: true, characters: card.characters, cast: options.cast, excludedIds: card.excludedAssetIds,
    detectUnboundSpeakers: true,
  }
  const scan = annotateScriptVideoAssets(body, assets, assetIds, scanOptions)
  const materialText = scriptVideoMaterialEvidenceText(body, card.shots)
  const evidence = materialText === body ? scan : annotateScriptVideoAssets(materialText, assets, assetIds, scanOptions)
  const { imageIds, speakerIds } = scriptVideoMaterialIds(card, materialText, evidence)
  if (card.manuallyAdded) {
    const bound = new Set(assetIds)
    return {
      byId, body, style, scan,
      imageIds: imageIds.filter(id => bound.has(id) && byId.get(id)?.image),
      talking: new Set(speakerIds.filter(id => bound.has(id))),
      missingVoices: [],
    }
  }
  const talking = new Set(speakerIds)
  const missingVoices = new Set(scan.unboundSpeakers)
  for (const id of talking) {
    const asset = byId.get(id)
    const source = scriptVideoVoiceSource(asset)
    if (asset && (!source || source === 'reference')) missingVoices.add(asset.name)
  }
  return { byId, body, style, scan, talking, imageIds, missingVoices: [...missingVoices] }
}

export function getScriptVideoMaterialUse(
  card: ScriptVideoDeliveryCard, assets: readonly ScriptVideoDeliveryAsset[], options: ScriptVideoDeliveryOptions = {},
) {
  const { imageIds, talking, scan, missingVoices } = inspectScriptVideoDelivery(card, assets, options)
  const speakers = [...talking]
  const mentionedIds = new Set([...scan.contextAssetIds, ...scan.mentions.map(hit => hit.id)])
  const contextIds = [...mentionedIds].filter(id => !imageIds.includes(id) && !talking.has(id))
  return { imageIds, speakerIds: speakers, contextIds, missingVoices }
}

export function getScriptVideoMissingVoices(
  card: ScriptVideoDeliveryCard, assets: readonly ScriptVideoDeliveryAsset[], options: ScriptVideoDeliveryOptions = {},
) {
  return inspectScriptVideoDelivery(card, assets, options).missingVoices
}

function voiceAssetIds(card: ScriptVideoDeliveryCard, body: string, talking: ReadonlySet<string>, visual: readonly string[], seedance25: boolean) {
  const knownDialogue = card.shots.some(shot => typeof shot.dialogue === 'string') || /^对白[／/]音效[：:]/mu.test(body)
  const includeVisualVoices = !seedance25 && !knownDialogue
  return [...new Set([...visual, ...talking])].filter(id => includeVisualVoices || talking.has(id))
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
  const { byId, body, imageIds, talking } = inspectScriptVideoDelivery(source, assets, options)
  const model = options.model || ''
  const seedance25 = options.provider ? scriptVideoDeliveryTags(options).seedance25
    : isSeedance25Model(model) || isAicostSeedance25Model(model)
  const inputByAsset = new Map<string, string>()
  for (const id of voiceAssetIds(source, body, talking, imageIds, seedance25)) {
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
  const seedance25 = options.provider === 'libtv' && Boolean(libtvVideoModel(model)) ||
    aicost?.version === '2.5' || isSeedance25Model(model) || (!model && !options.provider)
  const minimax = options.provider === 'minimax' || model === 'wf-minimax-h3' || (usesAicost && isAicostMiniMaxH3Model(model)) || (!options.provider && /^minimax-h3/iu.test(model))
  const wan = options.provider === 'aliyun' || (usesAicost && /^wan3\.0-/iu.test(model)) || (!options.provider && /^wan3\.0-video/iu.test(model))
  const imageTag = (index: number) => minimax ? `<Picture ${index}>` : wan ? `图${index}` : `@图片${index}`
  const audioTag = (index: number) => minimax ? `<Audio ${index}>` : jimeng || seedance25 ? `@音频${index}` : `音频${index}`
  return { aicostSeedance20: aicost?.version === '2.0', seedance25, minimax, imageTag, audioTag }
}

function orderedVisualIds(card: ScriptVideoDeliveryCard, body: string, visual: readonly AssetMention[], activeImages: ReadonlySet<string>, seedance25: boolean) {
  return [...new Set([
    ...(seedance25 ? seedanceVisualOrder(body, visual) : []),
    ...card.assetIds.filter(id => activeImages.has(id)), ...activeImages,
  ])]
}

function groupReferenceVoices<A extends ScriptVideoDeliveryAsset>(
  card: ScriptVideoDeliveryCard, body: string, talking: ReadonlySet<string>,
  orderedIds: readonly string[], byId: ReadonlyMap<string, A>, seedance25: boolean,
) {
  const groups = new Map<string, { asset: A; roles: A[] }>()
  for (const id of voiceAssetIds(card, body, talking, orderedIds, seedance25)) {
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
  const { byId, body, scan, talking, imageIds } = inspectScriptVideoDelivery(card, assets, options)
  const { seedance25 } = scriptVideoDeliveryTags(options)
  const activeImages = new Set(imageIds)
  const visual = scan.mentions.filter(mention => mention.usage === 'visual' && activeImages.has(mention.id))
  const ordered = orderedVisualIds(card, body, visual, activeImages, seedance25)
  return groupReferenceVoices(card, body, talking, ordered, byId, seedance25)
}

export function buildScriptVideoDelivery<A extends ScriptVideoDeliveryAsset>(
  card: ScriptVideoDeliveryCard, assets: readonly A[], options: ScriptVideoDeliveryOptions = {},
) {
  const model = options.model || ''
  const { aicostSeedance20, seedance25, minimax, imageTag, audioTag } = scriptVideoDeliveryTags(options)
  const { byId, body, style, scan, talking, imageIds, missingVoices } = inspectScriptVideoDelivery(card, assets, options)
  if (!card.manuallyAdded) {
    if (scan.problems.length) throw new Error(describeScriptVideoReferenceProblem(body, scan.problems[0]))
    const boundIds = new Set(card.assetIds)
    for (const m of scan.mentions) {
      if (m.explicit && (m.usage === 'visual' && imageIds.includes(m.id) || m.usage === 'speaker' && talking.has(m.id)) && !boundIds.has(m.id))
        throw new Error(`@${m.name} 尚未绑定该卡素材`)
    }
  }
  const activeImages = new Set(imageIds)
  const visual = scan.mentions.filter(mention => mention.usage === 'visual' && activeImages.has(mention.id))
  const orderedIds = orderedVisualIds(card, body, visual, activeImages, seedance25)
  const voices = groupReferenceVoices(card, body, talking, orderedIds, byId, seedance25)
  const audioByAssetId = new Map(voices.flatMap(({ roles }, i) => roles.map(asset => [asset.id, audioTag(i + 1)] as const)))
  // Providers which require a visual reference alongside audio can anchor an
  // audio-only clip to one speaker image without staging that speaker on camera.
  if (!orderedIds.length && voices.length && (minimax || options.provider === 'volcengine' && seedanceModelLimits(model)?.version === '2.0')) {
    orderedIds.push(voices[0].asset.id)
  }
  const ordered = orderedIds.map(id => {
    const asset = byId.get(id)
    if (!asset?.image) throw new Error(`找不到分镜绑定的资产或图片：${id}`)
    return asset
  })
  const includedImageIds = new Set(orderedIds)
  const images: A[] = []
  const indexByImage = new Map<string, number>()
  for (const asset of ordered) {
    if (indexByImage.has(asset.image)) continue
    images.push(asset)
    indexByImage.set(asset.image, images.length)
  }

  let cursor = 0, output = ''
  const audioOnlySpeakers = new Set<string>()
  const voiceTags = new Map<string, string>()
  for (const mention of scan.mentions) {
    const { start, end, id, spoken, usage } = mention
    const asset = byId.get(id)!
    const surface = body.slice(start, end).replace(/^@/u, '')
    const imageIndex = includedImageIds.has(id) ? indexByImage.get(asset.image) : undefined
    if (usage === 'speaker' && !imageIndex) audioOnlySpeakers.add(surface)
    const rendered = spoken ? body.slice(start, end) : usage !== 'context' && imageIndex ? imageTag(imageIndex) + surface : surface
    const voiceTag = audioByAssetId.get(id)
    const inlineVoice = usage === 'speaker' && voiceTag && !spoken ? `（音色参考${voiceTag}）` : ''
    if (inlineVoice && voiceTag) voiceTags.set(rendered, voiceTag)
    output += body.slice(cursor, start) + rendered + inlineVoice
    cursor = end
  }
  output = splitScriptVideoHandoff(output + body.slice(cursor)).body

  const header = ordered.flatMap(asset => {
    const voiceOnly = !activeImages.has(asset.id)
    if (!seedance25 && !voiceOnly) return []
    return [`${imageTag(indexByImage.get(asset.image)!)} ${asset.name}（${voiceOnly ? '画外声音来源，不安排出镜' : pictureDuties[asset.kind || ''] || '外观'}）`]
  }).join('，')
  const hasInnerVoice = seedance25 && output.includes(SCRIPT_VIDEO_INNER_OS_DIRECTION)
  const hasMultipleCharacters = images.filter(asset => asset.kind === 'character').length > 1
  const castContinuity = seedance25 && hasMultipleCharacters
    ? '各角色沿用各自参考图的脸、发型和服装。各镜的走位、动作与画内对白由该镜指定的人物完成。'
    : ''
  const voiceLabel = (asset: A) => {
    const index = indexByImage.get(asset.image)
    return index ? imageTag(index) + asset.name : asset.name
  }
  const referenceVoiceText = voices.flatMap(({ roles }, i) => roles.map(asset =>
    `${voiceLabel(asset)}的${hasInnerVoice ? '角色' : '对白'}音色参考${audioTag(i + 1)}，只参考音色，不照搬音频中的内容。`,
  ))
  const modelVoiceText: string[] = []
  for (const id of talking) {
    const asset = byId.get(id)
    if (asset && scriptVideoVoiceSource(asset) === 'model') {
      modelVoiceText.push(`${voiceLabel(asset)}由模型生成音色，遵循本段的角色和表演设定，各镜保持同一音色。`)
    }
  }
  const voiceText = [...referenceVoiceText, ...modelVoiceText].join('\n')
  const duration = options.duration ?? card.duration
  if (!card.manuallyAdded && duration !== card.duration) output = retimeShotText(output, card, duration)
  if (seedance25) output = seedanceShotText(output, duration, { audioOnlySpeakers: [...audioOnlySpeakers], voiceTags, hasMultipleCharacters })
  else if (aicostSeedance20 || seedanceModelLimits(model)?.version === '2.0') output = output.replace(shotHeading, '镜头$1')
  if (voiceText) {
    const firstShot = output.search(shotBoundary)
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
  const opening = openingFrame && (openingFrame.imageIndex
    ? `以${imageTag(openingFrame.imageIndex)}作为本段首帧，这是从上一段成片尾镜选取的续接画面。`
    : '本次提交的首帧是从上一段成片尾镜选取的续接画面。') + '开场保持该帧的构图、机位、角色站位和道具状态，接着完成当前动作，再按本段分镜继续。'
  // Custom ComfyUI workflows can reuse a model label with a different count.
  // Their server-filtered ranges are authoritative when previewing a snapshot.
  const limits = options.referenceLimits ?? (options.provider && options.provider !== 'comfyui'
    ? scriptVideoCapabilities(options.provider, model) ?? undefined : undefined)
  const lighting = bindScriptVideoLighting(options.lightingRanges ?? [], card.shots.length, images, voices.length, openingFrame, limits, imageTag)
  const prompt = [style && sceneGradedStyle(style, lighting.lightingRanges), opening, header, castContinuity, space, lighting.prompt,
    seedance25 && screenTextNotes(body), output]
    .filter(Boolean).join('\n\n').trim()
  const imageBindings = ordered.map(asset => ({ assetId: asset.id, index: indexByImage.get(asset.image)! }))
  return { prompt, images, voices, missingVoices, imageBindings, openingFrame,
    lightingImages: lighting.lightingImages, lightingRanges: lighting.lightingRanges }
}
