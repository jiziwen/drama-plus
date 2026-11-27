import { isSeedance25Model, seedanceModelLimits } from './seedance-models.js'
import { AICOST_VIDEO_RATIOS, AICOST_VIDEO_RESOLUTIONS, aicostVideoModelCapabilities, isAicostMiniMaxH3Model } from './aicost-video-models.js'
import { prepareSeedanceReferenceImage } from './seedance-reference-media.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getAbsolutePath } from '../utils/storage.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { scheduleRetiredUploadCleanup } from './script-video-media-retention.js'
import { canRecoverOriginalVideoTask, generateVideo, resumeRecoverableVideoTask, VIDEO_REQUEST_NOT_SENT_MESSAGE, type VideoSubmissionControl } from './generation.js'
import { publicMediaBaseUrl } from './public-media.js'
import { ffmpeg } from '../utils/ffmpeg.js'
import { isPreTlsConnectionReset } from '../utils/network-error.js'
import { extractVideoTailFrame } from '../utils/video-poster.js'
import { extractVideoReferenceFrame } from '../utils/video-reference-frame.js'
import type { TailShotRange } from '../utils/video-tail-frame.js'
import { resolveMediaConfig } from './media-selection.js'
import { getVideoPromptMode } from './app-settings.js'
import type { ScriptVideoPromptMode } from './video-prompt-mode.js'
import { isScriptVideoGenerationDuration, scriptVideoCapabilities, type ScriptVideoCapabilities } from './script-video-capabilities.js'
import { buildScriptVideoDelivery, scriptVideoDeliveryTags, type ScriptVideoContinuation, type ScriptVideoDeliveryAsset, type ScriptVideoDeliveryCard, type ScriptVideoDeliveryOptions, type ScriptVideoLightingRange } from './script-video-delivery.js'
import { scriptVideoCultivationFinalShot } from './script-video-cultivation.js'
import { safeTaskError } from './video-download.js'
import { aicostVideoSubmissionRejection } from './adapters/aicost-video.js'
import { aliyunWanVideoPrompt } from './adapters/aliyun-wan-video.js'
import { hasScriptVideoPromptBody, splitScriptVideoPromptStyle, type ScriptVideoStylePreset } from './script-video-style.js'
import { manualScriptVideoLightingRanges, sceneGradedStyle } from './script-video-lighting-delivery.js'
import { JimengCliError } from './jimeng-cli.js'
import { LibTVCliError } from './libtv-cli.js'
import { formatJimengScriptPrompt } from './jimeng-reference-labels.js'
import { jimengVideoModel } from './jimeng-video-models.js'
import { LIBTV_VIDEO_RATIOS, libtvVideoModel } from './libtv-video-models.js'
import { scriptVideoAssetBindingIssues } from './script-video-asset-bindings.js'

type Asset = ScriptVideoDeliveryAsset
export type ScriptVideoContinuationSource = {
  previousCardId: string
  sourceEpisodeId?: string
  previousTaskId?: number
  videoUrl: string
  shotStartSeconds?: number
  shotEndSeconds?: number
  manualSeconds?: number
}

export interface ScriptVideoGenerationInput {
  projectId: string
  episodeId: string
  card: ScriptVideoDeliveryCard & { id: string }
  cast?: { name: string }[]
  assets: Asset[]
  configId: number
  model: string
  aspectRatio: string
  resolution: string
  duration?: number
  promptMode?: ScriptVideoPromptMode
  stylePreset?: ScriptVideoStylePreset
  continuationSource?: ScriptVideoContinuationSource
  lightingRanges?: readonly ScriptVideoLightingRange[]
  allowJimeng?: boolean
  allowLibTV?: boolean
  videoCliAccountId?: string
}

export class ScriptVideoGenerationValidationError extends Error {
  readonly code = 'VALIDATION'
  constructor(message: string) {
    super(message)
    this.name = 'ScriptVideoGenerationValidationError'
  }
}

export function scriptVideoMissingVoicesMessage(speakers: readonly string[]) {
  return `请为${speakers.map(name => `「${name}」`).join('、')}上传角色参考音频，或在「项目资产」允许模型配音`
}

async function checkedImageSource(asset: Pick<Asset, 'name' | 'image'>, provider: string): Promise<string> {
  if (typeof asset.image !== 'string' || !asset.image.startsWith('/static/') ||
      /[?#%\\\0]/u.test(asset.image) || asset.image.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`@${asset.name} 需要已上传到本项目的参考图`)
  }
  const ext = path.extname(asset.image).toLowerCase()
  const allowed = provider === 'comfyui' ? ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'] : ['.png', '.jpg', '.jpeg', '.webp']
  if (!allowed.includes(ext)) throw new Error(`@${asset.name} 的图片格式不受所选视频服务支持，请上传 PNG、JPG 或 WebP`)
  let local: string
  try {
    local = await fs.realpath(getAbsolutePath(asset.image.slice(1)))
    const root = await fs.realpath(STORAGE_ROOT)
    if (!local.startsWith(root + path.sep)) throw new Error()
    const stat = await fs.stat(local)
    if (!stat.isFile() || stat.size <= 0) throw new Error()
  } catch {
    throw new Error(`@${asset.name} 的图片不存在或无法读取，请重新上传`)
  }
  return local
}

async function checkedReference(asset: Pick<Asset, 'name' | 'image'>, provider: string, model: string, resolution: string): Promise<string> {
  const local = await checkedImageSource(asset, provider)
  if (provider === 'volcengine' && isSeedance25Model(model)) {
    try { return await prepareSeedanceReferenceImage(local, asset.image, resolution) }
    catch (err) { throw new Error(`@${asset.name} 的参考图处理失败：${(err as Error).message}`) }
  }
  return asset.image
}

/** ZIP packaging uses the same source image, decoder and target size as a local
 * Seedance submission. Only decode distinct files in the selected segments. */
export async function prepareScriptVideoArchiveImages(
  cards: ScriptVideoDeliveryCard[], assets: Asset[], options: ScriptVideoDeliveryOptions, resolution: string,
): Promise<Record<string, string>> {
  const selected = new Map<string, Asset>()
  const deliveryOptions = { ...options, promptMode: options.promptMode ?? getVideoPromptMode() }
  for (const card of cards) {
    const { images } = buildScriptVideoDelivery(card, assets, deliveryOptions)
    for (const asset of images) selected.set(asset.image, asset)
  }
  const urls = Object.create(null) as Record<string, string>
  // Decode serially so a large episode doesn't expand all of its full-size images at once.
  for (const asset of selected.values()) {
    urls[asset.image] = await checkedReference(asset, 'volcengine', options.model || 'doubao-seedance-2-5-260628', resolution.toLowerCase())
  }
  return urls
}

async function checkedVoiceSource(asset: Asset) {
  const voice = asset.voiceAudio
  if (!voice || typeof voice.url !== 'string' || !/^\/static\/uploads\/[a-z0-9_-]+\.(?:mp3|wav)$/iu.test(voice.url)) throw new Error(`@${asset.name} 的声音参考须是已上传的 MP3 或 WAV`)
  const ext = path.extname(voice.url).toLowerCase()
  let local: string
  try {
    const root = await fs.realpath(path.join(STORAGE_ROOT, 'uploads'))
    local = await fs.realpath(getAbsolutePath(voice.url.slice(1)))
    if (!local.startsWith(root + path.sep)) throw new Error()
    const stat = await fs.stat(local)
    if (!stat.isFile() || stat.size <= 0 || stat.size > 15 * 1024 * 1024) throw new Error()
  } catch { throw new Error(`@${asset.name} 的声音文件不存在、超出 15MB 或无法读取`) }
  return { local, ext, voice }
}

async function checkedVoiceAudio(asset: Asset): Promise<{ url: string; duration: number }> {
  const { local, ext, voice } = await checkedVoiceSource(asset)
  const metadata = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('声音文件检测超时')), 10_000)
    ffmpeg.ffprobe(local, (error, result) => {
      clearTimeout(timeout)
      if (error) reject(new Error(`@${asset.name} 的声音文件无法解析，请上传有效 MP3 或 WAV`))
      else resolve(result)
    })
  })
  const formats = String(metadata?.format?.format_name || '').split(',')
  const audio = metadata?.streams?.find((stream: any) => stream.codec_type === 'audio')
  if (!audio || !formats.includes(ext.slice(1))) throw new Error(`@${asset.name} 的文件内容与音频格式不符`)
  const duration = Number(metadata.format?.duration || audio.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`@${asset.name} 的声音文件时长不可读取`)
  return { url: voice.url, duration }
}

export function scriptVideoOpeningImage(source: ScriptVideoContinuationSource) {
  if (source.manualSeconds !== undefined) return extractVideoReferenceFrame(source.videoUrl, source.manualSeconds)
  const { shotStartSeconds, shotEndSeconds } = source
  return extractVideoTailFrame(source.videoUrl, shotStartSeconds === undefined || shotEndSeconds === undefined
    ? undefined : { shotStartSeconds, shotEndSeconds })
}

async function prepareOpeningFrame(
  source: ScriptVideoContinuationSource,
  provider: string,
  model: string,
  hasReferences: boolean,
): Promise<ScriptVideoContinuation> {
  const imageUrl = await scriptVideoOpeningImage(source)
  if (!imageUrl && source.manualSeconds !== undefined) throw new Error('手选尾帧不可用，请重新选帧或恢复自动。')
  if (!imageUrl) throw new Error('上一段末镜没有找到稳定的续接画面，请检查上一段视频后再试')
  const supportsFirstFrame = ['volcengine', 'minimax', 'aliyun'].includes(provider) ||
    provider === 'aicost' && isAicostMiniMaxH3Model(model)
  return {
    previousCardId: source.previousCardId, previousVideoUrl: source.videoUrl,
    ...(source.sourceEpisodeId && { previousEpisodeId: source.sourceEpisodeId }),
    ...(source.manualSeconds !== undefined && { manualSeconds: source.manualSeconds }),
    ...(source.previousTaskId && { previousTaskId: source.previousTaskId }), imageUrl,
    mode: supportsFirstFrame && !hasReferences ? 'first-frame' : 'reference',
  }
}

type PreviewCard = ScriptVideoDeliveryCard & { id: string }
type PreviewOptions = Omit<ScriptVideoDeliveryOptions, 'continuation' | 'provider'> & { configId?: number }

export async function prepareScriptVideoDeliveryReferences(
  inputs: readonly { card: PreviewCard; source?: ScriptVideoContinuationSource }[],
  assets: Asset[], options: PreviewOptions,
  lightingRangesByCard: Readonly<Record<string, readonly ScriptVideoLightingRange[]>> = {},
) {
  const continuations: Record<string, ScriptVideoContinuation> = Object.create(null)
  const lightingRanges: Record<string, ScriptVideoLightingRange[]> = Object.create(null)
  const selected = inputs.filter(({ card, source }) => source || (lightingRangesByCard[card.id] ?? options.lightingRanges)?.length)
  if (!selected.length) return { continuations, lightingRanges }
  const config = options.configId !== undefined ? await resolveMediaConfig('video', options) : undefined
  const provider = config?.provider, model = config?.model
  const promptMode = options.promptMode ?? getVideoPromptMode()
  const referenceLimits = config ? scriptVideoCapabilities(config.provider, config.model, config.comfyui) ?? undefined : undefined
  for (const { card, source } of selected) {
    const deliveryOptions = { ...options, provider, model, referenceLimits, promptMode,
      lightingRanges: lightingRangesByCard[card.id] ?? options.lightingRanges }
    const { delivery, continuation } = await prepareCardDelivery(card, assets, deliveryOptions, source)
    if (continuation) continuations[card.id] = continuation
    if (delivery.lightingRanges.length) lightingRanges[card.id] = delivery.lightingRanges
  }
  return { continuations, lightingRanges }
}

export async function prepareScriptVideoContinuations(
  inputs: readonly { card: PreviewCard; source: ScriptVideoContinuationSource }[], assets: Asset[], options: PreviewOptions,
  lightingRangesByCard: Readonly<Record<string, readonly ScriptVideoLightingRange[]>> = {},
) {
  return (await prepareScriptVideoDeliveryReferences(inputs, assets, options, lightingRangesByCard)).continuations
}

async function prepareCardDelivery(
  card: ScriptVideoDeliveryCard, assets: Asset[], options: ScriptVideoDeliveryOptions & {
    requireVoices?: boolean
  },
  source?: ScriptVideoContinuationSource,
  baseline = buildScriptVideoDelivery(card, assets, options),
) {
  if (options.requireVoices && baseline.missingVoices.length) throw new Error(scriptVideoMissingVoicesMessage(baseline.missingVoices))
  // Automatic light references are optional. A manual light needs a mode
  // that can send the selected image alongside the opening frame.
  const manualLights = manualScriptVideoLightingRanges(options.lightingRanges, card.referenceFrameSettings)
  const continuation = source && await prepareOpeningFrame(source, options.provider || '', options.model || '',
    !!(baseline.images.length || baseline.voices.length || manualLights.length)).catch(error => {
    if (!options.preview) throw error
    baseline.warnings = [...(baseline.warnings ?? []), safeTaskError(error)]
    return undefined
  })
  const delivery = continuation ? buildScriptVideoDelivery(card, assets, { ...options, continuation }) : baseline
  const missing = manualLights.filter(light => !delivery.lightingRanges.some(range =>
    range.startShot === light.startShot && range.imageUrl === light.imageUrl))
  if (missing.length) {
    const shots = missing.map(range => '镜头' + range.startShot).join('、')
    const message = '当前模型的参考图配额无法容纳手选光线参考图（' + shots + '），请减少参考图或更换模型。'
    if (!options.preview) throw new Error(message)
    delivery.warnings = [...(delivery.warnings ?? []), message]
  }
  return { delivery, continuation }
}

type CardDelivery = Awaited<ReturnType<typeof prepareCardDelivery>>['delivery']
type PromptReference = { name: string; url: string }

export type ScriptVideoReferenceNames = { images: string[]; audios: string[] }

function promptReference(url: string, name: string): PromptReference {
  // Only expose application-owned media paths. Provider URLs and inline payloads are private.
  const local = /^\/?static\/[^?#%\\\0]+$/u.test(url) && !url.split('/').some(part => part === '.' || part === '..')
  return { name, url: local ? '/' + url.replace(/^\//u, '') : '' }
}

const tailFrameName = '上一段成片尾帧'

function lightingReferenceName(ranges: readonly ScriptVideoLightingRange[], url: string) {
  const scene = ranges.find(range => range.imageUrl === url)?.sceneName
  return scene ? `${scene}光线参考图` : '同场光线参考图'
}

function deliveryReferences(delivery: CardDelivery) {
  return {
    images: [
      ...delivery.images.map(asset => promptReference(asset.image, asset.name)),
      ...(delivery.openingFrame?.imageIndex ? [promptReference(delivery.openingFrame.imageUrl, tailFrameName)] : []),
      ...delivery.lightingImages.map(url => promptReference(url, lightingReferenceName(delivery.lightingRanges, url))),
    ],
    audios: delivery.voices.map(({ asset, roles }) => promptReference(asset.voiceAudio!.url, roles.map(role => role.name).join('、'))),
  }
}

function formatScriptVideoPrompt(
  prompt: string, options: Pick<ScriptVideoDeliveryOptions, 'provider' | 'model'>,
  images: PromptReference[], audios: PromptReference[], firstFrameUrl?: string,
  stylePreset?: ScriptVideoStylePreset, lightingRanges: readonly ScriptVideoLightingRange[] = [],
) {
  const { imageTag, audioTag } = scriptVideoDeliveryTags(options)
  const jimeng = options.provider === 'jimeng'
  const text = jimeng ? formatJimengScriptPrompt(prompt, images.length, audios.length)
    : options.provider === 'aliyun' ? aliyunWanVideoPrompt(prompt) : prompt
  const { style, prefix } = splitScriptVideoPromptStyle(text, stylePreset, value => {
    const graded = sceneGradedStyle(value, lightingRanges)
    return options.provider === 'aliyun' ? aliyunWanVideoPrompt(graded) : graded
  })
  return {
    prompt: text,
    ...(style && { style: { ...style, bodyStart: prefix.length } }),
    images: images.map((image, i) => ({ ...image, index: i + 1, tag: imageTag(i + 1) })),
    audios: audios.map((audio, i) => {
      const index = (jimeng ? images.length : 0) + i + 1
      return { ...audio, index, tag: audioTag(index) }
    }),
    ...(firstFrameUrl && { firstFrame: promptReference(firstFrameUrl, tailFrameName) }),
  }
}

type PromptPreviewInput = Omit<ScriptVideoGenerationInput, 'configId' | 'model' | 'resolution' | 'aspectRatio'> & {
  selection?: Pick<ScriptVideoGenerationInput, 'configId' | 'model' | 'resolution' | 'aspectRatio'>
}

function resolveGenerationDuration(input: Pick<ScriptVideoGenerationInput, 'card' | 'duration'>, limits?: ScriptVideoCapabilities) {
  const duration = input.duration ?? input.card.duration
  if (input.duration !== undefined && !isScriptVideoGenerationDuration(input.duration)) throw new Error('生成时长须为 1–30 的整数秒')
  if (!limits) return duration
  if (duration > limits.maxDuration) {
    const guidance = input.duration === undefined ? '请调整生成时长，或在镜头切点拆分本段，再分别生成。' : '请调整生成时长。'
    throw new Error(`所选模型单次最多 ${limits.maxDuration} 秒。${guidance}`)
  }
  if (duration < limits.minDuration || (limits.wholeSeconds && !Number.isInteger(duration))) {
    throw new Error(`所选模型需要 ${limits.minDuration}–${limits.maxDuration} 的${limits.wholeSeconds ? '整数秒' : '时长（秒）'}，请调整生成时长`)
  }
  return duration
}

function referenceLimitWarnings(limits: ScriptVideoCapabilities, images: number, audios: number, tail: boolean) {
  const messages: string[] = []
  if (limits.maxReferences !== null && images > limits.maxReferences) {
    messages.push(`所选模型最多支持 ${limits.maxReferences} 张参考图${tail ? '（含上一段尾帧）' : ''}，请调整本段资产`)
  }
  if (audios && limits.maxAudioReferences === 0) messages.push('当前视频模型或工作流不支持声音参考，请选择支持声音参考的模型')
  else if (limits.maxAudioReferences !== null && audios > limits.maxAudioReferences) messages.push(`所选模型最多支持 ${limits.maxAudioReferences} 段参考音频`)
  if (limits.maxTotalReferences !== null && images + audios > limits.maxTotalReferences) messages.push(`所选模型最多支持 ${limits.maxTotalReferences} 项图片与音频参考素材`)
  return messages
}

export async function previewScriptVideoPrompt(input: PromptPreviewInput) {
  const { card, selection, cast, stylePreset, continuationSource, lightingRanges } = input
  const config = selection && await resolveMediaConfig('video', selection)
  const limits = config && scriptVideoCapabilities(config.provider, config.model, config.comfyui)
  const options: ScriptVideoDeliveryOptions = { preview: true, provider: config?.provider, model: config?.model, cast, stylePreset, lightingRanges,
    promptMode: input.promptMode ?? getVideoPromptMode(),
    referenceLimits: limits ?? undefined, duration: input.duration === undefined ? undefined : resolveGenerationDuration(input, limits ?? undefined) }

  let assets = input.assets
  let baseline = buildScriptVideoDelivery(card, assets, options)
  const warnings = new Set(baseline.warnings)
  const invalidImages = new Set<string>(), invalidAudios = new Set<string>()
  // Check only files used by this card. Image conversion, audio decoding and
  // provider request validation are submission work and cannot gate reading.
  const [imageFiles, voiceFiles] = await Promise.all([
    Promise.allSettled(baseline.images.map(asset => checkedImageSource(asset, config?.provider || 'comfyui'))),
    Promise.allSettled(baseline.voices.map(({ asset }) => checkedVoiceSource(asset))),
  ])
  imageFiles.forEach((file, index) => {
    if (file.status === 'rejected') {
      invalidImages.add(baseline.images[index].image)
      warnings.add(safeTaskError(file.reason))
    }
  })
  voiceFiles.forEach((file, index) => {
    if (file.status === 'rejected') {
      invalidAudios.add(baseline.voices[index].asset.voiceAudio!.url)
      warnings.add(safeTaskError(file.reason))
    }
  })
  if (invalidImages.size || invalidAudios.size) {
    assets = assets.map(asset => invalidImages.has(asset.image) || invalidAudios.has(asset.voiceAudio?.url ?? '') ? {
      ...asset, ...(invalidImages.has(asset.image) && { image: '' }),
      ...(invalidAudios.has(asset.voiceAudio?.url ?? '') && { voiceAudio: undefined, voiceMode: 'reference' as const }),
    } : asset)
    baseline = buildScriptVideoDelivery(card, assets, options)
  }
  const { delivery } = await prepareCardDelivery(card, assets, options, continuationSource, baseline)
  for (const warning of delivery.warnings ?? []) warnings.add(warning)
  const { images, audios } = deliveryReferences(delivery)
  const firstFrame = delivery.openingFrame?.mode === 'first-frame' ? delivery.openingFrame.imageUrl : undefined
  if (limits) for (const message of referenceLimitWarnings(limits, images.length, audios.length, !!delivery.openingFrame?.imageIndex)) warnings.add(message)
  return { ...formatScriptVideoPrompt(delivery.prompt, options, images, audios, firstFrame, stylePreset, delivery.lightingRanges),
    missingVoices: delivery.missingVoices, source: 'preview' as const, ...(warnings.size && { warnings: [...warnings] }) }
}

/** The route resolves taskId using the server-owned job in the requested project and episode. */
export function getScriptVideoSubmissionPrompt(
  taskId: number, assets: Asset[], names?: ScriptVideoReferenceNames,
  continuation?: ScriptVideoContinuation, lightingRanges: readonly ScriptVideoLightingRange[] = [],
  stylePreset?: ScriptVideoStylePreset,
) {
  const task = db.select({ prompt: schema.sysTask.prompt, params: schema.sysTask.params,
    provider: schema.sysTask.provider, model: schema.sysTask.model })
    .from(schema.sysTask).where(and(eq(schema.sysTask.id, taskId), eq(schema.sysTask.type, 'video'),
      isNull(schema.sysTask.dramaId), isNull(schema.sysTask.storyboardId))).get()
  if (!task?.prompt || !task.params) return undefined
  let params: { referenceImageUrls?: unknown; referenceAudioUrls?: unknown; firstFrameUrl?: unknown }
  try {
    params = JSON.parse(task.params)
    if (!params || typeof params !== 'object') return undefined
  } catch { return undefined }
  const stringUrls = (value: unknown) => Array.isArray(value)
    ? value.map(url => typeof url === 'string' ? url : '')
    : []
  const images = stringUrls(params.referenceImageUrls).map((url, index) => promptReference(url, names?.images[index] ||
    (continuation?.imageUrl === url ? tailFrameName : undefined) ||
    (lightingRanges.some(range => range.imageUrl === url) ? lightingReferenceName(lightingRanges, url) : undefined) ||
    assets.find(asset => asset.image === url)?.name || `参考图 ${index + 1}`))
  const audios = stringUrls(params.referenceAudioUrls).map((url, index) => promptReference(url, names?.audios[index] ||
    assets.filter(asset => asset.voiceAudio?.url === url).map(asset => asset.name).join('、') || `参考音频 ${index + 1}`))
  const firstFrame = typeof params.firstFrameUrl === 'string' ? params.firstFrameUrl : undefined
  return { ...formatScriptVideoPrompt(task.prompt, { provider: task.provider ?? undefined, model: task.model ?? undefined },
    images, audios, firstFrame, stylePreset, lightingRanges), missingVoices: [], source: 'submitted' as const }
}

async function prepareSubmission(input: ScriptVideoGenerationInput) {
  const { card, assets, configId, model, aspectRatio, resolution } = input
  if (!input.projectId || !input.episodeId || !card?.id || !Array.isArray(assets)) throw new Error('项目、分集或分镜无效')
  const assetIssues = scriptVideoAssetBindingIssues(card, assets)
  if (assetIssues.length) throw new Error(assetIssues.map(issue => issue.message).join('\n'))
  if (!Number.isSafeInteger(configId) || configId <= 0 || typeof model !== 'string' || !model.trim()) throw new Error('请先选择已启用的视频服务与模型')
  if (card.manuallyAdded) {
    if (!hasScriptVideoPromptBody(card.prompt, input.stylePreset)) throw new Error('请先输入本段视频提示词')
    if (!Array.isArray(card.shots) || card.shots.some(shot => !shot || typeof shot !== 'object')) throw new Error('分镜数据无效')
    if (!Number.isFinite(card.duration) || card.duration <= 0 || card.duration > 30) throw new Error('片段时长须大于 0 秒且不超过 30 秒')
  } else {
    if (!card.prompt?.trim() || !Array.isArray(card.shots) || !card.shots.length) throw new Error('请先生成本段提示词和分镜脚本')
    if (!Number.isFinite(card.duration) || card.duration <= 0 || card.duration > 30 ||
        card.shots.some(shot => !Number.isFinite(shot?.duration) || shot.duration <= 0) ||
        Math.abs(card.shots.reduce((sum, shot) => sum + shot.duration, 0) - card.duration) > 1e-8) {
      throw new Error('分镜逐镜时长之和须与本段时长相同，且不超过 30 秒')
    }
  }
  const config = await resolveMediaConfig('video', { configId, model })
  const capabilities = scriptVideoCapabilities(config.provider, config.model, config.comfyui)
  if (!capabilities) throw new Error('该模型或工作流尚未配置可用的视频时长与提示词输入，请重新选择')
  const duration = resolveGenerationDuration(input, capabilities)
  const seedance = config.provider === 'volcengine' ? seedanceModelLimits(config.model) : null
  const usesAicost = config.provider.toLowerCase() === 'aicost'
  const usesJimeng = config.provider === 'jimeng'
  const jimeng = usesJimeng ? jimengVideoModel(config.model) : undefined
  const libtv = config.provider === 'libtv' ? libtvVideoModel(config.model) : undefined
  const aicost = usesAicost ? aicostVideoModelCapabilities(config.model) : null
  const is25 = seedance?.version === '2.5'
  const standardRatios = ['16:9', '9:16', '1:1', '4:3', '3:4']
  const ratios = usesAicost ? aicost?.ratios ?? AICOST_VIDEO_RATIOS : libtv ? LIBTV_VIDEO_RATIOS
    : is25 ? [...standardRatios, '21:9', 'adaptive'] : usesJimeng ? [...standardRatios, '21:9'] : standardRatios
  if (!ratios.includes(aspectRatio)) throw new Error('所选画幅无效')
  const size = resolution?.toLowerCase()
  const resolutions = usesAicost ? aicost?.resolutions ?? AICOST_VIDEO_RESOLUTIONS : jimeng?.resolutions ?? libtv?.resolutions ?? seedance?.resolutions ?? ['480p', '720p', '1080p']
  if (!resolutions.includes(size)) throw new Error(`所选模型支持 ${resolutions.join('、')}，请调整分辨率`)
  if (!Array.isArray(card.assetIds) || new Set(card.assetIds).size !== card.assetIds.length) throw new Error('分镜资产绑定无效')
  const options = { model: config.model, provider: config.provider, stylePreset: input.stylePreset, cast: input.cast,
    lightingRanges: input.lightingRanges, referenceLimits: capabilities, promptMode: input.promptMode ?? getVideoPromptMode(), duration, requireVoices: true }
  const { delivery, continuation } = await prepareCardDelivery(card, assets, options, input.continuationSource)
  const firstFrameUrl = continuation?.mode === 'first-frame' ? continuation.imageUrl : undefined
  const tailReference = continuation?.mode === 'reference' ? continuation.imageUrl : undefined
  const imageCount = delivery.images.length + Number(!!tailReference) + delivery.lightingImages.length
  const limitIssue = referenceLimitWarnings(capabilities, imageCount, delivery.voices.length, !!tailReference)[0]
  if (limitIssue) throw new Error(limitIssue)
  const urls = await Promise.all(delivery.images.map(asset => checkedReference(asset, config.provider, config.model, size)))
  const sourceUploadUrls = delivery.images.flatMap((asset, i) => asset.image !== urls[i] ? [asset.image] : [])
  if (tailReference) urls.push(tailReference)
  for (const image of delivery.lightingImages) {
    urls.push(await checkedReference({ image, name: '同场影调参考' }, config.provider, config.model, size))
  }
  const references = await Promise.all(delivery.voices.map(item => checkedVoiceAudio(item.asset)))
  if (capabilities.maxAudioDuration > 0) {
    const minAudioDuration = config.provider === 'aliyun' ? 1 : 2
    if (references.some(item => item.duration < minAudioDuration || item.duration > capabilities.maxAudioDuration)) throw new Error(`所选模型要求每段参考音频为 ${minAudioDuration}–${capabilities.maxAudioDuration} 秒`)
    if (references.reduce((sum, item) => sum + item.duration, 0) > capabilities.maxAudioDuration + 1e-6) throw new Error(`所选模型要求参考音频总时长不超过 ${capabilities.maxAudioDuration} 秒`)
  }
  if (references.length && !urls.length && (seedance?.version === '2.0' || config.provider === 'minimax' || usesAicost && isAicostMiniMaxH3Model(model))) throw new Error('参考音频需要至少一张参考图片或视频')
  const needsPublicMedia = config.provider !== 'comfyui' && !usesJimeng && !libtv
  const publicBase = needsPublicMedia && (urls.length || references.length) ? publicMediaBaseUrl() : null
  if (references.length && !publicBase && !usesAicost && !usesJimeng && !libtv && !is25) {
    throw new Error('参考音频为本地文件，需要配置外网可访问的 PUBLIC_BASE_URL 后重试')
  }
  const referenceAudioUrls = references.map(item => item.url)
  const prompt = delivery.prompt
  if (config.provider === 'minimax' && prompt.length > 7000) throw new Error('MiniMax H3 单次提示词最多 7000 字符，请缩短本段提示词')
  if (config.provider === 'aliyun' && aliyunWanVideoPrompt(prompt).length > 20000) throw new Error('Wan 3.0 单次提示词最多 20000 字符')
  const params = {
    configId, model: config.model, prompt, duration, aspectRatio, resolution: size,
    referenceMode: firstFrameUrl ? 'first_frame' : 'reference', firstFrameUrl, referenceImageUrls: urls, referenceAudioUrls,
    ...(sourceUploadUrls.length && { sourceUploadUrls }),
    ...(usesJimeng && { allowJimeng: input.allowJimeng }),
    ...(libtv && { allowLibTV: input.allowLibTV }),
    ...((usesJimeng || libtv) && { videoCliAccountId: input.videoCliAccountId }),
  } satisfies Parameters<typeof generateVideo>[0]
  return { params, config, continuation, lightingRanges: delivery.lightingRanges, references: deliveryReferences(delivery) }
}

/** Route owns the persistent, versioned reservation before invoking this paid operation.
 * generateVideo enqueues one sys_task without linking or modifying a legacy drama or storyboard.
 */
export async function startScriptVideoGeneration(input: ScriptVideoGenerationInput, control?: VideoSubmissionControl): Promise<{
  taskId: number; status: 'processing'; continuation?: ScriptVideoContinuation; lightingRanges?: ScriptVideoLightingRange[]
  referenceNames?: ScriptVideoReferenceNames
}> {
  let prepared: Awaited<ReturnType<typeof prepareSubmission>>
  try { prepared = await prepareSubmission(input) }
  catch (error) { throw new ScriptVideoGenerationValidationError(safeTaskError(error)) }
  let taskId: number
  try { taskId = await generateVideo(prepared.params, control) }
  catch (error) {
    // CLI 账号、画布与参数检查都在创建生成任务前完成，此时尚未向服务商提交。
    if (error instanceof JimengCliError || error instanceof LibTVCliError)
      throw new ScriptVideoGenerationValidationError(safeTaskError(error))
    throw error
  }
  return { taskId, status: 'processing' as const, continuation: prepared.continuation,
    referenceNames: { images: prepared.references.images.map(item => item.name), audios: prepared.references.audios.map(item => item.name) },
    ...(prepared.lightingRanges.length && { lightingRanges: prepared.lightingRanges }) }
}

export interface ScriptVideoGenerationStatus {
  taskId: number
  status: 'processing' | 'completed' | 'failed' | 'canceled'
  stage: string
  videoUrl?: string
  finalShotRange?: TailShotRange
  error?: string
  code?: 'SUBMISSION_UNKNOWN' | 'DELIVERY_FAILED' | 'VIDEO_FAILED'
  /** 仅查询已保存的 LibTV 原节点，不重新提交生成。 */
  canRecover?: boolean
}

function readSubmittedFinalShotRange(prompt: string | null, finalShotNumber?: number | 'last'): TailShotRange | undefined {
  if (!prompt || finalShotNumber === undefined || finalShotNumber !== 'last' && (!Number.isSafeInteger(finalShotNumber) || finalShotNumber < 1)) return
  const lastHeading = prompt.match(/^镜头[ \t]*\d+[^\r\n]*$/gmu)?.at(-1)
  const heading = lastHeading?.match(/^镜头[ \t]*(\d+)[ \t]*[（(][ \t]*(\d+(?:\.\d+)?)[ \t]*[–—-][ \t]*(\d+(?:\.\d+)?)[ \t]*秒[ \t]*[）)][ \t]*$/u)
  const shot = heading ? { number: Number(heading[1]), start: Number(heading[2]), end: Number(heading[3]) }
    : !lastHeading ? scriptVideoCultivationFinalShot(prompt) : undefined
  if (!shot || finalShotNumber !== 'last' && shot.number !== finalShotNumber) return
  const { start: shotStartSeconds, end: shotEndSeconds } = shot
  if (shotStartSeconds >= 0 && shotStartSeconds < shotEndSeconds && shotEndSeconds <= 30) {
    return { shotStartSeconds, shotEndSeconds }
  }
}

/** Reclassify a failed submission only when a single recorded attempt provides the reason. */
function reconcileAicostVideoRejection(task: typeof schema.sysTask.$inferSelect): string | undefined {
  if (task.provider?.toLowerCase() !== 'aicost' || task.errorCode !== 'submission_unknown' || task.taskId || task.resultUrl) return
  const [attempt, duplicate] = db.select({ status: schema.apiCallLogs.statusCode, response: schema.apiCallLogs.response,
    networkError: schema.apiCallLogs.error })
    .from(schema.apiCallLogs).where(and(eq(schema.apiCallLogs.taskId, task.id), eq(schema.apiCallLogs.provider, 'aicost'),
      eq(schema.apiCallLogs.category, 'video'), eq(schema.apiCallLogs.method, 'POST'))).limit(2).all()
  if (!attempt || duplicate) return
  let error: string | undefined, code = 'submission_rejected'
  try {
    if (attempt.status === null && attempt.response === null && attempt.networkError &&
        isPreTlsConnectionReset(JSON.parse(attempt.networkError))) {
      error = VIDEO_REQUEST_NOT_SENT_MESSAGE
      code = 'submission_not_sent'
    } else if (attempt.response) {
      error = aicostVideoSubmissionRejection(attempt.status, JSON.parse(attempt.response)?.body, task.model)
    }
  } catch { return }
  if (error) {
    db.update(schema.sysTask).set({ errorCode: code, errorMsg: safeTaskError(error), updatedAt: new Date().toISOString() })
      .where(and(eq(schema.sysTask.id, task.id), eq(schema.sysTask.status, 'failed'),
        eq(schema.sysTask.errorCode, 'submission_unknown'), isNull(schema.sysTask.taskId), isNull(schema.sysTask.resultUrl))).run()
    scheduleRetiredUploadCleanup()
  }
  return error
}

/** Route must resolve taskId from the server-owned project/episode/card reservation. */
export async function getScriptVideoGeneration(taskId: number, options: {
  reconcileRejection?: boolean; finalShotNumber?: number | 'last'; resumeOriginal?: boolean
} = {}): Promise<ScriptVideoGenerationStatus> {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) throw new Error('视频任务标识无效')
  let [task] = await db.select().from(schema.sysTask).where(and(
    eq(schema.sysTask.id, taskId), eq(schema.sysTask.type, 'video'), isNull(schema.sysTask.dramaId), isNull(schema.sysTask.storyboardId),
  )).limit(1)
  if (!task) throw new Error('视频任务不存在')
  if (options.resumeOriginal) task = await resumeRecoverableVideoTask(task)
  if (task.status === 'canceled') return { taskId, status: 'canceled', stage: 'canceled' }
  if (task.status === 'failed') {
    const rejected = options.reconcileRejection !== false && reconcileAicostVideoRejection(task)
    if (rejected) return { taskId, status: 'failed', stage: task.stage || 'failed', code: 'VIDEO_FAILED', error: safeTaskError(rejected) }
    const canRecover = canRecoverOriginalVideoTask(task)
    const code = task.errorCode === 'delivery_failed' ? 'DELIVERY_FAILED'
      : task.errorCode === 'submission_unknown' || canRecover ? 'SUBMISSION_UNKNOWN' : 'VIDEO_FAILED'
    return { taskId, status: 'failed', stage: task.stage || 'failed', code, error: safeTaskError(task.errorMsg || '视频生成失败'),
      ...(canRecover && { canRecover }) }
  }
  if (task.status === 'completed') {
    const file = task.localPath?.match(/^static\/videos\/([^/\\]+\.(?:mp4|webm))$/iu)
    const stat = file ? await fs.stat(path.join(STORAGE_ROOT, 'videos', file[1])).catch(() => null) : null
    if (!stat?.isFile() || !stat.size) return { taskId, status: 'failed', stage: 'delivery_failed', code: 'DELIVERY_FAILED', error: '视频任务缺少本地成片' }
    const finalShotRange = readSubmittedFinalShotRange(task.prompt, options.finalShotNumber)
    return { taskId, status: 'completed', stage: 'completed', videoUrl: '/' + task.localPath,
      ...(finalShotRange && { finalShotRange }) }
  }
  return { taskId, status: 'processing', stage: task.stage || 'submitting' }
}
