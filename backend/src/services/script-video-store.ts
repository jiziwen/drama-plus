import { randomUUID } from 'node:crypto'
import { ScriptVideoDatabase, type ScriptVideoRecord, type ProjectRow } from './script-video-database.js'
import { ScriptVideoAssetExtractionJobs } from './script-video-asset-extraction-jobs.js'
import { ScriptVideoQueue } from './script-video-queue.js'
import { ScriptVideoMediaRetention } from './script-video-media-retention.js'
import { applyScriptVideoChanges, validateScriptVideoChanges, type ScriptVideoChange } from './script-video-sync.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import 'dotenv/config'
import { SCRIPT_VIDEO_CUSTOM_STYLE_LIMIT, isScriptVideoCustomStyleId, isScriptVideoStylePreset, scriptVideoPromptStylePrefix, styleVisualSpecs, type ScriptVideoStylePreset } from './script-video-style.js'
import { getCurrentScriptVideoStyleRevision, resolveBuiltinStyleSnapshot } from './script-video-style-source.js'
import { annotateScriptVideoAssets, scriptVideoAudioReferences, scriptVideoMaterialIds, type MentionAsset } from './script-video-mentions.js'
import { annotateScriptVideoInnerOs } from './script-video-inner-os.js'
import { hasScriptVideoShotHeadings } from './script-video-asset-scope.js'
import { replaceScriptVideoPromptStyle } from './script-video-format.js'
import { getScriptVideoOutlineDurationIssues, scriptVideoAssetImageStatuses, scriptVideoVoiceDescriptionSchema, type ScriptVideoVoiceAudio, type ScriptVideoVoiceDescription } from './script-video-types.js'
import { confirmScriptVideoVoiceAge, scriptVideoVoiceProfileSchema, setScriptVideoProfileAudio } from './script-video-project-voices.js'
import { scriptVideoVoiceAgeStageSchema, type ScriptVideoVoiceAgeStage } from './script-video-voice-profile.js'
import { scriptVideoAssetBindingRequirementSchema, scriptVideoAssetOccurrenceSchema } from './script-video-asset-scenes.js'
import { completeScriptVideoSceneReferences } from './script-video-asset-bindings.js'
import { getScriptVideoVoiceInputs, scriptVideoVoiceSource, type ScriptVideoDeliveryAsset, type ScriptVideoDeliveryCard } from './script-video-delivery.js'
import type { ScriptVideoStoryboardCheckpoint, ScriptVideoStoryboardProgress } from './script-video-ai.js'
import type { LightingCheck } from './script-video-lighting.js'
import type { ScriptVideoReferenceNames } from './script-video-generation.js'
import type { ScriptVideoPromptMode } from './video-prompt-mode.js'
import { isScriptVideoGenerationDuration } from './script-video-capabilities.js'
import { listScriptVideoVersions } from './script-video-versions.js'
import { scriptVideoReferenceSettings, type ScriptVideoReferenceSettings } from './script-video-reference-settings.js'
import type { ScriptVideoStoryboardMode } from './script-video-storyboard-mode.js'
import { previousScriptVideoRender } from './script-video-predecessor.js'
import { isScriptVideoEpisodeProgress } from './script-video-episode-progress.js'

export const OUTLINE_DURATION_POLICY = '30-except-tail-v1' as const

export type ScriptVideoJob = {
  id: string
  projectId: string
  episodeId: string
  action: 'outline' | 'storyboard' | 'revisions' | 'review' | 'video'
  storyboardMode?: ScriptVideoStoryboardMode
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: string
  code?: string
  /** 服务端确认可继续查询原视频任务；不发起新的生成提交。 */
  canRecover?: boolean
  issues?: { code: string; message: string }[]
  cardId?: string
  cardVersion?: number
  ownerSession?: string
  requestId?: string
  taskId?: number
  baseDigest?: string
  videoDigestVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  videoIgnoresPredecessor?: true
  videoModel?: string
  videoProvider?: string
  videoPromptMode?: ScriptVideoPromptMode
  videoDuration?: number
  staleResult?: boolean
  lightingChecks?: LightingCheck[]
  videoReferenceNames?: ScriptVideoReferenceNames
  progress?: ScriptVideoStoryboardProgress
  /** Server-owned resume data; stripped from public job responses. */
  checkpoint?: ScriptVideoStoryboardCheckpoint
  resumeKey?: string
}
export function publicScriptVideoJob(job: ScriptVideoJob): ScriptVideoJob {
  const { ownerSession: _ownerSession, requestId: _requestId, checkpoint: _checkpoint, resumeKey: _resumeKey, lightingChecks: _lightingChecks, videoReferenceNames: _videoReferenceNames, ...visible } = job
  return visible
}
export type ScriptVideoProject = {
  id: string
  title: string
  revision: number
  assets: any[]
  episodes: any[]
  episodeId: string
  [key: string]: any
}
type RecordFile = ScriptVideoRecord
type Mutation<T> = { result: T; documentChanged?: boolean; recordChanged?: boolean }
type MutateRecord<T> = (record: RecordFile) => Mutation<T> | Promise<Mutation<T>>
type EpisodeLease = { session: string; expiresAt: number }
const EPISODE_LEASE_MS = 30_000

export function scriptVideoSession(value: string | undefined): string | null {
  if (!value) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new ScriptVideoStoreError('制作会话无效，请重新打开页面', 400, 'INVALID_SESSION')
  return value.toLowerCase()
}

export class ScriptVideoStoreError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'INVALID',
  ) {
    super(message)
  }
}
export function assertOutlineDurationPolicy(cards: Array<{ duration: number }>) {
  const issues = getScriptVideoOutlineDurationIssues(cards)
  if (issues.length) throw new ScriptVideoStoreError(issues.map(issue => issue.message).join('；') + '。请重新编排大纲，保持剧情自然衔接。', 422, 'OUTLINE_DURATION')
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)

function assertChangedReferenceSources(
  next: ScriptVideoProject, before: ScriptVideoProject, order: readonly string[],
  loadEpisode?: (id: string) => ScriptVideoProject['episodes'][number],
) {
  const currentEpisodes = new Map(next.episodes.map(episode => [episode.id, episode]))
  const priorEpisodes = new Map(before.episodes.map(episode => [episode.id, episode]))
  const frameChoices = (settings?: ScriptVideoReferenceSettings) => ({ ...settings?.lighting, tail: settings?.tail })
  for (const episode of next.episodes) {
    const priorCards = new Map<string, { referenceFrameSettings?: ScriptVideoReferenceSettings }>(
      priorEpisodes.get(episode.id)?.cards.map((card: { id: string }) => [card.id, card]),
    )
    for (const card of episode.cards) {
      if (!card.referenceFrameSettings) continue
      const old = frameChoices(priorCards.get(card.id)?.referenceFrameSettings)
      for (const [key, choice] of Object.entries(frameChoices(card.referenceFrameSettings))) {
        if (choice?.mode !== 'manual' || !choice.sourceCardId || isDeepStrictEqual(choice, old[key as keyof typeof old])) continue
        const candidates = choice.sourceEpisodeId ? order.filter(id => id === choice.sourceEpisodeId) : order
        const valid = candidates.some(id => {
          if (!currentEpisodes.has(id)) currentEpisodes.set(id, loadEpisode?.(id))
          const source = currentEpisodes.get(id)
          if (!source) return false
          const context = { episodes: source.id === episode.id ? [episode] : [source, episode] }
          return !!previousScriptVideoRender(context, episode.id, card.id, choice.videoUrl, choice.sourceCardId, choice.sourceEpisodeId)
        })
        if (!valid)
          throw new ScriptVideoStoreError('参考来源成片已更新，请重新打开选帧。', 409, 'REFERENCE_FRAME_SOURCE_CHANGED')
      }
    }
  }
}

function assertId(id: unknown): asserts id is string {
  if (!validId(id)) throw new ScriptVideoStoreError('无效的标识')
}
const styleKeys = ['id', 'name', 'prefix'] as const
function validStyle(value: unknown): value is ScriptVideoStylePreset {
  if (!isScriptVideoStylePreset(value)) return false
  if (Object.keys(value).length !== styleKeys.length || Object.keys(value).some(key => !styleKeys.includes(key as typeof styleKeys[number]))) return false
  return value.id.length <= 64 && value.name.length <= 100 && value.prefix.length > 0 && value.prefix.length <= 20000
}

function validateProjectStyles(settings: Record<string, unknown>) {
  const { stylePreset, customStylePresets } = settings
  if (stylePreset !== undefined && !validStyle(stylePreset))
    throw new ScriptVideoStoreError('风格预设无效，请检查名称、字段或长度')
  if (customStylePresets !== undefined) {
    if (!customStylePresets || typeof customStylePresets !== 'object' || Array.isArray(customStylePresets))
      throw new ScriptVideoStoreError('自定义风格列表无效')
    const entries = Object.entries(customStylePresets)
    if (entries.length > SCRIPT_VIDEO_CUSTOM_STYLE_LIMIT)
      throw new ScriptVideoStoreError(`每个项目最多保存 ${SCRIPT_VIDEO_CUSTOM_STYLE_LIMIT} 个自定义风格`)
    if (entries.some(([id, preset]) => !isScriptVideoCustomStyleId(id) || !validStyle(preset) || preset.id !== id))
      throw new ScriptVideoStoreError('自定义风格无效，请检查名称和风格前缀')
  }
  if (stylePreset && isScriptVideoCustomStyleId(stylePreset.id) &&
      !isDeepStrictEqual(stylePreset, (customStylePresets as Record<string, unknown> | undefined)?.[stylePreset.id]))
    throw new ScriptVideoStoreError('所选自定义风格已更新或删除，请重新选择后保存', 409, 'STYLE_PRESET_CHANGED')
}

function initialProjectStyle(stylePreset?: ScriptVideoStylePreset) {
  if (stylePreset === undefined) return {}
  return {
    stylePreset,
    ...(isScriptVideoCustomStyleId(stylePreset?.id) && { customStylePresets: { [stylePreset.id]: stylePreset } }),
  }
}
function validateAsset(asset: any) {
  if (
    !asset ||
    typeof asset !== 'object' ||
    !validId(asset.id) ||
    typeof asset.name !== 'string' ||
    !asset.name.trim() ||
    !['character', 'scene', 'prop', 'creature', 'audio'].includes(asset.kind)
  )
    throw new ScriptVideoStoreError('资产信息无效')
  if (asset.imagePrompt !== undefined && (typeof asset.imagePrompt !== 'string' || asset.imagePrompt.length > 16000))
    throw new ScriptVideoStoreError('资产生图提示词无效或过长')
  if (asset.imageStatus !== undefined && !scriptVideoAssetImageStatuses.includes(asset.imageStatus))
    throw new ScriptVideoStoreError('资产生图状态无效')
  if ((asset.assetIdentity !== undefined && (typeof asset.assetIdentity !== 'string' || !asset.assetIdentity.trim())) ||
      [asset.aliases, asset.sourceTitles].some(values => values !== undefined &&
        (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.trim()))) ||
      (asset.sourceEpisodes !== undefined && (!Array.isArray(asset.sourceEpisodes) ||
        asset.sourceEpisodes.some((value: number) => !Number.isSafeInteger(value) || value < 1))))
    throw new ScriptVideoStoreError('资产提取记录无效')
  if (asset.occurrences !== undefined && (!Array.isArray(asset.occurrences) ||
      asset.occurrences.some((item: unknown) => !scriptVideoAssetOccurrenceSchema.safeParse(item).success)))
    throw new ScriptVideoStoreError('资产场次来源无效')
  if (asset.voiceMode !== undefined && (asset.kind !== 'character' || !['model', 'reference'].includes(asset.voiceMode))) {
    throw new ScriptVideoStoreError('角色配音设置无效')
  }
  if (asset.voiceDescription !== undefined && (asset.kind !== 'character' || !scriptVideoVoiceDescriptionSchema.safeParse(asset.voiceDescription).success))
    throw new ScriptVideoStoreError('角色声音描述无效')
  if (asset.voiceProfile !== undefined && (asset.kind !== 'character' || !scriptVideoVoiceProfileSchema.safeParse(asset.voiceProfile).success))
    throw new ScriptVideoStoreError('角色音色信息无效')
  if (asset.confirmedVoiceAge !== undefined && (asset.kind !== 'character' || asset.confirmedVoiceAge === 'unknown' ||
      !scriptVideoVoiceAgeStageSchema.safeParse(asset.confirmedVoiceAge).success))
    throw new ScriptVideoStoreError('角色音色年龄无效')
  if (asset.voiceAudio !== undefined || asset.kind === 'audio') {
    const voice = asset.voiceAudio
    if (!['character', 'audio'].includes(asset.kind) || !voice || typeof voice !== 'object' || Array.isArray(voice) || Object.keys(voice).some(key => !['url', 'name', 'mimeType', 'duration'].includes(key)) || typeof voice.url !== 'string' || !/^\/static\/uploads\/[a-z0-9_-]+\.(?:mp3|wav|m4a|aac)$/iu.test(voice.url) || typeof voice.name !== 'string' || !voice.name.trim() || voice.name.length > 255 || (voice.mimeType !== undefined && (typeof voice.mimeType !== 'string' || voice.mimeType.length > 100 || !/^audio\/[a-z0-9.+-]+$/iu.test(voice.mimeType))) || (voice.duration !== undefined && (typeof voice.duration !== 'number' || !Number.isFinite(voice.duration) || voice.duration <= 0 || voice.duration > 86400))) {
      throw new ScriptVideoStoreError('参考音频信息无效，请重新上传音频')
    }
  }
  if (asset.image === '' && (asset.kind === 'audio' || typeof asset.imagePrompt === 'string')) return
  if (
    typeof asset.image !== 'string' ||
    !asset.image.startsWith('/static/') ||
    /[?#\\]/.test(asset.image)
  )
    throw new ScriptVideoStoreError('资产图片必须先上传并使用本地静态文件地址')
  try {
    const decoded = decodeURIComponent(asset.image)
    if (
      decoded.includes('\\') ||
      decoded
        .split('/')
        .some((segment: string) => segment === '..' || segment === '.')
    )
      throw new Error()
  } catch {
    throw new ScriptVideoStoreError('资产图片地址无效')
  }
}

const imageJobFields = ['imageStatus', 'imageError', 'imageTaskId', 'imageRequestId'] as const

function preserveServerAssetFields(input: any, previous: ScriptVideoProject) {
  if (!Array.isArray(input?.assets)) return input
  const priorAssets = new Map(previous.assets.map(asset => [asset.id, asset]))
  const assets = input.assets.map((asset: any) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return asset
    const prior = priorAssets.get(asset.id)
    const next = { ...asset }
    delete next.occurrences
    if (prior?.kind === asset.kind && prior.occurrences) next.occurrences = prior.occurrences
    for (const field of ['voiceDescription', 'voiceProfile', 'confirmedVoiceAge']) {
      delete next[field]
      if (asset.kind === 'character' && prior?.[field] !== undefined) next[field] = prior[field]
    }
    if (asset.kind === 'character' && prior?.voiceProfile) {
      if (prior.voiceAudio) next.voiceAudio = prior.voiceAudio
      else delete next.voiceAudio
    }
    for (const field of imageJobFields) {
      delete next[field]
      if (prior && prior.image === asset.image && prior[field] !== undefined) next[field] = prior[field]
    }
    if (prior && prior.image !== asset.image && typeof next.imagePrompt === 'string')
      next.imageStatus = next.image ? 'completed' : 'pending'
    return next
  })
  return { ...input, assets }
}
function withoutCardMetadata(card: any) {
  const { status, version, videoUrl, videoVersions, promptNeedsSync, referenceFrameSettings, ...rest } = card
  return rest
}

function sameJson(a: unknown, b: unknown) {
  // Compare what can be persisted, without treating object key order or undefined fields as edits.
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
}

function withoutShotReferences(shots: unknown) {
  if (!Array.isArray(shots)) return shots
  return shots.map(shot => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) return shot
    const { visualAssetIds, speakerAssetIds, ...content } = shot
    return content
  })
}

export function scriptVideoVisualAssetInput(asset: ScriptVideoDeliveryAsset | undefined) {
  if (asset) return [asset.id, asset.name, asset.kind, asset.image, asset.originalName, asset.sourcePath]
}

export function scriptVideoReferencedAssetIds(card: Partial<ScriptVideoDeliveryCard> | undefined) {
  if (!card) return []
  const ids = (value?: readonly string[]) => Array.isArray(value) ? value : []
  return [
    ...ids(card.assetIds),
    ...ids(card.openingAssetIds),
    ...(Array.isArray(card.shots) ? card.shots.flatMap(shot =>
      [...ids(shot?.visualAssetIds), ...ids(shot?.speakerAssetIds)]) : []),
  ]
}

function changedVisualAssetIds(before: ScriptVideoDeliveryAsset[], after: ScriptVideoDeliveryAsset[]) {
  const oldAssets = new Map(before.map(asset => [asset.id, scriptVideoVisualAssetInput(asset)]))
  const newAssets = new Map(after.map(asset => [asset.id, scriptVideoVisualAssetInput(asset)]))
  return new Set([...new Set([...oldAssets.keys(), ...newAssets.keys()])]
    .filter(id => !isDeepStrictEqual(oldAssets.get(id), newAssets.get(id))))
}

function changedVoiceAssetIds(before: ScriptVideoDeliveryAsset[], after: ScriptVideoDeliveryAsset[]) {
  const previousAudio = new Map(before.map(asset => [asset.id, scriptVideoVoiceSource(asset)]))
  return after.filter(asset => previousAudio.has(asset.id) && previousAudio.get(asset.id) !== scriptVideoVoiceSource(asset)).map(asset => asset.id)
}

function scanCardReferences(card: ScriptVideoDeliveryCard, prompt: string, assets: MentionAsset[], cast?: { name: string }[], protectedPrefix?: string) {
  return annotateScriptVideoAssets(prompt, assets, card.assetIds, {
    card, characters: card.characters, cast, excludedIds: card.excludedAssetIds, protectedPrefix, autoBind: true,
  })
}

function missingExplicitCardAssets(card: ScriptVideoDeliveryCard, prompt: string, scan: ReturnType<typeof scanCardReferences>) {
  const bound = new Set(card.assetIds)
  const excluded = new Set(card.excludedAssetIds)
  const explicit = new Set(scan.mentions.filter(hit => hit.explicit && (hit.usage !== 'context' || !hit.literal) &&
    !bound.has(hit.id) && !excluded.has(hit.id)).map(hit => hit.id))
  if (!explicit.size) return []
  const { imageIds, speakerIds } = scriptVideoMaterialIds({
    ...card, shots: Array.isArray(card.shots) ? card.shots : [],
  }, prompt, scan)
  const audioIds = scan.mentions.filter(hit => hit.usage === 'audio').map(hit => hit.id)
  const characterReferenceIds = scan.mentions.filter(hit => hit.usage === 'context' && !hit.literal).map(hit => hit.id)
  return [...new Set([...imageIds, ...speakerIds, ...audioIds, ...characterReferenceIds])].filter(id => explicit.has(id))
}

// Old drafts can already contain a valid @ token that was saved without its
// binding. Expose the same effective bindings to reads and edits.
function restoreSavedPromptReferences(project: ScriptVideoProject, episodes = project.episodes) {
  const characters = new Map(project.assets.filter(asset => asset.kind === 'character').map(asset => [asset.id, asset]))
  for (const episode of episodes) {
    const style = episode.production?.stylePreset || project.settings?.stylePreset
    const prefix = validStyle(style) ? scriptVideoPromptStylePrefix(style) : undefined
    const speakers = [...characters.values()].map(asset => asset.name).concat(episode.production?.characters?.map((role: { name: string }) => role.name) ?? [])
    for (const card of episode.cards || []) {
      const { prompt: savedPrompt, assetIds } = card
      if (typeof savedPrompt !== 'string' || !savedPrompt.trim()) continue
      const referenceAudioNames = [...scriptVideoAudioReferences(project.assets, savedPrompt).keys()]
      const prompt = annotateScriptVideoInnerOs(savedPrompt, { protectedPrefix: prefix, speakers, referenceAudioNames, preserveExplicitInnerOs: true })
      card.prompt = prompt
      if (!project.assets.length || !Array.isArray(assetIds)) continue
      const scan = scanCardReferences(card, prompt, project.assets, episode.production?.characters, prefix)
      const missing = missingExplicitCardAssets(card, prompt, scan)
      const excluded = new Set(card.excludedAssetIds)
      const references = scan.mentions.filter(hit => !hit.literal && characters.has(hit.id) && !excluded.has(hit.id))
      // Normalize live character references on reads without changing stored
      // revisions, quoted dialogue, historical prompts or other asset prose.
      let cursor = 0, output = ''
      for (const hit of references) {
        output += prompt.slice(cursor, hit.start) + '@' + hit.name
        cursor = hit.end
      }
      if (references.length) card.prompt = output + prompt.slice(cursor)
      if (missing.length || references.length) card.assetIds = [...new Set([...assetIds, ...missing, ...references.map(hit => hit.id)])]
      if (!card.manuallyAdded && !card.promptNeedsSync && !card.videoUrl && card.status !== 'ready' && Array.isArray(card.shots)) {
        const completed = completeScriptVideoSceneReferences(card, { script: episode.confirmedScript, assets: project.assets })
        if (completed !== card) Object.assign(card, completed)
      }
    }
  }
}

// A stored, edited prompt is authoritative. Add identity markers in place so
// opening a legacy project never regenerates its shots or overwrites revisions.
function cardReferences(card: any, assets: MentionAsset[], production: any, style?: ScriptVideoStylePreset) {
  if (!Array.isArray(card.assetIds) || typeof card.prompt !== 'string' || !card.prompt.trim()) return card
  const protectedPrefix = style && scriptVideoPromptStylePrefix(style)
  const prompt = annotateScriptVideoInnerOs(card.prompt, {
    protectedPrefix,
    preserveExplicitInnerOs: true,
    referenceAudioNames: [...scriptVideoAudioReferences(assets, card.prompt).keys()],
    speakers: [...assets.filter(asset => asset.kind === 'character').map(asset => asset.name),
      ...(production?.characters?.map((role: { name: string }) => role.name) ?? [])],
  })
  if (!assets.length) return { ...card, prompt }
  const result = scanCardReferences(card, prompt, assets, production?.characters, protectedPrefix)
  const explicit = new Set(missingExplicitCardAssets(card, prompt, result))
  const references = result.mentions.filter(mention => (mention.usage !== 'context' || !mention.literal) &&
    (!mention.explicit || explicit.has(mention.id))).map(mention => mention.id)
  const used = new Set(result.assetIds)
  const contextual = new Set(result.contextAssetIds)
  const assigned = hasScriptVideoShotHeadings(prompt)
    ? card.assetIds
    : card.assetIds.filter((id: string) => !contextual.has(id) || used.has(id))
  return { ...card, prompt: result.text, assetIds: [...new Set([...assigned, ...references])] }
}

/** Built-in presets follow the source; authored custom snapshots and archived
 * generation inputs remain untouched. Only current prompt prefixes are replaced. */
function syncBuiltinStyleSnapshots(project: ScriptVideoProject, updateVersions = false): ScriptVideoProject {
  const previousStyle = project.settings?.stylePreset
  const latestStyle = resolveBuiltinStyleSnapshot(previousStyle)
  const settingsChanged = latestStyle && !isDeepStrictEqual(previousStyle, latestStyle)
  const settings = settingsChanged ? { ...project.settings, stylePreset: latestStyle } : project.settings
  let changed = !!settingsChanged
  const episodes = project.episodes.map(episode => {
    if (!episode || !Array.isArray(episode.cards)) return episode
    const oldStyle = episode.production?.stylePreset || previousStyle
    const style = resolveBuiltinStyleSnapshot(oldStyle)
    if (!style || isDeepStrictEqual(style, oldStyle)) return episode
    const cards = episode.cards.map((card: any) => {
      if (!card || typeof card.prompt !== 'string' || !card.prompt.trim()) return card
      const prompt = replaceScriptVideoPromptStyle(card.prompt, style, oldStyle, episode.production)
      if (prompt === card.prompt) return card
      return { ...card, prompt,
        promptVersions: [...(card.promptVersions || []), {
          id: 'prompt-' + randomUUID(), prompt: card.prompt, assetIds: [...(card.assetIds || [])],
          ...(card.excludedAssetIds?.length && { excludedAssetIds: [...card.excludedAssetIds] }),
          createdAt: new Date().toISOString(), instruction: '同步内置风格预设', summary: '更新风格前的提示词',
        }],
        ...(updateVersions && { version: (Number(card.version) || 0) + 1, status: 'draft' }),
      }
    })
    if (!episode.production && cards.every((card: any, index: number) => card === episode.cards[index])) return episode
    changed = true
    return { ...episode, cards,
      ...(episode.production && { production: { ...episode.production, stylePreset: style,
        visualSpecs: styleVisualSpecs(style, { aspectRatio: episode.aspectRatio, resolution: episode.resolution, videoModel: episode.modelName }),
      } }),
    }
  })
  return changed ? { ...project, settings, episodes } : project
}

function sanitizeProject(
  input: any,
  previous?: ScriptVideoProject,
  partialWrite = false,
): ScriptVideoProject {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ScriptVideoStoreError('项目数据无效')
  assertId(input.id)
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    !Array.isArray(input.assets) ||
    !Array.isArray(input.episodes)
  )
    throw new ScriptVideoStoreError('项目字段无效')
  if (input.settings !== undefined && (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings))) throw new ScriptVideoStoreError('项目设置无效')
  let settings = partialWrite ? input.settings || {} : { ...(previous?.settings || {}), ...(input.settings || {}) }
  validateProjectStyles(settings)
  input = syncBuiltinStyleSnapshots({ ...input, settings })
  settings = input.settings
  const assetIds = new Set<string>()
  for (const asset of input.assets) {
    validateAsset(asset)
    if (assetIds.has(asset.id)) throw new ScriptVideoStoreError('资产标识重复')
    assetIds.add(asset.id)
  }
  const episodes = new Set<string>()
  const oldAssetIds = new Set(previous?.assets.map(asset => asset.id))
  const assets = input.assets as ScriptVideoDeliveryAsset[]
  const changedAssets = changedVisualAssetIds(previous?.assets || [], assets)
  const changedVoices = previous ? changedVoiceAssetIds(previous.assets, assets) : []
  const sanitizedEpisodes = input.episodes.map((episode: any) => {
    if (
      !episode ||
      typeof episode !== 'object' ||
      !validId(episode.id) ||
      episodes.has(episode.id) ||
      !Array.isArray(episode.cards) ||
      typeof episode.script !== 'string' ||
      typeof episode.confirmedScript !== 'string'
    )
      throw new ScriptVideoStoreError('分集数据无效')
    episodes.add(episode.id)
    if (episode.production?.stylePreset !== undefined && !validStyle(episode.production.stylePreset)) throw new ScriptVideoStoreError('制作规格中的风格预设无效')
    const old = previous?.episodes.find((item) => item.id === episode.id)
    const progressOverride = episode.progressOverride === undefined && !partialWrite
      ? old?.progressOverride : episode.progressOverride
    if (progressOverride != null && !isScriptVideoEpisodeProgress(progressOverride))
      throw new ScriptVideoStoreError('分集状态无效')
    const incomingNotes = episode.characterAppearanceNotes
    if (incomingNotes !== undefined && (typeof incomingNotes !== 'string' || incomingNotes.length > 1500))
      throw new ScriptVideoStoreError('本集角色造型备注须为 1500 字以内的文本')
    const characterAppearanceNotes = incomingNotes === undefined
      ? (partialWrite ? undefined : old?.characterAppearanceNotes)
      : incomingNotes.trim()
    const outlineDurationPolicy = old?.outlineDurationPolicy
    if (outlineDurationPolicy === OUTLINE_DURATION_POLICY && !old?.outlineConfirmed && episode.outlineConfirmed)
      assertOutlineDurationPolicy(episode.cards)
    const production = episode.production ?? old?.production
    const style = production?.stylePreset || settings.stylePreset
    const previousStyle = old?.production?.stylePreset || previous?.settings?.stylePreset
    const ids = new Set<string>()
    const cards = episode.cards.map((card: any) => {
      if (
        !card ||
        typeof card !== 'object' ||
        !validId(card.id) ||
        ids.has(card.id)
      )
        throw new ScriptVideoStoreError('分镜标识无效或重复')
      ids.add(card.id)
      if (card.excludedAssetIds !== undefined &&
          (!Array.isArray(card.excludedAssetIds) || !card.excludedAssetIds.every(validId))) {
        throw new ScriptVideoStoreError('分镜的已移除参考素材标识无效')
      }
      if ((card.sourceSceneIds !== undefined && (!Array.isArray(card.sourceSceneIds) ||
          card.sourceSceneIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 80))) ||
          (card.assetBindingRequirements !== undefined && (!Array.isArray(card.assetBindingRequirements) ||
           card.assetBindingRequirements.some((item: unknown) => !scriptVideoAssetBindingRequirementSchema.safeParse(item).success))))
        throw new ScriptVideoStoreError('分镜场次素材绑定无效')
      if (card.stylePreset !== undefined && !validStyle(card.stylePreset)) throw new ScriptVideoStoreError('分镜的风格预设无效')
      const prior = old?.cards?.find((item: any) => item.id === card.id)
      if (prior?.assetBindingRequirements?.length && card.assetBindingRequirements === undefined)
        card = { ...card, assetBindingRequirements: prior.assetBindingRequirements, sourceSceneIds: card.sourceSceneIds ?? prior.sourceSceneIds }
      if (previous) {
        const oldReferences = new Set(scriptVideoReferencedAssetIds(prior))
        if (scriptVideoReferencedAssetIds(card).some(id => !assetIds.has(id) && (!oldReferences.has(id) || oldAssetIds.has(id))))
          throw new ScriptVideoStoreError('引用的素材已移除，请更新本地草稿后再保存', 409, 'ASSET_REMOVED')
      }
      const normalizedPrompt = style && typeof card.prompt === 'string' && card.prompt.trim()
        ? replaceScriptVideoPromptStyle(card.prompt, style, previousStyle, production)
        : card.prompt
      const normalizedPriorPrompt = style && typeof prior?.prompt === 'string' && prior.prompt.trim()
        ? replaceScriptVideoPromptStyle(prior.prompt, style, previousStyle, production)
        : prior?.prompt
      // Only a new card added to an existing video-production episode can use
      // a free-form prompt. A snapshot edit cannot change a saved card's origin.
      const { manuallyAdded, videoVersions: _incomingVersions, referenceFrameSettings, ...cardContent } = card
      const incomingReferences = referenceFrameSettings === undefined && !partialWrite
        ? prior?.referenceFrameSettings : referenceFrameSettings
      try {
        const references = scriptVideoReferenceSettings(incomingReferences)
        if (references) cardContent.referenceFrameSettings = references
      } catch {
        throw new ScriptVideoStoreError('分镜参考帧设置无效')
      }
      const manual = prior?.manuallyAdded === true || !prior && manuallyAdded === true &&
        old?.outlineConfirmed === true && (old.stage === 'production' || episode.stage === 'production' || !!old.production)
      const annotated = cardReferences({ ...cardContent, ...(manual && { manuallyAdded: true }), prompt: normalizedPrompt }, input.assets, production, style)
      const shotsChanged = prior && !sameJson(
        { shots: withoutShotReferences(prior.shots) },
        { shots: withoutShotReferences(card.shots) },
      )
      const promptChanged = prior && normalizedPriorPrompt !== annotated.prompt
      const promptNeedsSync = !manual && (!!card.promptNeedsSync || (!!prior && !promptChanged && (!!shotsChanged || !!prior.promptNeedsSync)))
      const visualAssetChanged = changedAssets.size > 0 && [prior, annotated].some(card =>
        scriptVideoReferencedAssetIds(card).some(id => changedAssets.has(id)))
      let voiceChanged = false
      // A completed render keeps its inputs. Check the next submission's voice
      // sources only for unfinished cards after a voice setting changes.
      if (prior && previous && !(prior.status === 'ready' && prior.videoUrl) && changedVoices.length > 0) {
        const delivery = { model: episode.modelName, provider: episode.modelProvider, cast: production?.characters, stylePreset: style }
        const before = getScriptVideoVoiceInputs(annotated, previous.assets, delivery)
        const after = getScriptVideoVoiceInputs(annotated, assets, delivery)
        voiceChanged = changedVoices.some(id => before.get(id) !== after.get(id))
      }
      const changed =
        !prior || promptNeedsSync !== !!prior.promptNeedsSync ||
        visualAssetChanged || voiceChanged ||
        !sameJson(withoutCardMetadata(prior), withoutCardMetadata(annotated))
      const videoVersions = prior?.videoVersions ??
        (changed && prior?.status === 'ready' && prior.videoUrl ? listScriptVideoVersions(prior) : undefined)
      return {
        ...annotated,
        promptNeedsSync,
        videoUrl: prior?.videoUrl,
        ...(videoVersions && { videoVersions }),
        version: prior ? (Number(prior.version) || 0) + (changed ? 1 : 0) : 1,
        status: !prior || changed ? 'draft' : prior.status,
      }
    })
    // The client cannot replace task records. Removing a segment removes its
    // finished tasks from the episode view, while active work must finish first.
    const remainingTasks = (old?.tasks || []).filter((task: { cardId: string; status: string }) => {
      if (ids.has(task.cardId)) return true
      if (task.status === 'processing' && old?.cards.some((card: { id: string }) => card.id === task.cardId)) {
        throw new ScriptVideoStoreError('片段正在生成，请等待完成后再删除。', 409, 'VIDEO_RUNNING')
      }
      return false
    })
    const { production: _incomingProduction, outlineDurationPolicy: _incomingPolicy, characterAppearanceNotes: _incomingNotes,
      progressOverride: _incomingProgressOverride,
      videoDurations: incomingDurations, ...episodeFields } = episode
    if (incomingDurations !== undefined && (!incomingDurations || typeof incomingDurations !== 'object' || Array.isArray(incomingDurations)))
      throw new ScriptVideoStoreError('视频生成时长设置无效')
    const videoDurations = Object.entries(incomingDurations ?? (partialWrite ? {} : old?.videoDurations) ?? {}).filter(([cardId, duration]) => ids.has(cardId) && isScriptVideoGenerationDuration(duration))
    return { ...episodeFields, ...(production === undefined ? {} : { production }), ...(outlineDurationPolicy === undefined ? {} : { outlineDurationPolicy }), ...(characterAppearanceNotes ? { characterAppearanceNotes } : {}),
      ...(progressOverride !== undefined && { progressOverride }),
      ...(videoDurations.length ? { videoDurations: Object.fromEntries(videoDurations) } : {}),
      cards, tasks: remainingTasks, generationsHistory: old?.generationsHistory || [], busy: false }
  })
  if (input.episodeId && !episodes.has(input.episodeId))
    throw new ScriptVideoStoreError('当前分集不存在')
  return {
    ...input,
    id: input.id,
    title: input.title,
    settings,
    assets: input.assets,
    episodes: sanitizedEpisodes,
    episodeId: input.episodeId || '',
    revision: previous?.revision || 0,
  }
}
// Resolve mentions against the old asset index before replacing or deleting the name.
function propagateSharedEdits(before: ScriptVideoProject, after: ScriptVideoProject, reapplyStyle = false) {
  const nextAssets = new Map<string, MentionAsset>(after.assets.map(asset => [asset.id, asset]))
  const renamed = new Map<string, string>()
  const removed = new Set<string>()
  for (const asset of before.assets) {
    const next = nextAssets.get(asset.id)
    if (!next) removed.add(asset.id)
    else if (next.name !== asset.name) renamed.set(asset.id, next.name)
  }
  const voiceNames = (assets: MentionAsset[]) => new Map([...scriptVideoAudioReferences(assets)]
    .filter(([, asset]) => asset.kind === 'character').map(([name, asset]) => [asset.id, name]))
  const nextVoices = voiceNames(after.assets)
  const changedVoices = new Map([...voiceNames(before.assets)].flatMap(([id, name]) => {
    const next = nextVoices.get(id)
    return name === next ? [] : [[id, next ?? null] as const]
  }))
  const style = after.settings?.stylePreset
  const applyStyle = validStyle(style) && (reapplyStyle || !isDeepStrictEqual(style, before.settings?.stylePreset))
  const rewriteMentions = renamed.size || removed.size || changedVoices.size
  if (!rewriteMentions && !applyStyle) return
  for (const episode of after.episodes) {
    const oldStyle = episode.production?.stylePreset || before.settings?.stylePreset
    const styleChanged = applyStyle && !isDeepStrictEqual(style, oldStyle)
    for (const card of episode.cards) {
      const ids: string[] = card.assetIds || []
      const rewrite = (value: unknown, dialogue = false) => {
        if (typeof value !== 'string' || !value.includes('@') || !rewriteMentions) return value
        const { mentions } = annotateScriptVideoAssets(value, before.assets, ids, {
          dialogue, cast: episode.production?.characters, characters: card.characters,
          protectedPrefix: oldStyle && scriptVideoPromptStylePrefix(oldStyle), excludedIds: card.excludedAssetIds,
        })
        let result = '', last = 0
        for (const mention of mentions) {
          if (!mention.explicit || mention.spoken) continue
          const voice = mention.usage === 'audio' ? changedVoices.get(mention.id) : undefined
          const name = renamed.get(mention.id)
          if (voice === undefined && !name && !removed.has(mention.id)) continue
          const replacement = voice === null ? '' : voice !== undefined ? '@' + voice : name ? '@' + name : mention.name
          result += value.slice(last, mention.start) + replacement
          last = mention.end
        }
        return result + value.slice(last)
      }
      for (const key of ['prompt', 'openingRecap', 'opening', 'scene', 'characters', 'independentGeneration', 'ending']) {
        if (typeof card[key] === 'string') card[key] = rewrite(card[key])
      }
      for (const key of ['assetIds', 'openingAssetIds', 'excludedAssetIds']) {
        if (removed.size && Array.isArray(card[key])) card[key] = card[key].filter((id: string) => !removed.has(id))
      }
      for (const shot of card.shots || []) {
        for (const key of ['camera', 'action', 'dialogue']) if (typeof shot[key] === 'string') shot[key] = rewrite(shot[key], key === 'dialogue')
        for (const key of ['visualAssetIds', 'speakerAssetIds']) {
          if (removed.size && Array.isArray(shot[key])) shot[key] = shot[key].filter((id: string) => !removed.has(id))
        }
      }
      if (styleChanged && typeof card.prompt === 'string' && card.prompt.trim()) {
        const prompt = replaceScriptVideoPromptStyle(card.prompt, style, oldStyle, episode.production)
        if (prompt !== card.prompt) {
          card.promptVersions = [...(card.promptVersions || []), {             id: 'prompt-' + randomUUID(), prompt: card.prompt,
            assetIds: [...ids], ...(card.excludedAssetIds?.length && { excludedAssetIds: [...card.excludedAssetIds] }),
            createdAt: new Date().toISOString(), instruction: '更新项目统一风格', summary: '更新风格前的提示词'           }]
          card.prompt = prompt
        }
      }
    }
    if (styleChanged && episode.production) {
      episode.production.stylePreset = style
      episode.production.visualSpecs = styleVisualSpecs(style, { aspectRatio: episode.aspectRatio, resolution: episode.resolution, videoModel: episode.modelName })
    }
  }
}

function makeEpisode() {
  const id = `episode-${randomUUID()}`
  return {
    id,
    number: 1,
    title: '未命名分集',
    script: '',
    confirmedScript: '',
    confirmed: false,
    outlineConfirmed: false,
    stage: 'materials',
    cards: [],
    selectedCardId: '',
    tasks: [],
    outlineSummaries: {},
    busy: false,
    modelKey: '',
    modelLabel: '',
    modelMaxDuration: 15,
    aspectRatio: '16:9',
    resolution: '480P',
  }
}
export function defaultScriptVideoStoreDirectory() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  )
  const dbPath =
    process.env.SQLITE_PATH || path.join(repoRoot, 'data/huobao.sqlite3')
  return path.join(path.dirname(path.resolve(dbPath)), 'script-video/projects')
}
let defaultStore: ScriptVideoStore | undefined
export function getDefaultScriptVideoStore(): ScriptVideoStore {
  return defaultStore ??= new ScriptVideoStore()
}
export class ScriptVideoStore {
  private locks = new Map<string, Promise<void>>()
  private builtinStyleVersions = new Map<string, { source: string; storage: number }>()
  private episodeLeases = new Map<string, Map<string, EpisodeLease>>()
  private init: Promise<void>
  private generationQueue?: ScriptVideoQueue
  get queue() { return this.generationQueue ??= new ScriptVideoQueue(this.directory) }
  constructor(public directory = defaultScriptVideoStoreDirectory()) {
    this.init = this.initialize()
    void this.init.catch(() => { })
  }
  private catalog!: ScriptVideoDatabase
  private assetExtractionJobs!: ScriptVideoAssetExtractionJobs
  private media!: ScriptVideoMediaRetention
  private corruptLegacy = new Set<string>()
  private async initialize() {
    await fs.mkdir(this.directory, { recursive: true })
    this.catalog = new ScriptVideoDatabase(this.directory)
    const db = this.catalog.db
    this.assetExtractionJobs = new ScriptVideoAssetExtractionJobs(db)
    this.media = new ScriptVideoMediaRetention(db)
    for (const name of await fs.readdir(this.directory)) {
      const id = name.slice(0, -5)
      if (!name.endsWith('.json') || !validId(id) || db.prepare('SELECT 1 FROM imported_files WHERE id=?').get(id)) continue
      let record: RecordFile
      try {
        record = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'))
        if (record.project?.id !== id || typeof record.project.title !== 'string' || !Number.isSafeInteger(record.project.revision) ||
          !Array.isArray(record.project.assets) || !Array.isArray(record.jobs) || !Array.isArray(record.project.episodes) ||
          record.jobs.some(job => !validId(job?.episodeId) || typeof job?.action !== 'string' || typeof job?.status !== 'string') ||
          [record.jobs, record.project.episodes].some(items => items.some(item => !validId(item?.id)) ||
            new Set(items.map(item => item.id)).size !== items.length)) throw Error()
        db.transaction(() => {
          if (!this.catalog.project(id)) this.writeRecord(record)
          db.prepare('INSERT OR IGNORE INTO imported_files(id) VALUES(?)').run(id)
        }).immediate()
      } catch (error) {
        // Disk/SQLite errors must surface instead of misclassifying a healthy legacy file.
        if (error && typeof error === 'object' && 'code' in error) throw error
        this.corruptLegacy.add(id)
        continue
      }
    }
    // Submitted video tasks survive restarts. Unsubmitted work has no live worker.
    const interrupted = db.prepare<[], { project_id: string }>(`
      SELECT DISTINCT project_id FROM jobs WHERE status IN ('queued','running') AND (action<>'video' OR task_id IS NULL)
    `).all()
    for (const { project_id: id } of interrupted) {
      const record = this.readRecord(id)
      let changed = false
      for (const job of record.jobs) {
        if (job.status !== 'queued' && job.status !== 'running') continue
        // Submitted video tasks can still be polled after restart. An interrupted
        // submission without a task ID is ambiguous and must not auto-retry.
        if (job.action === 'video' && job.taskId) continue
        job.status = 'failed'
        job.error =
          job.action === 'video'
            ? '服务重启时未收到提交结果。重新提交可能重复计费。'
            : '服务重启，任务未完成，请重试'
        job.code =
          job.action === 'video' ? 'SUBMISSION_UNKNOWN' : 'INTERRUPTED'
        job.updatedAt = new Date().toISOString()
        if (job.action === 'video') {
          const task = record.project.episodes
            .find((ep) => ep.id === job.episodeId)
            ?.tasks?.find((t: any) => t.id === job.id)
          if (task) {
            task.status = 'failed'
            task.error = job.error
            task.code = job.code
            record.project.revision++
          }
        }
        changed = true
      }
      if (changed) this.writeRecord(record)
    }
    if (!this.corruptLegacy.size) this.media.startCleanup()
  }

  private projectRow(id: string): ProjectRow {
    assertId(id)
    const row = this.catalog.project(id)
    if (row) return row
    if (this.corruptLegacy.has(id)) throw new ScriptVideoStoreError('项目数据无法读取', 500, 'CORRUPT')
    throw new ScriptVideoStoreError('项目不存在', 404, 'NOT_FOUND')
  }

  private syncBuiltinStyles(row: ProjectRow): ProjectRow {
    const source = getCurrentScriptVideoStyleRevision()
    const cached = this.builtinStyleVersions.get(row.id)
    if (cached?.source === source && cached.storage === row.version) return row
    const before = this.catalog.shared(row)
    const hasBuiltin = resolveBuiltinStyleSnapshot(before.settings?.stylePreset) || this.catalog.db.prepare(`
      SELECT 1 FROM episodes WHERE project_id=? AND CASE WHEN json_valid(document) THEN
        (json_extract(document,'$.production.stylePreset.id')='cool' AND json_extract(document,'$.production.stylePreset.name')='冷色调') OR
        (json_extract(document,'$.production.stylePreset.id')='warm' AND json_extract(document,'$.production.stylePreset.name')='暖色调')
        ELSE 0 END LIMIT 1`).get(row.id)
    if (!hasBuiltin) {
      this.builtinStyleVersions.set(row.id, { source, storage: row.version })
      return row
    }
    before.episodes = this.catalog.allEpisodes(row)
    const project = syncBuiltinStyleSnapshots(before, true)
    if (project !== before) {
      project.revision = row.revision + 1
      this.catalog.putProject(project, JSON.parse(row.episode_order), row)
      for (const [index, episode] of project.episodes.entries()) {
        if (episode !== before.episodes[index]) this.catalog.putEpisode(project.id, episode)
      }
      row = this.projectRow(row.id)
    }
    this.builtinStyleVersions.set(row.id, { source, storage: row.version })
    return row
  }

  private readRecord(id: string, scope?: string, trackChanges = true, includePrevious = false): RecordFile {
    const row = this.syncBuiltinStyles(this.projectRow(id))
    const project = this.catalog.shared(row)
    let episodeRevision: number | undefined
    if (scope) {
      const episode = this.catalog.episode(id, scope)
      if (!episode) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      episodeRevision = episode.episodeRevision
      project.episodes = [episode.episode]
      if (includePrevious) {
        const order: string[] = JSON.parse(row.episode_order)
        const previousId = order[order.indexOf(scope) - 1]
        const requested = new Set([scope, ...(previousId ? [previousId] : [])])
        const legacyCardIds = new Set<string>()
        for (const card of episode.episode.cards) {
          const settings: ScriptVideoReferenceSettings | undefined = card.referenceFrameSettings
          for (const choice of [settings?.tail, ...Object.values(settings?.lighting ?? {})]) {
            if (choice?.mode !== 'manual' || !choice.sourceCardId) continue
            if (choice.sourceEpisodeId) requested.add(choice.sourceEpisodeId)
            else legacyCardIds.add(choice.sourceCardId)
          }
        }
        if (legacyCardIds.size) {
          const matches = this.catalog.db.prepare<[string, string], { id: string }>(`
            SELECT id FROM episodes WHERE project_id=? AND EXISTS (
              SELECT 1 FROM json_each(document,'$.cards') card
              JOIN json_each(?) source ON json_extract(card.value,'$.id')=source.value
            )`).all(id, JSON.stringify([...legacyCardIds]))
          for (const source of matches) requested.add(source.id)
        }
        // Keep the real previous episode directly before the current one, while
        // loading explicit sources as read-only context in their project order.
        project.episodes = order.filter(id => requested.has(id)).flatMap(episodeId => {
          const selected = episodeId === scope ? episode : this.catalog.episode(id, episodeId)
          return selected ? [selected.episode] : []
        })
      }
    } else project.episodes = this.catalog.allEpisodes(row)
    const originalEpisodes = trackChanges ? new Map(project.episodes.map(episode => [episode.id, JSON.stringify(episode)])) : undefined
    restoreSavedPromptReferences(project)
    const jobs = scope && includePrevious ? project.episodes.flatMap(episode => this.catalog.jobs(id, episode.id)) : this.catalog.jobs(id, scope)
    return { project, jobs, storageVersion: row.version, scope, episodeRevision, originalEpisodes }
  }

  private normalizeRecord(record: RecordFile, episodes: ScriptVideoProject['episodes']) {
    // Older snapshots stored the preset's display heading and trailing blank
    // lines in the current prompt. Present its normalized form consistently
    // to reads, jobs and future writes, without touching historical versions.
    const completedJobs = new Map(record.jobs.filter(job =>
      job.action === 'video' && job.status === 'completed' && !job.staleResult && job.taskId,
    ).map(job => [job.id, job]))
    for (const episode of episodes) {
      const style = episode.production?.stylePreset || record.project.settings?.stylePreset
      const completedByCard = new Map<string, { cardVersion: number; videoUrl: string }>()
      for (const task of episode.tasks || []) {
        const job = completedJobs.get(task.id)
        if (job && job.episodeId === episode.id && job.cardId === task.cardId &&
          job.taskId === task.taskId && job.cardVersion === task.cardVersion &&
          Number.isSafeInteger(task.cardVersion) && task.cardVersion > 0 &&
          task.status === 'completed' && !task.staleResult && task.videoUrl) {
          completedByCard.set(task.cardId, task)
        }
      }
      for (const card of episode.cards || []) {
        if (validStyle(style) && typeof card.prompt === 'string' && card.prompt.trim())
          card.prompt = replaceScriptVideoPromptStyle(card.prompt, style, style, episode.production)
        Object.assign(card, cardReferences(card, record.project.assets, episode.production, validStyle(style) ? style : undefined))
        // Older snapshots can retain the result only on the task. Recover a
        // matching render without promoting results from a changed card.
        const completed = completedByCard.get(card.id)
        if (completed && !(card.status === 'ready' && card.videoUrl) && !card.promptNeedsSync && completed.cardVersion === card.version) {
          const archive = listScriptVideoVersions(card)
          if (archive.length && !archive.some(item => item.url === completed.videoUrl)) {
            card.videoVersions = [...archive, { url: completed.videoUrl }]
          }
          card.status = 'ready'
          card.videoUrl = completed.videoUrl
        }
      }
    }
  }

  private writeRecord(record: RecordFile) {
    const { project } = record
    // An adjacent episode can be loaded as read-only reference context.
    const jobs = record.scope ? record.jobs.filter(job => job.episodeId === record.scope) : record.jobs
    const db = this.catalog.db
    const cleanupNeeded = db.transaction(() => {
      const prior = this.catalog.project(project.id)
      if (record.storageVersion !== undefined && record.storageVersion !== prior?.version)
        throw new ScriptVideoStoreError('项目刚刚更新，请重试', 409, 'CONFLICT')
      const writableEpisodes = record.scope ? project.episodes.filter(episode => episode.id === record.scope) : project.episodes
      const changedEpisodes = record.originalEpisodes ? writableEpisodes.filter(episode => record.originalEpisodes!.get(episode.id) !== JSON.stringify(episode)) : writableEpisodes
      this.normalizeRecord(record, changedEpisodes)
      const ids: string[] = record.scope && prior ? JSON.parse(prior.episode_order) : project.episodes.map(ep => ep.id)
      this.catalog.putProject(project, ids, prior)
      if (!record.scope && prior) {
        const keep = new Set(ids)
        for (const id of JSON.parse(prior.episode_order) as string[]) {
          if (!keep.has(id)) db.prepare('DELETE FROM episodes WHERE project_id=? AND id=?').run(project.id, id)
        }
      }
      for (const episode of changedEpisodes) this.catalog.putEpisode(project.id, episode)
      const assetsChanged = !prior || prior.assets !== JSON.stringify(project.assets)
      if (assetsChanged)
        this.media.replaceProjectAssets(project.id, prior ? JSON.parse(prior.assets) : [], project.assets)
      const heldSql = "SELECT id FROM jobs WHERE project_id=? AND action='video' AND status IN ('queued','running') AND task_id IS NULL"
      const held = db.prepare<unknown[], { id: string }>(heldSql + (record.scope ? ' AND episode_id=?' : ''))
        .all(...(record.scope ? [project.id, record.scope] : [project.id]))
      const next = new Set(jobs.filter(job => job.action === 'video' && !job.taskId && (job.status === 'queued' || job.status === 'running')).map(job => job.id))
      const released = held.filter(item => !next.delete(item.id))
      for (const item of released) this.media.releaseJob(item.id)
      for (const id of next) this.media.holdJob(id, project.assets)
      this.catalog.putJobs(project.id, jobs, record.scope)
      return assetsChanged || released.length > 0
    }).immediate()
    if (cleanupNeeded) this.media.scheduleCleanup()
  }
  private async exclusive<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertId(id)
    await this.init
    const prior = this.locks.get(id) || Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = prior.catch(() => {}).then(() => gate)
    this.locks.set(id, queued)
    await prior.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(id) === queued) this.locks.delete(id)
    }
  }
  private readProject(id: string) {
    const row = this.syncBuiltinStyles(this.projectRow(id))
    const project = { ...this.catalog.shared(row), episodes: this.catalog.allEpisodes(row) }
    restoreSavedPromptReferences(project)
    return project
  }
  async close() {
    await this.init
    this.media.dispose()
    this.generationQueue?.close()
    this.catalog.db.close()
  }
  async assetExtractionJobsFor(projectId: string) {
    await this.init
    assertId(projectId)
    this.projectRow(projectId)
    return this.assetExtractionJobs
  }
  async list(): Promise<ScriptVideoProject[]> {
    await this.init
    if (this.corruptLegacy.size) throw new ScriptVideoStoreError('部分旧项目无法读取，请检查原始存档', 500, 'CORRUPT')
    return this.catalog.db.transaction(() => this.catalog.directory().map(row => this.readProject(row.id)))()
  }
  async listSummaries() {
    await this.init
    return [...this.catalog.directory(), ...Array.from(this.corruptLegacy, id => ({ id, title: '存档待恢复 · ' + id, revision: 0 }))]
  }
  async summary(id: string) {
    await this.init
    return this.catalog.db.transaction(() => this.catalog.summary(this.syncBuiltinStyles(this.projectRow(id))))()
  }
  async episode(id: string, episodeId: string) {
    await this.init
    assertId(episodeId)
    assertId(id)
    return this.catalog.db.transaction(() => {
      const row = this.syncBuiltinStyles(this.projectRow(id))
      const result = this.catalog.episode(id, episodeId)
      if (!result) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      restoreSavedPromptReferences(this.catalog.shared(row), [result.episode])
      return result
    })()
  }
  async activity(id: string, episodeId: string) {
    await this.init
    assertId(id)
    assertId(episodeId)
    return this.catalog.db.transaction(() => {
      this.syncBuiltinStyles(this.projectRow(id))
      const result = this.catalog.activity(id, episodeId)
      if (!result) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      return result
    })()
  }
  async create(title: string, stylePreset?: ScriptVideoStylePreset): Promise<ScriptVideoProject> {
    if (typeof title !== 'string' || !title.trim())
      throw new ScriptVideoStoreError('项目名称必填')
    const episode = makeEpisode(),
      id = `project-${randomUUID()}`
    const project = sanitizeProject({
      id,
      title: title.trim(),
      revision: 0,
      assets: [],
      episodes: [episode],
      episodeId: episode.id,
      settings: initialProjectStyle(stylePreset),
    })
    project.revision = 1
    await this.exclusive(id, async () => this.writeRecord({ project, jobs: [] }))
    return project
  }
  /** Import an immutable source snapshot in one transaction. Repeating the same import opens the existing project. */
  async importScriptSnapshot(id: string, input: {
    title: string
    episodes: { title: string; script: string }[]
    assets: Pick<ScriptVideoDeliveryAsset, 'id' | 'kind' | 'name' | 'image'>[]
    stylePreset: ScriptVideoStylePreset
  }): Promise<ScriptVideoProject> {
    assertId(id)
    return this.exclusive(id, async () => this.catalog.db.transaction(() => {
      if (this.catalog.project(id)) return this.readProject(id)
      const episodes = input.episodes.map(({ title, script }, index) => ({
        ...makeEpisode(), number: index + 1, title, script,
      }))
      const project = sanitizeProject({
        id, title: input.title, revision: 1, assets: input.assets, episodes,
        episodeId: episodes[0]?.id || '', settings: initialProjectStyle(input.stylePreset),
      })
      this.writeRecord({ project, jobs: [] })
      return project
    }).immediate())
  }
  async get(id: string): Promise<ScriptVideoProject> {
    await this.init
    return this.catalog.db.transaction(() => this.readProject(id))()
  }

  // Presence is advisory. It never participates in a document write or reserves an episode.
  private liveViewers(id: string) {
    const viewers = this.episodeLeases.get(id) ?? new Map<string, EpisodeLease>()
    for (const [key, entry] of viewers) if (entry.expiresAt <= Date.now()) viewers.delete(key)
    if (!viewers.size) this.episodeLeases.delete(id)
    return viewers
  }
  async listEpisodeLeases(id: string, session: string | null) {
    await this.init
    assertId(id)
    const result: Record<string, { expiresAt: number }> = Object.create(null)
    for (const [key, viewer] of this.liveViewers(id)) {
      if (viewer.session === session) continue
      const episodeId = key.split('/')[0]
      result[episodeId] = { expiresAt: Math.max(result[episodeId]?.expiresAt ?? 0, viewer.expiresAt) }
    }
    return result
  }
  async acquireEpisodeLease(id: string, episodeId: string, session: string | null, _renew: boolean) {
    await this.init
    assertId(id)
    assertId(episodeId)
    if (!session) throw new ScriptVideoStoreError('缺少页面标识')
    if (!this.catalog.db.prepare('SELECT 1 FROM episodes WHERE project_id=? AND id=?').get(id, episodeId))
      throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
    const expiresAt = Date.now() + EPISODE_LEASE_MS
    const viewers = this.liveViewers(id)
    viewers.set(episodeId + '/' + session, { session, expiresAt })
    this.episodeLeases.set(id, viewers)
    return { expiresAt }
  }
  async releaseEpisodeLease(id: string, episodeId: string, session: string | null) {
    assertId(id)
    assertId(episodeId)
    this.liveViewers(id).delete(episodeId + '/' + session)
  }

  private assertRemovalsAllowed(before: ScriptVideoProject, afterEpisodes: ScriptVideoProject['episodes']) {
    const next = new Map(afterEpisodes.map(episode => [episode.id, episode]))
    for (const episode of before.episodes) {
      const remaining = new Set<string>((next.get(episode.id)?.cards || []).map((card: any) => card.id))
      if (next.has(episode.id) && episode.cards.every((card: any) => remaining.has(card.id))) continue
      if (this.queue.list(before.id, episode.id).some(item => !remaining.has(item.cardId)))
        throw new ScriptVideoStoreError('分镜正在排队，请先取消生成或等待完成', 409, 'VIDEO_RUNNING')
      if (!next.has(episode.id) && (episode.tasks?.some((task: any) => task.status === 'processing') ||
        this.catalog.db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND episode_id=? AND status IN ('queued','running') LIMIT 1").get(before.id, episode.id)))
        throw new ScriptVideoStoreError('分集还有任务在运行，请等任务结束后再删除', 409, 'PROJECT_BUSY')
    }
  }
  async delete(id: string, session?: string | null): Promise<void> {
    await this.exclusive(id, async () => {
      this.catalog.db.transaction(() => {
        const { project, jobs } = this.readRecord(id)
        const activeJob = jobs.some(job => job.status === 'queued' || job.status === 'running')
        const processingVideo = project.episodes.some(episode =>
          episode.tasks?.some((task: { status: string }) => task.status === 'processing'),
        )
        if (activeJob || processingVideo)
          throw new ScriptVideoStoreError('项目还有任务在运行，请等任务结束后再删除', 409, 'PROJECT_BUSY')
        this.assertRemovalsAllowed(project, [])
        this.media.replaceProjectAssets(id, project.assets, [])
        this.catalog.db.prepare('DELETE FROM projects WHERE id=?').run(id)
      }).immediate()
      this.media.scheduleCleanup()
      this.episodeLeases.delete(id)
    })
  }
  async update(
    id: string,
    input: unknown,
    expectedRevision: number,
    session?: string | null,
  ): Promise<ScriptVideoProject> {
    return this.exclusive(id, async () => this.catalog.db.transaction(() => {
      const record = this.readRecord(id)
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision !== record.project.revision
      )
        throw new ScriptVideoStoreError(
          '项目已更新，请刷新后重试',
          409,
          'CONFLICT',
        )
      if ((input as any)?.id !== id)
        throw new ScriptVideoStoreError('项目标识不匹配')
      const project = sanitizeProject(preserveServerAssetFields(input, record.project), record.project)
      assertChangedReferenceSources(project, record.project, project.episodes.map(episode => episode.id))
      this.assertRemovalsAllowed(record.project, project.episodes)
      project.revision = record.project.revision + 1
      record.project = project
      this.writeRecord(record)
      return project
    }).immediate())
  }
  async applyChanges(id: string, body: { clientId: string; sequence: number; changes: ScriptVideoChange[]; loadedEpisodeIds?: string[] }, user = '') {
    if (!body || !validId(body.clientId) || !Number.isSafeInteger(body.sequence) || body.sequence < 1)
      throw new ScriptVideoStoreError('保存请求标识无效')
    if (body.loadedEpisodeIds !== undefined && (!Array.isArray(body.loadedEpisodeIds) || !body.loadedEpisodeIds.every(validId)))
      throw new ScriptVideoStoreError('分集标识无效')
    try { validateScriptVideoChanges(body.changes) }
    catch (error) { throw new ScriptVideoStoreError((error as Error).message) }
    const { changes, sequence } = body
    const client = JSON.stringify([user, body.clientId])
    const edits = new Set<string>()
    for (const change of changes) {
      if ((change.target === 'card' || change.target === 'shot') && change.episodeId) edits.add(change.episodeId)
      if (change.target === 'episode' && change.id) edits.add(change.id)
    }
    const requested = new Set([...edits, ...(body.loadedEpisodeIds || [])])
    return this.exclusive(id, async () => {
      const db = this.catalog.db
      let assetsChanged = false
      const result = db.transaction(() => {
        const row = this.syncBuiltinStyles(this.projectRow(id))
        const last = db.prepare<[string, string], { sequence: number }>('SELECT sequence FROM client_writes WHERE project_id=? AND client_id=?').get(id, client)
        const fresh = !last || sequence > last.sequence
        if (fresh && changes.length) {
          const before = this.catalog.shared(row)
          const order: string[] = JSON.parse(row.episode_order)
          // Only edits whose meaning spans the whole project need to visit other episodes.
          const voiceModesOnly = changes.every(change => change.target === 'asset' && !change.order && !change.remove && !change.value &&
            [...Object.keys(change.fields || {}), ...(change.unset || [])].every(field => field === 'voiceMode'))
          const whole = !voiceModesOnly && changes.some(change => change.target === 'asset' && !change.order ||
            change.target === 'project' && [...Object.keys(change.fields || {}), ...(change.unset || [])].some(field =>
              field === 'settings' || field === 'settings.stylePreset' || field.startsWith('settings.stylePreset.')))
          const reapplyStyle = changes.some(change => change.target === 'project' && Object.entries(change.fields || {}).some(([field, value]) =>
            field === 'settings.stylePreset' || field.startsWith('settings.stylePreset.') ||
            field === 'settings' && value && typeof value === 'object' && Object.hasOwn(value, 'stylePreset')))
          before.episodes = whole ? this.catalog.allEpisodes(row)
            : [...edits].map(eid => this.catalog.episode(id, eid)?.episode).filter(Boolean)
          restoreSavedPromptReferences(before)
          let next: ScriptVideoProject
          try { next = applyScriptVideoChanges(before, changes) }
          catch (error) { throw new ScriptVideoStoreError((error as Error).message, 409, 'CHANGE_CONFLICT') }
          for (const episode of next.episodes) if (!before.episodes.some(prior => prior.id === episode.id))
            Object.assign(episode, { ...makeEpisode(), ...episode })
          if (whole) propagateSharedEdits(before, next, reapplyStyle)
          // Directory operations only need IDs, including when the new episode is inserted between unloaded ones.
          let nextOrder = order
          for (const change of changes) {
            if (change.target !== 'episode') continue
            if (change.order) {
              const known = new Set(nextOrder), listed = new Set(change.order)
              nextOrder = [...change.order.filter(id => known.has(id)), ...nextOrder.filter(id => !listed.has(id))]
            } else if (change.remove) nextOrder = nextOrder.filter(id => id !== change.id)
            else if (change.value && change.id && !nextOrder.includes(change.id)) nextOrder = [...nextOrder, change.id]
          }
          next.episodeId = ''
          next = sanitizeProject(preserveServerAssetFields(next, before), before, true)
          assertChangedReferenceSources(next, before, nextOrder, eid => this.catalog.episode(id, eid)?.episode)
          if (voiceModesOnly) {
            // A persisted toggle only affects speakers that actually use the
            // fallback. With an uploaded recording there is no episode work.
            const changedVoices = changedVoiceAssetIds(before.assets, next.assets)
            if (changedVoices.length) for (const episode of this.catalog.allEpisodes(row)) {
              const options = { model: episode.modelName, provider: episode.modelProvider,
                cast: episode.production?.characters, stylePreset: episode.production?.stylePreset || next.settings?.stylePreset }
              let changed = false
              for (const card of episode.cards) {
                if (card.status === 'ready' && card.videoUrl) continue
                const voices = getScriptVideoVoiceInputs(card, next.assets, options)
                if (!changedVoices.some(id => voices.has(id))) continue
                card.version = (Number(card.version) || 0) + 1
                card.status = 'draft'
                changed = true
              }
              if (changed) next.episodes.push(episode)
            }
          }
          next.episodeId = nextOrder.includes(before.episodeId) ? before.episodeId : nextOrder[0] || ''
          const deletions = order.filter(eid => !nextOrder.includes(eid))
          this.assertRemovalsAllowed(before, next.episodes)
          next.revision = row.revision + 1
          this.catalog.putProject(next, nextOrder, row)
          for (const eid of deletions) db.prepare('DELETE FROM episodes WHERE project_id=? AND id=?').run(id, eid)
          for (const episode of next.episodes) this.catalog.putEpisode(id, episode)
          assetsChanged = !isDeepStrictEqual(before.assets, next.assets)
          if (assetsChanged) this.media.replaceProjectAssets(id, before.assets, next.assets)
        }
        if (fresh) db.prepare('INSERT INTO client_writes VALUES(?,?,?) ON CONFLICT(project_id,client_id) DO UPDATE SET sequence=excluded.sequence')
          .run(id, client, sequence)
        const project = this.catalog.summary(this.projectRow(id))
        const episodes = [...requested].map(eid => this.catalog.episode(id, eid)?.episode).filter(Boolean)
        restoreSavedPromptReferences(project, episodes)
        return { project, episodes, revision: project.revision, sequence }
      }).immediate()
      if (assetsChanged) this.media.scheduleCleanup()
      return result
    })
  }
  async updateCharacterVoice(
    id: string, episodeId: string, assetId: string, session: string | null,
    field: 'voiceAudio' | 'voiceMode', expected: unknown, value: unknown,
  ): Promise<ScriptVideoProject> {
    return this.mutate(id, (record) => {
      const project = record.project
      if (!project.episodes.some(episode => episode.id === episodeId)) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      const index = project.assets.findIndex(asset => asset.id === assetId)
      const asset = project.assets[index]
      if (!asset || asset.kind !== 'character')
        throw new ScriptVideoStoreError('请选择项目里的角色资产')
      const current = asset[field] ?? null
      if (sameJson(current, value)) return { result: project, recordChanged: false }
      if (field === 'voiceAudio' && asset.voiceProfile && !sameJson(current, expected))
        throw new ScriptVideoStoreError('角色声音已更新，请刷新后重试', 409, 'CONFLICT')
      const next = { ...asset }
      if (value === null) delete next[field]
      else next[field] = value
      validateAsset(next)
      const assets = field === 'voiceAudio' && asset.voiceProfile
        ? setScriptVideoProfileAudio(project.assets, asset, value as ScriptVideoVoiceAudio | null)
        : project.assets.map((item, i) => i === index ? next : item)
      record.project = sanitizeProject({ ...project, assets }, project)
      return { result: record.project, documentChanged: true }
    })
  }
  confirmCharacterVoiceAge(projectId: string, assetId: string, ageStage: Exclude<ScriptVideoVoiceAgeStage, 'unknown'>) {
    return this.mutateAssets(projectId, assets => {
      const asset = assets.find(item => item.id === assetId && item.kind === 'character')
      if (!asset) throw new ScriptVideoStoreError('角色资产不存在', 404, 'NOT_FOUND')
      if (asset.confirmedVoiceAge === ageStage) return { result: { ageStage } }
      if (!asset.voiceProfile?.ageConflict?.includes(ageStage))
        throw new ScriptVideoStoreError('音色年龄选项已变化，请刷新后确认', 409, 'CONFLICT')
      if (asset.voiceAudio) throw new ScriptVideoStoreError('该造型已有参考音频，请先移除后确认年龄', 409, 'CONFLICT')
      return { assets: confirmScriptVideoVoiceAge(assets, asset, ageStage), result: { ageStage } }
    })
  }
  async saveCharacterVoiceDescription(
    projectId: string, assetId: string, description: ScriptVideoVoiceDescription,
  ): Promise<ScriptVideoVoiceDescription> {
    return this.mutateAssets(projectId, assets => {
      const index = assets.findIndex(asset => asset.id === assetId && asset.kind === 'character')
      const asset = assets[index]
      if (!asset) throw new ScriptVideoStoreError('角色资产不存在', 404, 'NOT_FOUND')
      const current: ScriptVideoVoiceDescription | undefined = asset.voiceDescription
      if (current && current.text === description.text && current.sourceLabel === description.sourceLabel) return { result: current }
      if (!description.text) return { result: description }
      const next = assets.slice()
      next[index] = { ...asset, voiceDescription: description }
      return { assets: next, result: description }
    })
  }
  mutateAssets<T>(id: string, update: (assets: ScriptVideoProject['assets'], project: ScriptVideoProject) => {
    assets?: ScriptVideoProject['assets']; result: T
  }): Promise<T> {
    return this.mutate(id, record => {
      const { assets, result } = update(record.project.assets, record.project)
      if (!assets || isDeepStrictEqual(assets, record.project.assets)) return { result, recordChanged: false }
      record.project = sanitizeProject({ ...record.project, assets }, record.project)
      return { result, documentChanged: true }
    })
  }
  /** Server-only mutation under the project lock. Document changes bump revision;
   * pass recordChanged: false when a conditional mutation found nothing to write. */
  async mutate<T>(id: string, fn: MutateRecord<T>, episodeId?: string, includePrevious = false): Promise<T> {
    return this.exclusive(id, async () => {
      const commit = (record: RecordFile, change: Mutation<T>) => {
        if (change.documentChanged) record.project.revision++
        if (change.documentChanged || change.recordChanged !== false) this.writeRecord(record)
        return change.result
      }
      // A reservation and an edit arriving in different server processes must
      // observe one another. Synchronous checks and writes share the SQLite writer.
      const state = this.catalog.db.transaction(() => {
        const record = this.readRecord(id, episodeId, true, includePrevious)
        const change = fn(record)
        if (change instanceof Promise) return { pending: change, record }
        return { result: commit(record, change) }
      }).immediate()
      // Legacy async callbacks run without a database transaction across await.
      // Their storageVersion check prevents a stale snapshot from being committed.
      if (state.pending) return commit(state.record, await state.pending)
      return state.result as T
    })
  }
  mutateEpisode<T>(id: string, episodeId: string, fn: MutateRecord<T>, includePrevious = false) {
    assertId(episodeId)
    return this.mutate(id, fn, episodeId, includePrevious)
  }

  async episodeSnapshot(id: string, episodeId: string, includePrevious = false) {
    await this.init
    assertId(episodeId)
    return this.catalog.db.transaction(() => this.readRecord(id, episodeId, false, includePrevious))()
  }

  // sys_task has committed its exact input URLs before this synchronous callback.
  attachVideoTask(id: string, jobId: string, taskId: number) {
    const db = this.catalog.db
    db.transaction(() => {
      const result = db.prepare(`UPDATE jobs SET task_id=?,document=json_set(document,'$.taskId',?)
        WHERE project_id=? AND id=? AND action='video' AND task_id IS NULL`).run(taskId, taskId, id, jobId)
      if (!result.changes) return
      db.prepare('UPDATE projects SET version=version+1 WHERE id=?').run(id)
      this.media.releaseJob(jobId)
    }).immediate()
    this.media.scheduleCleanup()
  }

  async getVideoJob(projectId: string, taskId: number): Promise<ScriptVideoJob> {
    await this.init
    assertId(projectId)
    const row = this.catalog.db.prepare<[string, number], { document: string }>("SELECT document FROM jobs WHERE project_id=? AND task_id=? AND action='video'").get(projectId, taskId)
    if (!row) throw new ScriptVideoStoreError('任务不属于此项目', 404, 'NOT_FOUND')
    return JSON.parse(row.document)
  }
  async listPendingVideoJobs(projectId: string, episodeId?: string, includeFailed = false) {
    await this.init
    assertId(projectId)
    if (episodeId && !this.catalog.db.prepare('SELECT 1 FROM episodes WHERE project_id=? AND id=?').get(projectId, episodeId))
      throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
    const failed = includeFailed ? `OR (jobs.status='failed'
      AND json_extract(jobs.document,'$.code') IN ('VIDEO_FAILED','SUBMISSION_UNKNOWN','DELIVERY_FAILED')
      AND json_extract(jobs.document,'$.cardId') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jobs newer
        WHERE newer.project_id=jobs.project_id AND newer.episode_id=jobs.episode_id AND newer.action='video'
          AND newer.rowid>jobs.rowid AND json_extract(newer.document,'$.cardId')=json_extract(jobs.document,'$.cardId')))` : ''
    const sql = `SELECT document FROM jobs WHERE project_id=? AND action='video' AND task_id IS NOT NULL
      AND (status IN ('queued','running') ${failed})`
    const rows = this.catalog.db.prepare<unknown[], { document: string }>(sql + (episodeId ? ' AND episode_id=?' : '') + ' ORDER BY rowid')
      .all(...(episodeId ? [projectId, episodeId] : [projectId]))
    return rows.map(row => JSON.parse(row.document) as ScriptVideoJob & { taskId: number })
  }
  async listJobs(projectId: string, episodeId?: string, restore = false): Promise<ScriptVideoJob[]> {
    await this.init
    assertId(projectId)
    if (!this.catalog.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) this.projectRow(projectId)
    if (restore) {
      assertId(episodeId)
      return this.catalog.restoreJobs(projectId, episodeId).map(publicScriptVideoJob)
    }
    return this.catalog.jobs(projectId, episodeId).map(publicScriptVideoJob)
  }
  async getJob(projectId: string, jobId: string) {
    await this.init
    assertId(projectId)
    assertId(jobId)
    const row = this.catalog.db.prepare<[string, string], { document: string }>('SELECT document FROM jobs WHERE project_id=? AND id=?').get(projectId, jobId)
    if (!row) throw new ScriptVideoStoreError('任务不存在', 404, 'NOT_FOUND')
    return publicScriptVideoJob(JSON.parse(row.document))
  }

  async cancelTextJob(projectId: string, jobId: string, session: string | null) {
    assertId(jobId)
    return this.mutate(projectId, record => {
      const job = record.jobs.find(item => item.id === jobId && item.action !== 'video')
      if (!job) throw new ScriptVideoStoreError('文字生成任务不存在', 404, 'NOT_FOUND')
      if (job.status !== 'queued' && job.status !== 'running') {
        return { result: publicScriptVideoJob(job), recordChanged: false }
      }
      job.status = 'canceled'
      job.code = 'CANCELED'
      job.error = '生成已取消，现有内容已保留'
      job.updatedAt = new Date().toISOString()
      delete job.checkpoint
      return { result: publicScriptVideoJob(job) }
    })
  }
}
