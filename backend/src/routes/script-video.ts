import { registerScriptVideoQueueRoutes } from './script-video-queue.js'
import { registerScriptVideoProjectExportRoutes } from './script-video-project-export.js'
import { registerScriptVideoAssetExtractionRoutes } from './script-video-asset-extraction.js'
import { createScriptVideoAssetImages } from './script-video-asset-images.js'
import { registerScriptVideoVoiceGenerationRoutes } from './script-video-voice-generation.js'
import { Hono } from 'hono'
import { randomUUID, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { scriptVideoCharacterName, scriptVideoCharacterBase } from '../services/script-video-asset-identity.js'
import { isAicostHost } from '../agents/openai-model.js'
import { db, schema } from '../db/index.js'
import { success, created } from '../utils/response.js'
import {
  ScriptVideoStore,
  getDefaultScriptVideoStore,
  ScriptVideoStoreError,
  OUTLINE_DURATION_POLICY,
  assertOutlineDurationPolicy,
  publicScriptVideoJob,
  scriptVideoSession,
  scriptVideoReferencedAssetIds,
  scriptVideoVisualAssetInput,
  type ScriptVideoJob,
  type ScriptVideoProject,
} from '../services/script-video-store.js'
import { cancelDispatchedVideoTask, cancelUnsubmittedVideoTask, recoverVideoTask } from '../services/generation.js'
import { getActiveConfig, getConfigById, getTextProviderBaseUrl } from '../services/ai.js'
import { getVideoPromptMode } from '../services/app-settings.js'
import { isVideoPromptMode } from '../services/video-prompt-mode.js'
import { requireJimengPrivateAccess } from './jimeng.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess, trustedSiteUser } from '../utils/private-access.js'
import {
  startScriptVideoGeneration,
  getScriptVideoGeneration,
  getScriptVideoSubmissionPrompt,
  prepareScriptVideoArchiveImages,
  prepareScriptVideoDeliveryReferences,
  scriptVideoOpeningImage,
  ScriptVideoGenerationValidationError,
  previewScriptVideoPrompt,
  scriptVideoMissingVoicesMessage,
  type ScriptVideoContinuationSource,
  type ScriptVideoGenerationInput,
  type ScriptVideoGenerationStatus,
} from '../services/script-video-generation.js'
import { getScriptVideoMissingVoices, getScriptVideoVoiceInputs } from '../services/script-video-delivery.js'
import { isScriptVideoGenerationDuration } from '../services/script-video-capabilities.js'
import { isSeedance25Model } from '../services/seedance-models.js'
import { assertScriptVideoFormal, getScriptVideoContentWarnings, ScriptVideoAIError, type ScriptVideoCard, type ScriptVideoInput } from '../services/script-video-types.js'
import { hasScriptVideoPromptBody, scriptVideoPromptStylePrefix } from '../services/script-video-style.js'
import { getCurrentScriptVideoStylePresets } from '../services/script-video-style-source.js'
import { DEFAULT_SCRIPT_VIDEO_STORYBOARD_MODE, isScriptVideoStoryboardMode, type ScriptVideoStoryboardMode } from '../services/script-video-storyboard-mode.js'
import { legacyScriptVideoInnerOs } from '../services/script-video-inner-os.js'
import {
  generateScriptVideoOutline,
  generateScriptVideoCards,
  reviewScriptVideoEpisode,
  reviseScriptVideoCard,
} from '../services/script-video-ai.js'
import { getScriptVideoContinuationScene } from '../services/script-video-scene-boundary.js'
import { previousScriptVideoCard, previousScriptVideoEpisode, previousScriptVideoRender } from '../services/script-video-predecessor.js'
import { fallbackScriptVideoLightingRange, isActiveScriptVideoRender, planScriptVideoLighting, prepareScriptVideoLighting, reviewScriptVideoLighting, selectedScriptVideoRenders, type RenderLightingRange } from '../services/script-video-lighting.js'
import { extractVideoReferenceFrame } from '../utils/video-reference-frame.js'
import { scriptVideoReferenceSourceUrl, validScriptVideoFrameTime, validScriptVideoReferenceCardId, type ScriptVideoReferenceFrameRow, type ScriptVideoReferenceFrames } from '../services/script-video-reference-settings.js'
import { safeTaskError } from '../services/video-download.js'
import { holdVideoCliSubmission } from '../services/video-cli-tasks.js'
import { resolveVideoCliAccountId } from '../services/video-cli-accounts.js'
import { getScriptVideoMerge, mergeScriptVideoClips } from '../services/ffmpeg-merge.js'
import { resolveStoredVideo } from '../utils/video-poster.js'
import { latestScriptVideoTaskUrls, listScriptVideoVersions, officialScriptVideoUrl, selectScriptVideoPlayback, type ScriptVideoVersion } from '../services/script-video-versions.js'

type Action = 'outline' | 'storyboard' | 'revisions' | 'review'
const SESSION_HEADER = 'X-Script-Video-Session'
const safeError = (error: unknown) =>
  error instanceof ScriptVideoStoreError
    ? error
    : new ScriptVideoStoreError('任务执行失败，请检查配置并重试', 500, 'FAILED')
function respondError(c: any, error: unknown) {
  const e = safeError(error)
  if ((error as any)?.constructor?.name === 'ScriptVideoAIError') {
    const source = error as any
    return c.json(
      {
        code: source.status || 422,
        message: source.message,
        errorCode: source.code,
        issues: source.issues,
      },
      source.status || 422,
    )
  }
  return c.json(
    { code: e.status, message: e.message, errorCode: e.code },
    e.status,
  )
}
function episodeOf(project: ScriptVideoProject, episodeId: string) {
  const episode = project.episodes.find((item) => item.id === episodeId)
  if (!episode) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
  return episode
}
function readVideoPromptMode(value: unknown) {
  if (value === undefined || isVideoPromptMode(value)) return value
  throw new ScriptVideoStoreError('请选择有效的视频提示词入参模式')
}
function digest(
  project: ScriptVideoProject,
  episodeId: string,
  action: Action | 'video',
  cardId?: string,
  video?: Pick<ScriptVideoJob, 'videoDigestVersion' | 'videoModel' | 'videoProvider' | 'videoPromptMode' | 'videoIgnoresPredecessor'>,
  legacyText = false,
) {
  const ep = episodeOf(project, episodeId)
  const perCard = action === 'revisions' || action === 'video'
  const cardIndex =
    perCard
      ? ep.cards.findIndex((item: any) => item.id === cardId)
      : -1
  const card = cardIndex >= 0 ? ep.cards[cardIndex] : undefined
  const previousCard = cardIndex > 0 ? ep.cards[cardIndex - 1]
    : (video?.videoDigestVersion ?? 0) >= 9 && cardId ? previousScriptVideoCard(project, episodeId, cardId)?.card : undefined
  if (perCard && !card)
    throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
  // Downloading a result changes the display state, not the inputs to this submission.
  const digestVersion = video?.videoDigestVersion ?? 0
  const scopedVoices = digestVersion >= 3
  // Retain the original default for renders submitted before the new opt-in default.
  const legacyVoiceMode = digestVersion === 4 || digestVersion === 7 ? 'model' : 'reference'
  const voiceAssets = scopedVoices && digestVersion < 8 ? project.assets.map(asset =>
    asset.kind === 'character' && asset.voiceMode === undefined ? { ...asset, voiceMode: legacyVoiceMode } : asset,
  ) : project.assets
  const legacyVideoPrompt = (prompt: string) => {
    const style = ep.production?.stylePreset || project.settings?.stylePreset
    // Existing render digests used the former OS spelling. Keep that hash
    // representation while display and submission retain the short marker.
    return legacyScriptVideoInnerOs(prompt, {
      protectedPrefix: style && scriptVideoPromptStylePrefix(style),
      speakers: [...project.assets.filter(asset => asset.kind === 'character').map(asset => asset.name),
        ...(ep.production?.characters?.map((role: { name: string }) => role.name) ?? [])],
      referenceAudioNames: project.assets.filter(asset => asset.kind === 'audio').map(asset => asset.name),
    })
  }
  const videoInput = (value: typeof card, predecessor = false) => {
    if (!value) return value
    const { status: _status, videoUrl: _videoUrl, videoVersions: _videoVersions, referenceFrameSettings: _nextFrames, ...fields } = value
    // A predecessor's voice-only revision does not change the tail frame that
    // was selected for this submission. Its actual shot fields still matter.
    if (scopedVoices && predecessor) delete fields.version
    if (action === 'video' && digestVersion <= 9 && typeof fields.prompt === 'string') {
      fields.prompt = legacyVideoPrompt(fields.prompt)
    }
    return fields
  }
  if (digestVersion >= 6) {
    // The submission already owns its provider/model settings. A subsequent
    // picker change or an unrelated edit must not send this render to history.
    const stylePreset = ep.production?.stylePreset || project.settings?.stylePreset
    const cast = ep.production?.characters?.map(({ name }: { name: string }) => ({ name }))
    const voiceInputs = getScriptVideoVoiceInputs(card, voiceAssets, {
      model: video?.videoModel, provider: video?.videoProvider, promptMode: video?.videoPromptMode, cast, stylePreset,
    })
    const assetIds = new Set([...scriptVideoReferencedAssetIds(card), ...voiceInputs.keys()])
    const assets = project.assets.filter(asset => assetIds.has(asset.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(asset => [scriptVideoVisualAssetInput(asset), voiceInputs.get(asset.id)])
    const predecessor = !video?.videoIgnoresPredecessor && previousCard && getScriptVideoContinuationScene(previousCard, card, project.assets)
      ? videoInput(previousCard, true)
      : undefined
    const snapshot = { card: videoInput(card), predecessor, assets, cast, stylePreset,
      confirmedScript: ep.confirmedScript, confirmed: ep.confirmed, outlineConfirmed: ep.outlineConfirmed }
    return createHash('sha256').update(JSON.stringify(snapshot, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        : value,
    )).digest('hex')
  }
  let assets = project.assets
  if (scopedVoices) {
    const model = video?.videoModel ?? ep.modelName
    const voiceInputs = getScriptVideoVoiceInputs(card, voiceAssets, {
      model, provider: model === ep.modelName ? ep.modelProvider : undefined,
      cast: ep.production?.characters, stylePreset: ep.production?.stylePreset || project.settings?.stylePreset,
    })
    assets = project.assets.map(({ voiceAudio, voiceMode, ...asset }) => {
      const input = voiceInputs.get(asset.id)
      if (input === 'model' || input === 'reference') {
        return digestVersion >= 4 ? { ...asset, voiceMode: input } : asset
      }
      return input ? { ...asset, voiceAudio: input } : asset
    })
  }
  const textInput = action !== 'video' && !video && !legacyText
  if (textInput) {
    assets = assets.map(asset => ({       id: asset.id, name: asset.name, kind: asset.kind,
      ...(asset.kind === 'character' && {         nameInScript: scriptVideoCharacterName(asset), base: scriptVideoCharacterBase(asset),
        hasVoiceReference: !!asset.voiceAudio?.url       })     }))
  }
  const textCard = (card: any) => {
    if (!card) return card
    const { status, version, videoUrl, videoVersions, referenceFrameSettings, ...input } = card
    return input
  }
  const selectedCards = perCard ? [previousCard, card] : ep.cards
  const digestCards = action === 'video' ? [videoInput(previousCard, true), videoInput(card)]
    : textInput ? selectedCards.map(textCard) : selectedCards.map((card: any) => {
      if (!card) return card
      const { videoVersions, referenceFrameSettings, ...fields } = card
      // Version-zero video jobs used the revisions-shaped snapshot. Ordinary
      // text jobs keep their authored short OS spelling in their own digests.
      if (video && digestVersion <= 8 && typeof fields.prompt === 'string') fields.prompt = legacyVideoPrompt(fields.prompt)
      return fields
    })
  const input = {
    title: project.title,
    assets,
    script: ep.script,
    confirmedScript: ep.confirmedScript,
    confirmed: ep.confirmed,
    outlineConfirmed: ep.outlineConfirmed,
    outlineDurationPolicy: ep.outlineDurationPolicy,
    characterAppearanceNotes: ep.characterAppearanceNotes,
    production: ep.production,
    cards: digestCards,
    settings: project.settings,
    textConfigId: ep.textConfigId,
    textModel: ep.textModel,
    modelKey: ep.modelKey,
    modelConfigId: ep.modelConfigId,
    modelName: ep.modelName,
    aspectRatio: ep.aspectRatio,
    resolution: ep.resolution,
  }
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}
/** Bind a checkpoint to the exact project snapshot and effective text options.
 * A change to any active text configuration invalidates reuse conservatively.
 * API keys only contribute through the final digest and are never stored. */
function storyboardResumeKey(project: ScriptVideoProject, episodeId: string, body: any, mode: ScriptVideoStoryboardMode, legacyText = false): string {
  const ep = episodeOf(project, episodeId)
  const configs = db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.serviceType, 'text')).all()
    .sort((a, b) => a.id - b.id)
  const textOptions = {
    configId: body.configId ?? ep.textConfigId,
    model: body.model ?? ep.textModel,
    systemPrompt: body.systemPrompt ?? project.settings?.systemPrompt,
    combatEnabled: body.combatEnabled ?? project.settings?.combatEnabled,
    autoSelectCharacterBases: body.autoSelectCharacterBases ?? project.settings?.autoSelectCharacterBases,
    // Existing original-mode checkpoints were recorded without a mode field.
    ...(mode === 'cultivation' && { storyboardMode: mode }),
    configs,
  }
  return createHash('sha256').update(JSON.stringify({
    schema: 'script-video-storyboard-resume-v1',
    projectDigest: digest(project, episodeId, 'storyboard', undefined, undefined, legacyText),
    textOptions,
  })).digest('hex')
}
async function storyboardBatchSize(configId: number | undefined, job: ScriptVideoJob) {
  const { checkpoint, progress } = job
  const partial = checkpoint?.partialRaw
  // A legacy attempt can use the current batching rule when it stopped before receiving any draft.
  if (checkpoint && (
    progress?.batchSize !== undefined || progress?.phase !== 'generating' || progress.completed ||
    progress.repairAttempts || progress.segmentRepairAttempts ||
    checkpoint.cards.length || checkpoint.production || checkpoint.timingPlan || checkpoint.candidate ||
    partial?.cards.length || partial?.production !== undefined || partial?.placement?.length ||
    checkpoint.repairAttempts || checkpoint.segmentRepairAttempts || checkpoint.repairFeedback?.length ||
    checkpoint.reviewRepairs || checkpoint.repairIssues?.length || checkpoint.reviewDrafts?.length || checkpoint.reviewed
  )) return progress?.batchSize

  const config = configId == null
    ? await getActiveConfig('text')
    : Number.isSafeInteger(configId) && configId > 0 ? await getConfigById(configId) : undefined
  if (!config) return
  const provider = config.provider.toLowerCase()
  if (provider === 'gemini') return
  const baseUrl = getTextProviderBaseUrl(config)
  const host = URL.parse(baseUrl)?.hostname
  if (provider === '302ai' || host === 'api.302.ai' || host === 'api.302ai.com' || isAicostHost(baseUrl)) return 1
}
function requireConfirmed(ep: any, action: Action) {
  if (!ep.confirmed || !String(ep.confirmedScript || '').trim())
    throw new ScriptVideoStoreError('请先确认剧本')
  if (action === 'storyboard' && (!ep.outlineConfirmed || !ep.cards.length))
    throw new ScriptVideoStoreError('请先确认分段大纲')
  if (action === 'storyboard' && ep.outlineDurationPolicy === OUTLINE_DURATION_POLICY)
    assertOutlineDurationPolicy(ep.cards)
  if (action === 'review') {
    if (!ep.outlineConfirmed || !ep.production || !ep.cards.length || ep.cards.some((card: any) => !card.shots?.length || !card.prompt?.trim()))
      throw new ScriptVideoStoreError('请先生成整集正式分镜，再进行 AI 复核', 422, 'STORYBOARD_REQUIRED')
    requireSynchronized(ep.cards)
  }
}
function requireSynchronized(cards: any[]) {
  if (cards.some(card => card.promptNeedsSync)) throw new ScriptVideoStoreError('镜头已修改，请先同步视频提示词后再交付或生成', 422, 'PROMPT_NEEDS_SYNC')
}
function reconcileRejectedVideoSubmission(
  episode: ScriptVideoProject['episodes'][number],
  job: ScriptVideoJob,
  state: ScriptVideoGenerationStatus | null,
) {
  if (
    job.status !== 'failed' ||
    job.code !== 'SUBMISSION_UNKNOWN' ||
    state?.status !== 'failed' ||
    state.code !== 'VIDEO_FAILED'
  ) return false
  job.code = state.code
  job.error = state.error || '视频生成失败，请检查模型配置后重试'
  job.updatedAt = new Date().toISOString()
  const task = episode.tasks?.find((item: any) => item.id === job.id)
  if (!task) return false
  task.code = job.code
  task.error = job.error
  return true
}
function errorInfo(error: any) {
  // Only the explicit AI validation error is safe to present; provider errors can include credentials.
  if (error instanceof ScriptVideoStoreError)
    return { message: error.message, code: error.code, issues: [] }
  if (
    error?.name === 'ScriptVideoAIError' ||
    error?.constructor?.name === 'ScriptVideoAIError'
  )
    return {
      message: String(error.message || '生成失败').slice(0, 500),
      code: String(error.code || 'AI_FAILED'),
      issues: Array.isArray(error.issues)
        ? error.issues
            .slice(0, 20)
            .map((issue: any) => ({
              code: String(issue.code || '').slice(0, 80),
              message: String(issue.message || '').slice(0, 500),
            }))
        : [],
    }
  return {
    message: '生成失败，请检查文字模型配置后重试',
    code: 'AI_FAILED',
    issues: [],
  }
}

type ScriptVideoDependencies = {
  generateScriptVideoOutline: typeof generateScriptVideoOutline
  generateScriptVideoCards: typeof generateScriptVideoCards
  reviewScriptVideoEpisode: typeof reviewScriptVideoEpisode
  reviseScriptVideoCard: typeof reviseScriptVideoCard
  assertScriptVideoFormal: typeof assertScriptVideoFormal
  startScriptVideoGeneration: typeof startScriptVideoGeneration
  getScriptVideoGeneration: typeof getScriptVideoGeneration
  recoverVideoTask: typeof recoverVideoTask
}
const defaultDependencies: ScriptVideoDependencies = {
  generateScriptVideoOutline,
  generateScriptVideoCards,
  reviewScriptVideoEpisode,
  reviseScriptVideoCard,
  assertScriptVideoFormal,
  startScriptVideoGeneration,
  getScriptVideoGeneration,
  recoverVideoTask,
}
type VideoCheck = { job: ScriptVideoJob; state: ScriptVideoGenerationStatus }

function needsVideoReconciliation({ job, state }: VideoCheck) {
  if (job.status === 'completed' || job.status === 'canceled' || job.code?.endsWith('_ACKNOWLEDGED')) return false
  if (job.status === 'failed') {
    return state.status !== 'failed' || Boolean(job.canRecover) !== Boolean(state.canRecover) ||
      Boolean(state.code && job.code !== state.code) || Boolean(state.error && job.error !== state.error)
  }
  return state.status !== 'processing'
}

export function createScriptVideoRoutes(
  store = new ScriptVideoStore(),
  dependencies: ScriptVideoDependencies = defaultDependencies,
) {
  const app = new Hono()
  const queue = store.queue
  registerScriptVideoQueueRoutes(app, store, queue)
  registerScriptVideoProjectExportRoutes(app, store, respondError)
  registerScriptVideoAssetExtractionRoutes(app, store, respondError)
  registerScriptVideoVoiceGenerationRoutes(app, store, respondError)
  const assetImages = createScriptVideoAssetImages(store)
  app.route('/', assetImages.routes)
  const videoSubmissions = new Map<string, { controller: AbortController; taskId?: number }>()
  const canceledVideoRequests = new Map<string, number>()
  const videoRequestKey = (project: string, episode: string, session: string | null, request: string) =>
    `${project}/${episode}/${session}/${request}`
  const isVideoRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
  const aiJobControllers = new Map<string, AbortController>()

  function queuedReferenceCards(project: ScriptVideoProject, episodeId: string, session?: string | null, requestId?: string) {
    const index = project.episodes.findIndex(episode => episode.id === episodeId)
    return new Set(project.episodes.slice(Math.max(0, index - 1), index + 1).flatMap(episode => queue.list(project.id, episode.id))
      .filter(row => row.episodeId !== episodeId || row.session !== session || row.requestId !== requestId)
      .map(row => row.cardId))
  }

  async function continuationSource(
    project: ScriptVideoProject, jobs: ScriptVideoJob[], episodeId: string, cardId: string,
    queuedCards: ReadonlySet<string>, readOnly = false, automatic = false,
  ): Promise<ScriptVideoContinuationSource | 'pending' | 'missing' | undefined> {
    const episode = episodeOf(project, episodeId)
    const index = episode.cards.findIndex((card: { id: string }) => card.id === cardId)
    if (index < 0) return undefined
    const choice = automatic ? undefined : episode.cards[index].referenceFrameSettings?.tail
    if (choice?.mode === 'off') return undefined
    if (choice?.mode === 'manual') {
      const owner = previousScriptVideoRender(project, episodeId, cardId, choice.videoUrl, choice.sourceCardId, choice.sourceEpisodeId)
      if (owner) return { previousCardId: owner.cardId, previousTaskId: owner.taskId, videoUrl: owner.videoUrl,
        ...(owner.sourceEpisodeId && { sourceEpisodeId: owner.sourceEpisodeId }), manualSeconds: choice.seconds }
      if (choice.sourceCardId && !readOnly)
        throw new ScriptVideoStoreError('手选尾帧的来源成片已不可用，请重新选帧。', 422, 'REFERENCE_FRAME_UNAVAILABLE')
      return undefined
    }
    const adjacent = previousScriptVideoCard(project, episodeId, cardId)
    if (!adjacent) return undefined
    const predecessor: ScriptVideoCard = adjacent.card
    if (!getScriptVideoContinuationScene(predecessor, episode.cards[index], project.assets)) return undefined
    if (queuedCards.has(predecessor.id) || jobs.some(job => job.episodeId === adjacent.episode.id && isActiveScriptVideoRender(job, predecessor))) return 'pending'
    const previous = selectedScriptVideoRenders(adjacent.episode, jobs).get(predecessor.id)
    if (!previous) return 'missing'
    const sameVersion = previous.cardVersion === undefined || previous.cardVersion === predecessor.version
    const shots = sameVersion && Array.isArray(predecessor.shots) ? predecessor.shots : []
    const state = previous.taskId && await dependencies.getScriptVideoGeneration(previous.taskId, {
      reconcileRejection: !readOnly, finalShotNumber: sameVersion ? shots.length : 'last',
    }).catch(() => null)
    const submitted = state && state.status === 'completed' && state.videoUrl === previous.videoUrl ? state : undefined
    if (!submitted && !await resolveStoredVideo(previous.videoUrl).catch(() => null)) return 'missing'
    const matchesDuration = (seconds: number, duration: number) => Number.isFinite(duration) && Math.abs(seconds - duration) <= 0.001
    const durations = shots.map(shot => shot?.duration)
    const shotEndSeconds = durations.reduce((total, duration) => total + duration, 0)
    const hasShotTiming = durations.length > 0 && durations.every(duration => Number.isFinite(duration) && duration > 0) &&
      matchesDuration(shotEndSeconds, predecessor.duration)
    const previousDuration = previous.videoDuration ?? (sameVersion ? predecessor.duration : undefined)
    const submittedRange = submitted?.finalShotRange
    const shotRange = submittedRange && (previousDuration === undefined || matchesDuration(submittedRange.shotEndSeconds, previousDuration)) ? submittedRange
      : hasShotTiming && previousDuration !== undefined ? {
        shotStartSeconds: (shotEndSeconds - durations.at(-1)!) * previousDuration / predecessor.duration,
        shotEndSeconds: previousDuration,
      } : undefined
    return {
      previousCardId: predecessor.id, ...(previous.taskId && { previousTaskId: previous.taskId }), videoUrl: previous.videoUrl,
      ...shotRange,
    }
  }

  async function reconcileVideoResults(projectId: string, checks: VideoCheck[]) {
    const updates = checks.filter(needsVideoReconciliation)
    if (!updates.length) return
    const lightingReviews = new Map<string, number[]>()
    for (const { job, state } of updates) {
      if (state.status === 'completed' && state.videoUrl && job.lightingChecks?.length) {
        const shots = await reviewScriptVideoLighting(state.videoUrl, job.lightingChecks).catch(() => [])
        if (shots.length) lightingReviews.set(job.id, shots)
      }
    }
    await store.mutate(projectId, (record) => {
      let recordChanged = false
      let documentChanged = false
      const currentJobs = new Map(record.jobs.map(job => [job.id, job]))
      const latestVideoJobs = new Map(record.jobs.filter(job => job.action === 'video')
        .map(job => [`${job.episodeId}/${job.cardId}`, job.id]))
      const completedCards: { card: any; version: ScriptVideoVersion }[] = []
      const acceptedRenders = new Map<string, { videoUrl: string; taskId?: number }>()
      const cardOrder = new Map<string, number>(record.project.episodes.flatMap(episode =>
        episode.cards.map((card: ScriptVideoCard) => `${episode.id}/${card.id}`),
      ).map((key, index) => [key, index]))
      // A source and its successor may finish in the same poll. Validate the
      // successor against the source that this batch will actually promote.
      const ordered = updates.slice().sort((a, b) =>
        (cardOrder.get(`${a.job.episodeId}/${a.job.cardId}`) ?? Infinity) -
        (cardOrder.get(`${b.job.episodeId}/${b.job.cardId}`) ?? Infinity))
      for (const { job, state } of ordered) {
        const current = currentJobs.get(job.id)
        if (!current || current.status !== job.status || current.updatedAt !== job.updatedAt || current.code !== job.code) continue
        const episode = record.project.episodes.find(item => item.id === job.episodeId)
        current.status = state.status === 'processing' ? 'running' : state.status
        current.updatedAt = new Date().toISOString()
        current.canRecover = undefined
        if (state.status === 'failed') {
          current.error = state.error || '视频生成失败，请检查模型配置后重试'
          current.code = state.code || 'VIDEO_FAILED'
          current.canRecover = state.canRecover === true ? true : undefined
        } else {
          current.code = state.status === 'canceled' ? 'CANCELED' : undefined
          current.error = undefined
        }
        const card = episode?.cards?.find((item: any) => item.id === job.cardId)
        const task = episode?.tasks?.find((item: any) => item.id === job.id)
        if (state.status === 'completed' && state.videoUrl) {
          const handoff = task?.continuation
          const adjacent = episode && previousScriptVideoCard(record.project, episode.id, job.cardId!)
          const selected = episode && new Map([
            ...(adjacent ? selectedScriptVideoRenders(adjacent.episode, record.jobs) : []),
            ...selectedScriptVideoRenders(episode, record.jobs),
            ...acceptedRenders,
          ])
          const previous = handoff && selected?.get(handoff.previousCardId)
          const hasManualSource = (sourceCardId: string, videoUrl?: string, sourceEpisodeId?: string) => !videoUrl || !!episode && !!job.cardId &&
            previousScriptVideoRender(record.project, episode.id, job.cardId, videoUrl, sourceCardId, sourceEpisodeId)?.cardId === sourceCardId
          const sameTailSource = !handoff || (handoff.manualSeconds !== undefined
            ? hasManualSource(handoff.previousCardId, handoff.previousVideoUrl, handoff.previousEpisodeId)
            : !!previous && (handoff.previousVideoUrl ? previous.videoUrl === handoff.previousVideoUrl : previous.taskId === handoff.previousTaskId))
          const sameLightingSources = (task?.lightingRanges || []).every(({ imageUrl, source }: RenderLightingRange) =>
            !imageUrl || !source || (source.manualSeconds !== undefined
              ? hasManualSource(source.cardId, source.videoUrl, source.sourceEpisodeId) : selected?.get(source.cardId)?.videoUrl === source.videoUrl))
          if (latestVideoJobs.get(`${job.episodeId}/${job.cardId}`) === job.id &&
              card && card.version === job.cardVersion && sameTailSource && sameLightingSources &&
              digest(record.project, job.episodeId, job.videoDigestVersion ? 'video' : 'revisions', job.cardId, job) === job.baseDigest) {
            completedCards.push({ card, version: {
              url: state.videoUrl,
              ...(task?.modelLabel && { modelLabel: task.modelLabel }),
              ...(task?.duration && { duration: task.duration }),
            } })
            acceptedRenders.set(card.id, { videoUrl: state.videoUrl, taskId: current.taskId })
          } else {
            // A regenerated video can be stale while the same-version old render stays ready.
            current.staleResult = true
          }
        }
        if (task) {
          if (current.taskId) task.taskId = current.taskId
          task.status = state.status
          task.videoUrl = state.videoUrl
          task.error = current.error
          task.code = current.code
          task.canRecover = current.canRecover
          if (lightingReviews.has(job.id)) task.lightingReviewShots = lightingReviews.get(job.id)
          if (current.staleResult) task.staleResult = true
          documentChanged = true
        }
        recordChanged = true
      }
      // Legacy video digests include the previous card's result URL.
      for (const { card, version } of completedCards) {
        const archive = listScriptVideoVersions(card)
        if (!archive.some(item => item.url === version.url)) archive.push(version)
        card.videoVersions = archive
        card.videoUrl = version.url
        card.status = 'ready'
        documentChanged = true
      }
      return { result: null, recordChanged, documentChanged }
    }, updates.every(check => check.job.episodeId === updates[0].job.episodeId) ? updates[0].job.episodeId : undefined, true)
  }

  async function refreshPendingVideos(projectId: string, episodeId?: string, resumeOriginal = false) {
    const jobs = await store.listPendingVideoJobs(projectId, episodeId, resumeOriginal)
    const checks = (await Promise.all(jobs.map(async (job): Promise<VideoCheck | null> => {
      // A read failure cannot tell us that a previously failed job has resumed.
      const state = await dependencies.getScriptVideoGeneration(job.taskId, { resumeOriginal }).catch(() =>
        job.status === 'failed' ? null : { taskId: job.taskId, status: 'processing' as const, stage: 'submitting' })
      return state ? { job, state } : null
    }))).filter((check): check is VideoCheck => check !== null)
    await reconcileVideoResults(projectId, checks)
    return checks.map(({ state }) => state)
  }

  async function refreshVideoReferenceSources(
    snapshot: Awaited<ReturnType<ScriptVideoStore['episodeSnapshot']>>, episodeId: string, cardId: string,
  ) {
    const { project, jobs } = snapshot
    if (!jobs.some(job => job.action === 'video' && job.taskId && (job.status === 'queued' || job.status === 'running'))) return snapshot
    const episode = episodeOf(project, episodeId)
    const index = episode.cards.findIndex((card: ScriptVideoCard) => card.id === cardId)
    const adjacent = previousScriptVideoCard(project, episodeId, cardId)
    if (!adjacent) return snapshot
    const predecessor: ScriptVideoCard = adjacent.card
    const activeSources = new Set((planScriptVideoLighting(project, episodeId, jobs)[cardId] || []).flatMap(range =>
      range.pendingCardId ? [range.pendingCardId] : [],
    ))
    if (!episode.cards[index].referenceFrameSettings?.tail && getScriptVideoContinuationScene(predecessor, episode.cards[index], project.assets)) activeSources.add(predecessor.id)
    const activeCards = new Map<string, ScriptVideoCard>(adjacent.episode.cards.filter((card: ScriptVideoCard) => activeSources.has(card.id))
      .map((card: ScriptVideoCard) => [card.id, card]))
    const checks = (await Promise.all(jobs.map(async (job): Promise<VideoCheck | null> => {
      const card = job.cardId && activeCards.get(job.cardId)
      if (job.episodeId !== adjacent.episode.id || !job.taskId || !card || !isActiveScriptVideoRender(job, card)) return null
      const state = await dependencies.getScriptVideoGeneration(job.taskId).catch(() => null)
      return state && needsVideoReconciliation({ job, state }) ? { job, state } : null
    }))).filter((item): item is VideoCheck => item !== null)
    if (!checks.length) return snapshot
    await reconcileVideoResults(project.id, checks)
    return store.episodeSnapshot(project.id, episodeId, true)
  }

  app.get('/style-presets', (c) => {
    c.header('Cache-Control', 'no-store')
    return success(c, getCurrentScriptVideoStylePresets())
  })
  app.get('/projects', async (c) => {
    try {
      return success(c, c.req.query('view') === 'summary' ? await store.listSummaries() : await store.list())
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.post('/projects', async (c) => {
    try {
      const body = await c.req.json()
      return created(c, await store.create(body.title, body.stylePreset))
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.get('/projects/:id', async (c) => {
    try {
      const id = c.req.param('id')
      if (c.req.query('view') === 'summary') {
        const summary = await store.summary(id)
        return success(c, await assetImages.refresh(id, summary) ? await store.summary(id) : summary)
      }
      const project = await store.get(id)
      const imagesChanged = await assetImages.refresh(id, project)
      const tasks = await refreshPendingVideos(id, undefined, true)
      return success(c, imagesChanged || tasks.length ? await store.get(id) : project)
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.get('/projects/:id/episodes/:episodeId', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      const id = c.req.param('id'), eid = c.req.param('episodeId')
      await refreshPendingVideos(id, eid, true)
      return success(c, await store.episode(id, eid))
    } catch (e) { return respondError(c, e) }
  })
  app.get('/projects/:id/episodes/:episodeId/activity', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      const id = c.req.param('id'), eid = c.req.param('episodeId')
      await refreshPendingVideos(id, eid, true)
      const activity = await store.activity(id, eid)
      const queuedCardIds = queue.list(id, eid).map(item => item.cardId)
      return success(c, { ...activity, queuedCardIds, activeCardIds: [...new Set([...activity.activeCardIds, ...queuedCardIds])] })
    } catch (e) { return respondError(c, e) }
  })
  app.patch('/projects/:id/changes', async c => {
    try {
      const body = await c.req.json().catch(() => null)
      const user = trustedSiteUser(c)
      if (body?.expectedUser !== undefined && body.expectedUser !== user)
        throw new ScriptVideoStoreError('当前账号已切换，请用原账号打开草稿', 403, 'DRAFT_ACCOUNT_CHANGED')
      return success(c, await store.applyChanges(c.req.param('id'), body, user))
    } catch (e) { return respondError(c, e) }
  })
  app.put('/projects/:id', async (c) => {
    try {
      const body = await c.req.json()
      return success(
        c,
        await store.update(
          c.req.param('id'),
          body.project,
          body.expectedRevision,
          scriptVideoSession(c.req.header(SESSION_HEADER)),
        ),
      )
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.patch('/projects/:id/episodes/:episodeId/assets/:assetId/voice', async (c) => {
    try {
      const body = await c.req.json().catch(() => null)
      const field = body?.field
      if ((field !== 'voiceAudio' && field !== 'voiceMode') || !Object.hasOwn(body, 'expected') || !Object.hasOwn(body, 'value'))
        throw new ScriptVideoStoreError('角色声音参数无效')
      return success(c, await store.updateCharacterVoice(
        c.req.param('id'), c.req.param('episodeId'), c.req.param('assetId'),
        scriptVideoSession(c.req.header(SESSION_HEADER)), field, body.expected, body.value,
      ))
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.delete('/projects/:id', async (c) => {
    try {
      const id = c.req.param('id')
      const session = scriptVideoSession(c.req.header(SESSION_HEADER))
      await refreshPendingVideos(id)
      await store.delete(id, session)
      return success(c, { id })
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.get('/projects/:id/episode-locks', async (c) => {
    try {
      c.header('Cache-Control', 'no-store')
      return success(c, await store.listEpisodeLeases(
        c.req.param('id'), scriptVideoSession(c.req.header(SESSION_HEADER)),
      ))
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.post('/projects/:id/episodes/:episodeId/lock', async (c) => {
    try {
      const body = await c.req.json().catch(() => null)
      return success(c, await store.acquireEpisodeLease(
        c.req.param('id'), c.req.param('episodeId'),
        scriptVideoSession(c.req.header(SESSION_HEADER)), body?.renew === true,
      ))
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.delete('/projects/:id/episodes/:episodeId/lock', async (c) => {
    try {
      await store.releaseEpisodeLease(
        c.req.param('id'), c.req.param('episodeId'), scriptVideoSession(c.req.header(SESSION_HEADER)),
      )
      return success(c)
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.get('/projects/:id/jobs', async (c) => {
    try {
      return success(c, await store.listJobs(c.req.param('id'), c.req.query('episodeId'), c.req.query('view') === 'restore'))
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.get('/projects/:id/jobs/:jobId', async (c) => {
    try {
      return success(
        c,
        await store.getJob(c.req.param('id'), c.req.param('jobId')),
      )
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.post('/projects/:id/jobs/:jobId/cancel', async (c) => {
    try {
      const job = await store.cancelTextJob(
        c.req.param('id'), c.req.param('jobId'), scriptVideoSession(c.req.header(SESSION_HEADER)),
      )
      if (job.status === 'canceled') aiJobControllers.get(job.id)?.abort()
      return success(c, job)
    } catch (e) {
      return respondError(c, e)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/cards/:cardId/reference-frames', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      const { id, episodeId, cardId } = c.req.param()
      const body = await c.req.json().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ScriptVideoStoreError('无效的选帧参数')
      const seek = Object.keys(body).length > 0
      if (seek && (!['tail', 'lighting'].includes(body.kind) || !validScriptVideoFrameTime(body.seconds) ||
          (body.kind === 'lighting' ? !Number.isSafeInteger(body.startShot) || body.startShot < 1 : body.startShot !== undefined) ||
          (body.expectedVideoUrl !== undefined && typeof body.expectedVideoUrl !== 'string') ||
          (body.sourceCardId !== undefined && (!validScriptVideoReferenceCardId(body.sourceCardId) ||
            !scriptVideoReferenceSourceUrl(body.expectedVideoUrl))) ||
          (body.sourceEpisodeId !== undefined && (!body.sourceCardId || !validScriptVideoReferenceCardId(body.sourceEpisodeId))) ||
          Object.keys(body).some(key => !['kind', 'startShot', 'seconds', 'expectedVideoUrl', 'sourceCardId', 'sourceEpisodeId'].includes(key)))) {
        throw new ScriptVideoStoreError('无效的参考帧或时间点')
      }
      // The wider catalogue is only for explicit selection. Automatic plans
      // still use the same adjacent card and current/previous episode jobs.
      const [{ jobs }, project] = await Promise.all([store.episodeSnapshot(id, episodeId, true), store.get(id)])
      const episode = episodeOf(project, episodeId)
      const card = episode.cards.find((item: ScriptVideoCard) => item.id === cardId)
      if (!card) throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
      const adjacent = previousScriptVideoCard(project, episodeId, cardId)
      const previous: ScriptVideoCard | undefined = adjacent?.card
      const previousEpisode = previousScriptVideoEpisode(project, episodeId, cardId)
      type SourceEntry = { card: ScriptVideoCard; index: number; episode: ScriptVideoProject['episodes'][number]; episodeIndex: number }
      const sourceCards: SourceEntry[] = project.episodes.flatMap((episode, episodeIndex) =>
        episode.cards.map((card: ScriptVideoCard, index: number) => ({ card, index, episode, episodeIndex })))
      const sourceLabel = (source: SourceEntry) => `第 ${source.episode.number ?? source.episodeIndex + 1} 集 · 第 ${source.index + 1} 段` +
        (source.card.title ? ' · ' + source.card.title : '')
      const sourceVersions = (source: SourceEntry) => [...new Set([
        officialScriptVideoUrl(source.card),
        selectScriptVideoPlayback(source.card, latestScriptVideoTaskUrls(source.episode.tasks).get(source.card.id))?.url,
        ...listScriptVideoVersions(source.card, source.episode.tasks).reverse().map(version => version.url),
      ].map(scriptVideoReferenceSourceUrl).filter((url): url is string => !!url))]
      const sourceInfo = (id: string | undefined, selectedUrl?: string, sourceEpisodeId?: string):
        Pick<ScriptVideoReferenceFrameRow, 'sourceLabel' | 'videoUrl' | 'sourceCardId' | 'sourceEpisodeId'> => {
        // Unqualified rows come from the original automatic context. Only
        // an explicit episode may resolve a source elsewhere in the project.
        const candidates = sourceCards.filter(source => source.card.id === id && (sourceEpisodeId
          ? source.episode.id === sourceEpisodeId : source.episode.id === episodeId || source.episode.id === adjacent?.episode.id))
        const normalizedUrl = scriptVideoReferenceSourceUrl(selectedUrl)
        const source = normalizedUrl ? candidates.find(source => sourceVersions(source).includes(normalizedUrl)) :
          candidates.find(source => source.episode.id === adjacent?.episode.id) ?? candidates[0]
        if (!source) return {}
        // While automatic selection waits for a remake, the existing take is
        // still a legitimate source for a new, explicit manual selection.
        const videoUrl = scriptVideoReferenceSourceUrl(selectedUrl ?? officialScriptVideoUrl(source.card))
        const segmentLabel = '第 ' + (source.index + 1) + ' 段'
        const label = sourceEpisodeId || source.episode.id !== episodeId && source.episode.id !== previousEpisode?.id
          ? sourceLabel(source) : source.episode.id === previousEpisode?.id ? '上一集 · ' + segmentLabel : segmentLabel
        return { sourceLabel: label, sourceCardId: source.card.id, sourceEpisodeId: source.episode.id, ...(videoUrl && { videoUrl }) }
      }
      // Playback also exposes completed historical renders when the inputs
      // changed during generation. Keep them available for explicit selection
      // without promoting them to the automatic continuation/light source.
      const readable = new Map<string, ReturnType<typeof resolveStoredVideo>>()
      const playableSource = async (options: ReturnType<typeof sourceInfo>[]) => {
        for (const option of options) {
          const url = option.videoUrl
          if (!url) continue
          let file = readable.get(url)
          if (!file) {
            file = resolveStoredVideo(url).catch(() => null)
            readable.set(url, file)
          }
          if (await file) return option
        }
      }
      const previousEntry = adjacent && sourceCards.find(source => source.episode.id === adjacent.episode.id && source.index === adjacent.index)
      const previousVersions = previousEntry ? sourceVersions(previousEntry).map(url => sourceInfo(previous!.id, url)) : []
      const withManualSource = async (source: ReturnType<typeof sourceInfo>, pending: boolean, exact = false) =>
        await playableSource(exact ? [source] : [source, ...previousVersions]) ?? (pending ? { sourceLabel: source.sourceLabel } : {})
      const queued = queuedReferenceCards(project, episodeId)
      const plans = planScriptVideoLighting(project, episodeId, jobs, queued)[cardId] || []
      const tailMode = card.referenceFrameSettings?.tail?.mode ?? 'auto'
      const tailSource = await continuationSource(project, jobs, episodeId, cardId, queued, true, tailMode === 'off')
      const selectedTail = typeof tailSource === 'object' ? tailSource : undefined
      const result: ScriptVideoReferenceFrames = { lighting: [] }
      const projectSources = await Promise.all(sourceCards.map(async source => {
        const info = await playableSource(sourceVersions(source).map(url => sourceInfo(source.card.id, url, source.episode.id)))
        if (info?.videoUrl) return { cardId: source.card.id, sourceEpisodeId: source.episode.id,
          videoUrl: info.videoUrl, sourceLabel: sourceLabel(source) }
      }))
      result.projectSources = projectSources.filter(source => source !== undefined)
      const currentIndex = sourceCards.findIndex(source => source.episode.id === episodeId && source.card.id === cardId)
      result.previousPlayableSource = projectSources.slice(0, currentIndex).reverse().find(source => source !== undefined)
      if (previousEpisode) {
        const sources = await Promise.all(previousEpisode.cards.map(async (card: ScriptVideoCard) => {
          const entry = sourceCards.find(source => source.episode.id === previousEpisode.id && source.card.id === card.id)!
          const info = await playableSource(sourceVersions(entry).map(url => sourceInfo(card.id, url)))
          if (info?.videoUrl && info.sourceLabel) return { cardId: card.id, videoUrl: info.videoUrl, sourceLabel: info.sourceLabel }
        }))
        result.previousEpisodeSources = sources.filter(source => source !== undefined)
      }
      const fallbackChoice = card.referenceFrameSettings?.lighting?.['1']
      type EditablePlan = Pick<(typeof plans)[number], 'range' | 'choice' | 'source' | 'automaticSource' | 'pendingCardId' | 'automaticPendingCardId'>
      const editablePlans: EditablePlan[] = plans.length ? plans : [{
        range: fallbackScriptVideoLightingRange(card.shots?.length ?? 0),
        ...(fallbackChoice?.mode === 'off' && { choice: fallbackChoice }),
      }]
      for (const plan of editablePlans) {
        const { startShot, endShot, sceneName } = plan.range
        const mode = plan.choice?.mode ?? 'auto'
        const source = mode === 'off' ? plan.automaticSource : plan.source
        const pendingId = mode === 'off' ? plan.automaticPendingCardId : plan.pendingCardId
        const exact = plan.choice?.mode === 'manual' && !!plan.choice.sourceCardId
        const info = await withManualSource(sourceInfo(source?.cardId ?? pendingId, source?.videoUrl, source?.sourceEpisodeId), !!pendingId, exact)
        result.lighting.push({ kind: 'lighting', startShot, ...(card.shots?.length && { endShot }), sceneName, mode,
          state: mode === 'off' ? 'off' : pendingId ? 'pending' : 'missing',
          ...info, ...(source?.manualSeconds !== undefined && info.videoUrl === source.videoUrl && { seconds: source.manualSeconds }) })
      }
      const tailInfo = await withManualSource(
        sourceInfo(selectedTail?.previousCardId ?? (tailSource === 'pending' ? previous?.id : undefined), selectedTail?.videoUrl, selectedTail?.sourceEpisodeId), tailSource === 'pending',
        tailMode === 'manual' && card.referenceFrameSettings?.tail?.mode === 'manual' && !!card.referenceFrameSettings.tail.sourceCardId,
      )
      result.tail = { kind: 'tail', mode: tailMode,
        state: tailMode === 'off' ? 'off' : tailSource === 'pending' ? 'pending' : 'missing',
        ...tailInfo, ...(selectedTail?.manualSeconds !== undefined && tailInfo.videoUrl === selectedTail.videoUrl && { seconds: selectedTail.manualSeconds }) }
      if (seek) {
        const row: ScriptVideoReferenceFrameRow | undefined = body.kind === 'tail' ? result.tail :
          result.lighting.find(range => range.startShot === body.startShot)
        const explicit = body.sourceCardId !== undefined
        const listed = result.projectSources?.find(source => source.cardId === body.sourceCardId && source.videoUrl === body.expectedVideoUrl &&
          (body.sourceEpisodeId === undefined || source.sourceEpisodeId === body.sourceEpisodeId))
        const saved = row?.mode === 'manual' && row.sourceCardId === body.sourceCardId &&
          (body.sourceEpisodeId === undefined || row.sourceEpisodeId === body.sourceEpisodeId) ? row.videoUrl : undefined
        const videoUrl = explicit ? [listed?.videoUrl, saved].find(url => url === body.expectedVideoUrl) : row?.videoUrl
        if (body.expectedVideoUrl !== undefined && videoUrl !== body.expectedVideoUrl) {
          throw new ScriptVideoStoreError('参考来源成片已更新，请重新打开选帧。', 409, 'REFERENCE_FRAME_SOURCE_CHANGED')
        }
        const owner = videoUrl && previousScriptVideoRender(project, episodeId, cardId, videoUrl, body.sourceCardId, body.sourceEpisodeId)
        if (!row || !videoUrl || !owner) {
          throw new ScriptVideoStoreError('没有可用的来源成片', 422, 'REFERENCE_FRAME_UNAVAILABLE')
        }
        const seconds = Number(body.seconds.toFixed(3))
        const imageUrl = await extractVideoReferenceFrame(videoUrl, seconds)
        if (!imageUrl) throw new ScriptVideoStoreError('来源视频在该时间点没有可读取的帧', 422, 'REFERENCE_FRAME_TIME')
        result.candidate = { imageUrl, videoUrl, seconds, ...(explicit && { sourceCardId: body.sourceCardId,
          ...(body.sourceEpisodeId && { sourceEpisodeId: body.sourceEpisodeId }) }) }
      }
      const [prepared, tailImage] = await Promise.all([
        prepareScriptVideoLighting(plans),
        tailMode !== 'off' && selectedTail ? scriptVideoOpeningImage(selectedTail).catch(() => null) : undefined,
      ])
      for (const range of prepared.ranges) {
        if (!range.imageUrl) continue
        const row = result.lighting.find(item => item.startShot === range.startShot)
        if (row) { row.imageUrl = range.imageUrl; row.state = 'ready' }
      }
      if (result.tail && tailImage) { result.tail.imageUrl = tailImage; result.tail.state = 'ready' }
      return success(c, result)
    } catch (error) { return respondError(c, error) }
  })

  app.post('/projects/:id/episodes/:episodeId/final-prompt', async (c) => {
    try {
      c.header('Cache-Control', 'no-store')
      const id = c.req.param('id'), episodeId = c.req.param('episodeId')
      const body = await c.req.json().catch(() => null)
      if (typeof body?.cardId !== 'string' || !body.cardId) {
        throw new ScriptVideoStoreError('无效的分镜')
      }
      const promptMode = readVideoPromptMode(body.promptMode)
      if (body.jobId !== undefined) {
        if (typeof body.jobId !== 'string' || !body.jobId) throw new ScriptVideoStoreError('无效的视频任务')
        const { project, jobs } = await store.episodeSnapshot(id, episodeId)
        const episode = episodeOf(project, episodeId)
        const job = jobs.find(item => item.id === body.jobId && item.projectId === id && item.episodeId === episodeId &&
          item.cardId === body.cardId && item.action === 'video')
        if (!job) throw new ScriptVideoStoreError('视频任务不属于本段', 404, 'NOT_FOUND')
        const task = episode.tasks?.find((item: any) => item.id === job.id && item.taskId === job.taskId)
        const result = job.taskId && getScriptVideoSubmissionPrompt(job.taskId, project.assets,
          job.videoReferenceNames, task?.continuation, task?.lightingRanges,
          episode.production?.stylePreset || project.settings?.stylePreset)
        if (!result) throw new ScriptVideoStoreError('该任务暂无可查看的提交提示词', 404, 'VIDEO_PROMPT_UNAVAILABLE')
        return success(c, result)
      }
      const hasSelection = body.configId != null || body.model != null
      if (!Number.isSafeInteger(body.cardVersion) || hasSelection &&
          (!Number.isSafeInteger(body.configId) || body.configId <= 0 || typeof body.model !== 'string' || !body.model.trim() ||
          typeof body.aspectRatio !== 'string' || typeof body.resolution !== 'string')) {
        throw new ScriptVideoStoreError('视频模型配置或分镜版本无效')
      }
      if (body.duration !== undefined && !isScriptVideoGenerationDuration(body.duration)) {
        throw new ScriptVideoStoreError('生成时长须为 1–30 的整数秒')
      }
      const { project, jobs } = await store.episodeSnapshot(id, episodeId, true)
      const episode = episodeOf(project, episodeId)
      const card = episode.cards.find((item: any) => item.id === body.cardId)
      if (!card) throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
      if (card.version !== body.cardVersion) throw new ScriptVideoStoreError('分镜已更新，请刷新后重试', 409, 'CONFLICT')
      const stylePreset = episode.production?.stylePreset || project.settings?.stylePreset
      if (card.manuallyAdded) {
        if (!hasScriptVideoPromptBody(card.prompt, stylePreset)) throw new ScriptVideoStoreError('请先输入本段视频提示词', 422, 'PROMPT_REQUIRED')
      } else {
        requireSynchronized([card])
        if (!card.prompt?.trim() || !Array.isArray(card.shots) || !card.shots.length)
          throw new ScriptVideoStoreError('请先生成本段提示词和分镜脚本', 422, 'STORYBOARD_REQUIRED')
      }
      const cast = episode.production?.characters
      const warnings = new Set<string>()
      if (hasSelection) {
        requireConfirmed(episode, 'revisions')
        if (!card.manuallyAdded) {
          try {
            dependencies.assertScriptVideoFormal({ production: episode.production, script: episode.confirmedScript,
              assets: project.assets, cards: [card], scope: 'card' })
          } catch (error) {
            if (!(error instanceof ScriptVideoAIError)) throw error
            for (const message of error.issues.length ? error.issues.map(issue => issue.message) : [error.message]) warnings.add(message)
          }
        }
      }
      const queued = queuedReferenceCards(project, episodeId)
      const lightingPlan = planScriptVideoLighting(project, episodeId, jobs, queued)[card.id] || []
      const source = await continuationSource(project, jobs, episodeId, card.id, queued, true)
      const tailChoice = card.referenceFrameSettings?.tail
      if (!source && tailChoice?.mode === 'manual' && tailChoice.sourceCardId)
        warnings.add('手选尾帧的来源成片已不可用，请重新选帧。')
      const input = { card, assets: project.assets, cast, stylePreset }
      const continuationSourceForPreview = typeof source === 'string' ? undefined : source
      const pending = source === 'pending' ? '上一段成片仍在生成，出片后将自动补入尾帧。'
        : source === 'missing' ? '先生成上一段视频，系统会自动补入成片尾帧。'
          : lightingPlan.some(range => range.pendingCardId) ? '同场上一段正在制作，出片后将自动补入光线参考图。' : undefined
      try {
        const lighting = await prepareScriptVideoLighting(lightingPlan)
        for (const warning of lighting.warnings) warnings.add(warning)
        const result = await previewScriptVideoPrompt({ ...input, projectId: id, episodeId,
          selection: hasSelection ? { configId: body.configId, model: body.model, aspectRatio: body.aspectRatio, resolution: body.resolution } : undefined,
          duration: body.duration,
          promptMode,
          continuationSource: continuationSourceForPreview,
          lightingRanges: lighting.ranges.map(({ source, sceneKey, ...range }) => range),
        })
        for (const warning of result.warnings ?? []) warnings.add(warning)
        return success(c, { ...result, ...(warnings.size && { warnings: [...warnings] }), ...(pending && { pending }) })
      } catch (error) {
        throw new ScriptVideoStoreError(safeTaskError(error), 422, 'VIDEO_PROMPT_PREVIEW')
      }
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/continuations', async (c) => {
    try {
      const { cardIds, configId, model, promptMode: requestedPromptMode } = await c.req.json()
      const promptMode = readVideoPromptMode(requestedPromptMode)
      const hasSelection = configId !== undefined || model !== undefined
      if (!Array.isArray(cardIds) || cardIds.some(cardId => typeof cardId !== 'string') ||
          hasSelection && (!Number.isSafeInteger(configId) || configId <= 0 || typeof model !== 'string' || !model.trim())) {
        throw new ScriptVideoStoreError('视频模型配置或分镜无效')
      }
      const id = c.req.param('id'), episodeId = c.req.param('episodeId')
      const { project, jobs } = await store.episodeSnapshot(id, episodeId, true)
      const episode = episodeOf(project, episodeId)
      const queued = queuedReferenceCards(project, episodeId)
      const lightingPlans = Object.entries(planScriptVideoLighting(project, episodeId, jobs, queued))
        .filter(([cardId]) => cardIds.includes(cardId))
      const inputs = await Promise.all(episode.cards.filter((card: ScriptVideoCard) => cardIds.includes(card.id))
        .map(async (card: ScriptVideoCard) => {
          const source = await continuationSource(project, jobs, episodeId, card.id, queued)
          return { card, source: source && typeof source !== 'string' ? source : undefined }
        }))
      const options = { configId, model, promptMode, cast: episode.production?.characters,
        stylePreset: episode.production?.stylePreset || project.settings?.stylePreset }
      try {
        const lightingRanges = Object.create(null)
        for (const [cardId, plans] of lightingPlans) {
          const prepared = await prepareScriptVideoLighting(plans)
          if (prepared.warnings.length) throw new ScriptVideoStoreError(prepared.warnings[0], 422, 'REFERENCE_FRAME_UNAVAILABLE')
          lightingRanges[cardId] = prepared.ranges.map(({ source, sceneKey, ...range }) => range)
        }
        return success(c, await prepareScriptVideoDeliveryReferences(inputs, project.assets, options, lightingRanges))
      } catch (error) {
        throw new ScriptVideoStoreError(error instanceof Error ? error.message : '上一段尾帧准备失败', 422, 'CONTINUATION_FRAME')
      }
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/validate', async (c) => {
    try {
      const { project } = await store.episodeSnapshot(c.req.param('id'), c.req.param('episodeId'))
      const episode = episodeOf(project, c.req.param('episodeId'))
      requireConfirmed(episode, 'revisions')
      const body = await c.req.json()
      const promptMode = readVideoPromptMode(body.promptMode)
      if (
        body.expectedRevision !== undefined &&
        body.expectedRevision !== project.revision
      )
        throw new ScriptVideoStoreError(
          '项目已更新，请刷新后重试',
          409,
          'CONFLICT',
        )
      if (body.cardIds === undefined) {
        requireSynchronized(episode.cards)
        dependencies.assertScriptVideoFormal({
          production: episode.production,
          script: episode.confirmedScript,
          assets: project.assets,
          cards: episode.cards,
          scope: 'episode',
        })
      } else {
        if (
          !Array.isArray(body.cardIds) ||
          !body.cardIds.length ||
          new Set(body.cardIds).size !== body.cardIds.length
        )
          throw new ScriptVideoStoreError('请选择要校验的分镜')
        for (const id of body.cardIds) {
          const card = episode.cards.find((item: any) => item.id === id)
          if (!card)
            throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
          requireSynchronized([card])
          dependencies.assertScriptVideoFormal({
            production: episode.production,
            script: episode.confirmedScript,
            assets: project.assets,
            cards: [card],
            scope: 'card',
          })
        }
      }
      const selectedCards = body.cardIds
        ? episode.cards.filter((card: ScriptVideoCard) => body.cardIds.includes(card.id))
        : episode.cards
      const warnings = getScriptVideoContentWarnings({
        production: episode.production, script: episode.confirmedScript,
        assets: project.assets, cards: selectedCards, scope: body.cardIds ? 'card' : 'episode',
      })
      if (body.prepareReferenceImages && (!episode.modelName || isSeedance25Model(episode.modelName))) {
        const selected = body.cardIds && new Set<string>(body.cardIds)
        const cards = selected ? episode.cards.filter((card: { id: string }) => selected.has(card.id)) : episode.cards
        try {
          const referenceImages = await prepareScriptVideoArchiveImages(cards, project.assets, {
            model: episode.modelName, provider: episode.modelProvider, promptMode, cast: episode.production?.characters,
            stylePreset: episode.production?.stylePreset || project.settings?.stylePreset,
          }, episode.resolution || '480p')
          return success(c, { ok: true, warnings, referenceImages })
        } catch (error) {
          throw new ScriptVideoStoreError(error instanceof Error ? error.message : '交付参考图准备失败', 422, 'REFERENCE_IMAGE')
        }
      }
      return success(c, { ok: true, warnings })
    } catch (e) {
      return respondError(c, e)
    }
  })
  app.post(
    '/projects/:id/episodes/:episodeId/:action{outline|storyboard|revisions|review}',
    async (c) => {
      try {
        const id = c.req.param('id'),
          episodeId = c.req.param('episodeId'),
          action = c.req.param('action') as Action
        const session = scriptVideoSession(c.req.header(SESSION_HEADER))
        const body = await c.req.json()
        const storyboardMode = action === 'storyboard'
          ? body.storyboardMode ?? DEFAULT_SCRIPT_VIDEO_STORYBOARD_MODE
          : undefined
        if (storyboardMode !== undefined && !isScriptVideoStoryboardMode(storyboardMode))
          throw new ScriptVideoStoreError('分镜模式无效，请选择修仙分镜或原有分镜')
        if (
          action === 'revisions' &&
          (typeof body.cardId !== 'string' ||
            typeof body.instruction !== 'string' ||
            !body.instruction.trim() ||
            body.instruction.length > 10000)
        )
          throw new ScriptVideoStoreError(
            '请选择分镜并填写修改意见（最多 10000 字符）',
          )
        if (
          action === 'revisions' &&
          body.sourcePrompt !== undefined &&
          (typeof body.sourcePrompt !== 'string' ||
            !body.sourcePrompt.trim() ||
            body.sourcePrompt.length > 50000)
        )
          throw new ScriptVideoStoreError(
            '待调整提示词不能为空且不能超过 50000 字符',
          )
        const prepared = await store.mutateEpisode(id, episodeId, (record) => {
          const ep = episodeOf(record.project, episodeId)

          requireConfirmed(ep, action)
          const autoSelectCharacterBases = body.autoSelectCharacterBases ?? record.project.settings?.autoSelectCharacterBases
          if (autoSelectCharacterBases !== undefined && (!Array.isArray(autoSelectCharacterBases) || autoSelectCharacterBases.length >= 100 || autoSelectCharacterBases.some((name: unknown) => typeof name !== 'string' || !name.trim() || name.length > 100)))
            throw new ScriptVideoStoreError('允许模型选择造型的人物名单无效')
          if (
            record.jobs.some(
              (item) =>
                item.episodeId === episodeId &&
                item.action !== 'video' &&
                (item.status === 'queued' || item.status === 'running'),
            )
          )
            throw new ScriptVideoStoreError(
              '该分集已有文字生成任务正在执行，请等待完成',
              409,
              'AI_ACTIVE',
            )
          const base = digest(record.project, episodeId, action, body.cardId)
          const resumeKey = storyboardMode ? storyboardResumeKey(record.project, episodeId, body, storyboardMode) : undefined
          const resumable = resumeKey ? record.jobs.slice().reverse().filter(item =>
            item.action === 'storyboard' && item.episodeId === episodeId && item.resumeKey &&
            (item.status === 'canceled' || (item.status === 'failed' && item.checkpoint))) : []
          // Existing unfinished checkpoints used the full unprojected text digest.
          const legacyKey = storyboardMode === 'original' && resumable.length
            ? storyboardResumeKey(record.project, episodeId, body, storyboardMode, true) : undefined
          const lastResume = resumable.find(item => item.resumeKey === resumeKey || item.resumeKey === legacyKey)
          const previous = lastResume?.status === 'failed' ? lastResume : undefined
          const retryCurrentSegment = previous?.code === 'STORYBOARD_REPAIRS_EXHAUSTED' &&
            previous.progress?.batchSize === 1 &&
            (body.retryCurrentSegment === true || body.restartAfterRepairs === true)
          if (action === 'storyboard' && body.resumeFromJobId !== undefined &&
              (!previous || previous.id !== body.resumeFromJobId ||
                (previous.code === 'STORYBOARD_REPAIRS_EXHAUSTED' && !retryCurrentSegment))) {
            throw new ScriptVideoStoreError('当前剧本、大纲或设置已变化，原任务无法续写。请确认后重新生成整集。', 409, 'RESUME_MISMATCH')
          }
          if (body.retryCurrentSegment === true && !retryCurrentSegment)
            throw new ScriptVideoStoreError('当前没有可继续修复的失败片段，请刷新任务状态。', 409, 'RESUME_MISMATCH')
          const freshAfterFailure = previous?.code === 'STORYBOARD_REPAIRS_EXHAUSTED' &&
            body.restartAfterRepairs === true && !retryCurrentSegment
          const checkpoint = previous?.checkpoint && !freshAfterFailure ? structuredClone(previous.checkpoint) : undefined
          if (checkpoint && retryCurrentSegment) {
            // Explicitly retry only the pending segment, retaining all accepted cards
            // and its candidate. Ordinary interruption/resume keeps the used budget.
            checkpoint.segmentRepairAttempts = 0
            delete checkpoint.repairCardId
            checkpoint.repairFeedback = []
          }
          const now = new Date().toISOString()
          const job: ScriptVideoJob = {
            id: `job-${randomUUID()}`,
            projectId: id,
            episodeId,
            action,
            status: 'queued',
            ...(action === 'revisions' ? { cardId: body.cardId } : {}),
            createdAt: now,
            updatedAt: now,
            ...(storyboardMode && { storyboardMode }),
            ...(resumeKey ? {
              resumeKey,
              ...(checkpoint ? { checkpoint } : {}),
              progress: checkpoint && previous?.progress
                ? { ...structuredClone(previous.progress), ...(retryCurrentSegment && { segmentRepairAttempts: 0 }) }
                : { phase: 'generating' as const, completed: 0, total: ep.cards.length },
            } : {}),
          }
          record.jobs.push(job)
          return {
            result: { job, project: structuredClone(record.project), base },
          }
        })
        const controller = new AbortController()
        aiJobControllers.set(prepared.job.id, controller)
        void runAIJob(
          prepared.job,
          prepared.project,
          prepared.base,
          body,
          controller.signal,
        ).finally(() => aiJobControllers.delete(prepared.job.id)).catch(() => {})
        return created(c, publicScriptVideoJob(prepared.job))
      } catch (e) {
        return respondError(c, e)
      }
    },
  )
  async function runAIJob(
    job: ScriptVideoJob,
    project: ScriptVideoProject,
    base: string,
    body: any,
    signal: AbortSignal,
  ) {
    try {
      const started = await store.mutateEpisode(job.projectId, job.episodeId, (record) => {
        const current = record.jobs.find((item) => item.id === job.id)
        if (current?.status !== 'queued') return { result: false, recordChanged: false }
        current.status = 'running'
        current.updatedAt = new Date().toISOString()
        return { result: true }
      })
      if (!started || signal.aborted) return
      const ep = episodeOf(project, job.episodeId)
      const videoModel = ep.modelKey === '' ? (await getActiveConfig('video'))?.model ?? ep.modelName : ep.modelName
      const input: ScriptVideoInput = {
        projectTitle: project.title,
        episodeNumber: ep.number,
        script: ep.confirmedScript,
        assets: project.assets,
        signal,
        configId: body.configId ?? ep.textConfigId,
        model: body.model ?? ep.textModel,
        production: ep.production,
        stylePreset: job.action === 'revisions' || job.action === 'review' ? ep.production?.stylePreset : project.settings?.stylePreset,
        deliverySpecs: { aspectRatio: ep.aspectRatio, resolution: ep.resolution, videoModel },
        systemPrompt: body.systemPrompt ?? project.settings?.systemPrompt,
        storyboardMode: job.storyboardMode,
        combatEnabled: body.combatEnabled ?? project.settings?.combatEnabled,
        autoSelectCharacterBases: body.autoSelectCharacterBases ?? project.settings?.autoSelectCharacterBases,
        characterAppearanceNotes: ep.characterAppearanceNotes,
      }
      const result =
        job.action === 'outline'
          ? await dependencies.generateScriptVideoOutline(input)
          : job.action === 'storyboard'
            ? await dependencies.generateScriptVideoCards({
                ...input,
                outline: ep.cards,
              }, undefined, {
                batchSize: await storyboardBatchSize(input.configId, job),
                checkpoint: job.checkpoint,
                onProgress: async (progress, checkpoint) => {
                  signal.throwIfAborted()
                await store.mutateEpisode(job.projectId, job.episodeId, (record) => {
                    const current = record.jobs.find(item => item.id === job.id)
                  if (!current || current.status !== 'running')
                    throw new ScriptVideoStoreError('文字任务已停止', 409, 'CANCELED')
                  // Keep the original snapshot's checkpoint. The completion check
                  // below preserves newer edits and stores outdated output on the job.
                    current.progress = structuredClone(progress)
                    current.checkpoint = structuredClone(checkpoint)
                    current.updatedAt = new Date().toISOString()
                    return { result: null }
                  })
                },
              })
            : job.action === 'review'
              ? await dependencies.reviewScriptVideoEpisode({ ...input, cards: ep.cards, production: ep.production })
              : await dependencies.reviseScriptVideoCard({
                ...input,
                card: {
                  ...ep.cards.find((item: any) => item.id === body.cardId),
                  ...(body.sourcePrompt !== undefined
                    ? { prompt: body.sourcePrompt }
                    : {}),
                },
                previousCard:
                  ep.cards[
                    ep.cards.findIndex((item: any) => item.id === body.cardId) -
                      1
                  ],
                instruction: body.instruction.trim(),
              })
      await store.mutateEpisode(job.projectId, job.episodeId, (record) => {
        const current = record.jobs.find((item) => item.id === job.id)
        if (current?.status !== 'running' || signal.aborted) return { result: null, recordChanged: false }
        const target = episodeOf(record.project, job.episodeId)
        const removedTarget = job.action === 'revisions' && !target.cards.some((card: { id: string }) => card.id === body.cardId)
        let removesPendingCard = false
        if (job.action === 'outline' || job.action === 'storyboard') {
          const proposed = new Set((result as { cards: {id:string}[] }).cards.map(card => card.id))
          // Submitted renders retain their own task record through a re-outline.
          // A browser-owned batch reservation still needs the card to exist.
          removesPendingCard = queue.list(job.projectId, job.episodeId).some(item => !proposed.has(item.cardId))
        }
        if (
          removedTarget || removesPendingCard || digest(record.project, job.episodeId, job.action as Action, body.cardId) !== base
          || (job.action === 'storyboard' && job.resumeKey !== storyboardResumeKey(record.project, job.episodeId, body, job.storyboardMode ?? DEFAULT_SCRIPT_VIDEO_STORYBOARD_MODE))
        ) {
          current.status = 'failed'
          current.code = 'STALE'
          current.staleResult = true
          current.result = result
          current.error = removesPendingCard ? '编排结果会移除等待生成的分镜，本次结果已保留' : '输入已更新，本次结果已保留，可在任务中查看'
          current.updatedAt = new Date().toISOString()
          return { result: null }
        }
        if (job.action === 'review') {
          const report = result as Awaited<ReturnType<typeof reviewScriptVideoEpisode>>
          current.result = {
            ...report,
            issues: report.issues.map(issue => ({
              ...issue,
              segmentNumber: ep.cards.findIndex((card: any) => card.id === issue.cardId) + 1,
            })),
          }
        } else if (job.action === 'revisions') {
          current.result = {
            ...result,
            card: { ...(result as any).card, promptNeedsSync: false },
            baseCardVersion: ep.cards.find(
              (item: any) => item.id === body.cardId,
            )?.version,
          }
        } else {
          const cards = (result as { cards: any[] }).cards
          const retimed = job.action === 'storyboard' && (
            cards.length !== target.cards.length ||
            cards.some((card, i) => card.id !== target.cards[i]?.id || card.duration !== target.cards[i]?.duration)
          )
          if (job.action === 'outline' || retimed) assertOutlineDurationPolicy(cards)
          // Keep the complete previously produced storyboard (including prompt
          // history and video references) before replacing it with AI output.
          if (job.action === 'storyboard' && !(result as any).production) throw new ScriptVideoStoreError('正式分镜缺少制作规格和人物声音', 422, 'PRODUCTION_MISSING')
          if (job.action === 'storyboard') dependencies.assertScriptVideoFormal({ script: target.confirmedScript, assets: record.project.assets, cards, production: (result as any).production })
          if (target.production || target.cards.some((card: any) => Array.isArray(card.shots) && card.shots.length && typeof card.prompt === 'string' && card.prompt.trim())) {
            target.generationsHistory ||= []
            target.generationsHistory.push({ id: `generation-${randomUUID()}`, createdAt: new Date().toISOString(), sourceRevision: record.project.revision, sourceScript: target.confirmedScript, production: structuredClone(target.production), cards: structuredClone(target.cards) })
          }
          target.cards = cards.map((card) => {
            const previous = target.cards.find(
              (item: any) => item.id === card.id,
            )
            const { manuallyAdded: _manualOrigin, referenceFrameSettings: _snapshotFrames, ...generated } = card
            const videoVersions = previous ? listScriptVideoVersions(previous) : []
            return {
              ...generated,
              ...(previous?.referenceFrameSettings && { referenceFrameSettings: previous.referenceFrameSettings }),
              promptNeedsSync: false,
              videoUrl: retimed && (previous?.duration !== card.duration || previous?.prompt !== card.prompt)
                ? undefined : previous?.videoUrl,
              ...(videoVersions.length && { videoVersions }),
              status: 'draft',
              version: previous ? (Number(previous.version) || 0) + 1 : 1,
            }
          })
          target.selectedCardId = target.cards[0]?.id || ''
          if (job.action === 'outline') {
            target.outlineDurationPolicy = OUTLINE_DURATION_POLICY
            target.outlineConfirmed = false
            target.stage = 'outline'
            delete target.production
          } else {
            target.production = structuredClone((result as any).production)
            target.stage = 'production'
            if (retimed) target.outlineDurationPolicy = OUTLINE_DURATION_POLICY
            current.progress = { phase: 'validating', completed: cards.length, total: cards.length, repairAttempts: current.progress?.repairAttempts || 0 }
          }
          current.result = {
            skillReads: (result as any).skillReads,
            attempts: (result as any).attempts,
            warnings: (result as any).warnings ?? [],
            ...(retimed ? { timing: {
              segments: cards.length,
              seconds: Number(cards.reduce((sum, card) => sum + card.duration, 0).toFixed(3)),
            } } : {}),
          }
        }
        current.status = 'completed'
        delete current.checkpoint
        current.updatedAt = new Date().toISOString()
        return { result: null, documentChanged: job.action === 'outline' || job.action === 'storyboard' }
      })
    } catch (error) {
      if (signal.aborted) return
      const info = errorInfo(error)
      await store
        .mutateEpisode(job.projectId, job.episodeId, (record) => {
          const current = record.jobs.find((item) => item.id === job.id)
          if (current?.status !== 'running' && current?.status !== 'queued') return { result: null, recordChanged: false }
          current.status = 'failed'
          current.error = info.message
          current.code = info.code
          current.issues = info.issues
          current.updatedAt = new Date().toISOString()
          return { result: null }
        })
        .catch(() => {})
    }
  }
  // The reservation is persisted before calling a provider. An interrupted submission
  // with no task ID is ambiguous and cannot be silently retried.
  app.post('/projects/:id/episodes/:episodeId/cards/:cardId/video',
    async (c) => {
      let job: ScriptVideoJob | undefined
      let releaseSubmission: (() => void) | undefined
      let registeredVideoJob: string | undefined
      const submission: { controller: AbortController; taskId?: number } = { controller: new AbortController() }
      try {
        const id = c.req.param('id'),
          episodeId = c.req.param('episodeId'),
          cardId = c.req.param('cardId')
        const body = await c.req.json()
        if (
          !Number.isSafeInteger(body.expectedCardVersion) ||
          !Number.isSafeInteger(body.configId) ||
          body.configId <= 0 ||
          typeof body.model !== 'string' ||
          !body.model.trim() ||
          typeof body.aspectRatio !== 'string' ||
          typeof body.resolution !== 'string'
        )
          throw new ScriptVideoStoreError('视频模型配置或分镜版本无效')
        if (body.duration !== undefined && !isScriptVideoGenerationDuration(body.duration)) {
          throw new ScriptVideoStoreError('生成时长须为 1–30 的整数秒')
        }
        const promptMode = readVideoPromptMode(body.promptMode) ?? getVideoPromptMode()
        const configs = schema.aiServiceConfigs
        const config = db.select({ provider: configs.provider, videoCliAccountId: configs.videoCliAccountId })
          .from(configs).where(eq(configs.id, body.configId)).get()
        if (config?.provider === 'jimeng') {
          try { requireJimengPrivateAccess(c) }
          catch (error) { throw new ScriptVideoStoreError((error as Error).message, 403, 'FORBIDDEN') }
        }
        const videoCliAccountId = config?.provider === 'jimeng' || config?.provider === 'libtv'
          ? resolveVideoCliAccountId(config.provider, config.videoCliAccountId ?? undefined) : undefined
        releaseSubmission = holdVideoCliSubmission(config?.provider, videoCliAccountId)
        const session = scriptVideoSession(c.req.header(SESSION_HEADER))
        if (body.requestId !== undefined && !isVideoRequestId(body.requestId))
          throw new ScriptVideoStoreError('视频请求标识无效')
        let snapshot = await store.episodeSnapshot(id, episodeId, true)
        const active = (job: ScriptVideoJob) => job.action === 'video' && job.episodeId === episodeId && job.cardId === cardId &&
          (job.status === 'queued' || job.status === 'running')
        const rejectActive = () => new ScriptVideoStoreError('此分镜已有视频任务正在提交或处理中', 409, 'VIDEO_ACTIVE')
        queue.assertCanSubmit(id, episodeId, cardId, session, body.requestId)
        if (snapshot.jobs.some(active)) throw rejectActive()
        snapshot = await refreshVideoReferenceSources(snapshot, episodeId, cardId)
        const queued = queuedReferenceCards(snapshot.project, episodeId, session, body.requestId)
        // File and task lookups can wait outside the write queue. Recheck the
        // episode and reservations at commit before handing anything to a provider.
        const [source, rejected] = await Promise.all([
          continuationSource(snapshot.project, snapshot.jobs, episodeId, cardId, queued),
          Promise.all(snapshot.jobs.filter(job => job.episodeId === episodeId && job.cardId === cardId && job.status === 'failed' &&
            job.code === 'SUBMISSION_UNKNOWN' && job.taskId).map(async job => ({
              job, state: await dependencies.getScriptVideoGeneration(job.taskId!).catch(() => null),
            }))),
        ])
        const prepared = await store.mutateEpisode<Pick<ScriptVideoGenerationInput, 'card' | 'assets' | 'cast' | 'stylePreset' | 'continuationSource'> & {
          job: ScriptVideoJob
          lightingPlan: ReturnType<typeof planScriptVideoLighting>[string]
        }>(id, episodeId, (record) => {
          const episode = episodeOf(record.project, episodeId)

          queue.assertCanSubmit(id, episodeId, cardId, session, body.requestId)
          if (body.requestId && (canceledVideoRequests.get(videoRequestKey(id, episodeId, session, body.requestId)) || 0) > Date.now()) {
            throw new ScriptVideoStoreError('视频生成已取消', 409, 'CANCELED')
          }
          if (record.jobs.some(active)) throw rejectActive()
          if (record.episodeRevision !== snapshot.episodeRevision)
            throw new ScriptVideoStoreError('分集刚刚更新，请重试生成', 409, 'CONFLICT')
          const prior = previousScriptVideoCard(record.project, episodeId, cardId)
          const snapshotPrior = previousScriptVideoCard(snapshot.project, episodeId, cardId)
          if (prior?.episode.id !== snapshotPrior?.episode.id || prior?.episode.id !== episodeId &&
              JSON.stringify(prior?.episode) !== JSON.stringify(snapshotPrior?.episode)) {
            throw new ScriptVideoStoreError('上一集刚刚更新，请重试生成', 409, 'CONFLICT')
          }
          requireConfirmed(episode, 'revisions')
          const card = episode.cards.find((item: any) => item.id === cardId)
          if (!card)
            throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
          if (card.version !== body.expectedCardVersion)
            throw new ScriptVideoStoreError(
              '分镜已更新，请刷新后重试',
              409,
              'CONFLICT',
            )
          const manualTail = card.referenceFrameSettings?.tail
          if (manualTail?.mode === 'manual' && manualTail.sourceCardId &&
              !previousScriptVideoRender(record.project, episodeId, cardId, manualTail.videoUrl,
                manualTail.sourceCardId, manualTail.sourceEpisodeId)) {
            throw new ScriptVideoStoreError('手选尾帧的来源成片已不可用，请重新选帧。', 422, 'REFERENCE_FRAME_UNAVAILABLE')
          }
          const cast = episode.production?.characters
          const stylePreset = episode.production?.stylePreset || record.project.settings?.stylePreset
          if (card.manuallyAdded) {
            if (!hasScriptVideoPromptBody(card.prompt, stylePreset)) throw new ScriptVideoStoreError('请先输入本段视频提示词', 422, 'PROMPT_REQUIRED')
          } else {
            requireSynchronized([card])
            const missingVoices = getScriptVideoMissingVoices(card, record.project.assets, { cast, stylePreset, promptMode })
            if (missingVoices.length)
              throw new ScriptVideoStoreError(scriptVideoMissingVoicesMessage(missingVoices), 422, 'VOICE_REFERENCE_REQUIRED')
            dependencies.assertScriptVideoFormal({
              production: episode.production,
              script: episode.confirmedScript,
              assets: record.project.assets,
              cards: [card],
              scope: 'card',
            })
          }
          const previous = record.jobs.filter(
            (item) =>
              item.action === 'video' &&
              item.episodeId === episodeId &&
              item.cardId === cardId,
          )
          for (const { job, state } of rejected) {
            const current = previous.find(item => item.id === job.id && item.updatedAt === job.updatedAt)
            if (current) reconcileRejectedVideoSubmission(episode, current, state)
          }
          const uncertain = previous.find(
            (item) =>
              item.code === 'SUBMISSION_UNKNOWN' ||
              item.code === 'DELIVERY_FAILED',
          )
          if (uncertain && body.confirmRetryAfterUnknown !== true)
            throw new ScriptVideoStoreError(
              uncertain.code === 'DELIVERY_FAILED'
                ? '视频已生成，本地保存失败。可恢复原任务并重新下载。'
                : '上次提交未收到结果。重新提交可能重复计费。',
              409,
              uncertain.code,
            )
          const remainingQueued = queuedReferenceCards(record.project, episodeId, session, body.requestId)
          if (source === 'pending' || source && typeof source !== 'string' && source.manualSeconds === undefined && remainingQueued.has(source.previousCardId)) {
            throw new ScriptVideoStoreError('本段从上一段尾帧继续，请等待上一段视频生成完成', 409, 'CONTINUATION_PENDING')
          }
          if (source === 'missing') {
            throw new ScriptVideoStoreError('本段从上一段尾帧继续，请先生成上一段视频', 409, 'CONTINUATION_REQUIRED')
          }
          const lightingPlan = planScriptVideoLighting(record.project, episodeId, record.jobs, remainingQueued)[cardId] || []
          if (lightingPlan.some(range => range.pendingCardId)) {
            throw new ScriptVideoStoreError('同场上一段正在制作，出片后将自动提取光线参考图', 409, 'LIGHTING_PENDING')
          }
          const generation = {
            card: structuredClone(card), assets: structuredClone(record.project.assets), cast: structuredClone(cast),
            stylePreset: structuredClone(stylePreset), continuationSource: source, lightingPlan,
          }
          if (body.confirmRetryAfterUnknown === true)
            for (const item of previous)
              if (
                item.code === 'SUBMISSION_UNKNOWN' ||
                item.code === 'DELIVERY_FAILED'
              ) {
                item.code = `${item.code}_ACKNOWLEDGED`
                const task = episode.tasks?.find((entry: any) => entry.id === item.id)
                if (task) task.code = item.code
              }
          const time = new Date().toISOString()
          const frameChoices = card.referenceFrameSettings
          const pickedPreviousEpisode = [frameChoices?.tail, ...Object.values(frameChoices?.lighting ?? {})]
            .some(choice => choice?.mode === 'manual' && choice.sourceCardId)
          const usesAutomaticSource = source?.manualSeconds === undefined && !!source ||
            lightingPlan.some(plan => plan.previous || plan.source && plan.source.manualSeconds === undefined)
          const videoJob: ScriptVideoJob = {
            id: `job-${randomUUID()}`,
            projectId: id,
            episodeId,
            cardId,
            cardVersion: card.version,
            ...(body.requestId && { requestId: body.requestId, ownerSession: session || undefined }),
            videoDigestVersion: 9,
            ...(pickedPreviousEpisode && !usesAutomaticSource && { videoIgnoresPredecessor: true }),
            videoModel: body.model.trim(),
            videoProvider: episode.modelName === body.model.trim() ? episode.modelProvider : undefined,
            videoPromptMode: promptMode,
            videoDuration: body.duration ?? card.duration,
            action: 'video',
            status: 'queued',
            createdAt: time,
            updatedAt: time,
          }
          videoJob.baseDigest = digest(record.project, episodeId, 'video', cardId, videoJob)
          registeredVideoJob = videoJob.id
          videoSubmissions.set(videoJob.id, submission)
          record.jobs.push(videoJob)
          episode.tasks ||= []
          episode.tasks.push({
            id: videoJob.id,
            cardId,
            cardVersion: card.version,
            title: card.title,
            status: 'processing',
            modelLabel: body.model,
            configId: body.configId,
            duration: videoJob.videoDuration,
            createdAt: time,
          })
          return {
            result: { ...generation, job: videoJob },
            documentChanged: true,
          }
        }, true)
        job = prepared.job
        queue.submitted(id, episodeId, cardId, session, body.requestId)
        const lighting = await prepareScriptVideoLighting(prepared.lightingPlan)
        if (lighting.warnings.length) throw new ScriptVideoGenerationValidationError(lighting.warnings[0])
        const generationInput = {
          projectId: id,
          episodeId,
          card: prepared.card,
          assets: prepared.assets,
          stylePreset: prepared.stylePreset,
          cast: prepared.cast,
          configId: body.configId,
          model: body.model,
          aspectRatio: body.aspectRatio,
          resolution: body.resolution,
          duration: body.duration,
          promptMode,
          allowJimeng: config?.provider === 'jimeng',
          allowLibTV: hasLoopbackAccess(c) || hasPrivateGatewayAccess(c),
          videoCliAccountId,
          continuationSource: prepared.continuationSource,
          lightingRanges: lighting.ranges.map(({ source, sceneKey, ...range }) => range),
        }
        submission.controller.signal.throwIfAborted()
        const submitted = await dependencies.startScriptVideoGeneration(generationInput, {
          signal: submission.controller.signal,
          onTaskCreated: taskId => {
            submission.taskId = taskId
            store.attachVideoTask(id, job!.id, taskId)
          },
        })
        const committed = await store.mutateEpisode(id, episodeId, (record) => {
          const current = record.jobs.find((item) => item.id === job!.id)!
          if (current.status === 'canceled') return { result: false, recordChanged: false }
          current.status = 'running'
          current.taskId = submitted.taskId
          if (lighting.checks.length) {
            const durationScale = (current.videoDuration ?? prepared.card.duration) / prepared.card.duration
            current.lightingChecks = lighting.checks.map(check => ({ ...check, start: check.start * durationScale, end: check.end * durationScale }))
          }
          if (submitted.referenceNames) current.videoReferenceNames = submitted.referenceNames
          current.updatedAt = new Date().toISOString()
          const task = record.project.episodes
            .find((ep) => ep.id === episodeId)
            ?.tasks?.find((item: any) => item.id === job!.id)
          if (task) {
            task.taskId = submitted.taskId
            if (submitted.continuation) task.continuation = submitted.continuation
            if (submitted.lightingRanges?.length) {
              task.lightingRanges = submitted.lightingRanges.map(range => {
                const planned = lighting.ranges.find(item => item.startShot === range.startShot && item.endShot === range.endShot)!
                return { ...range, sceneKey: planned.sceneKey, ...(range.imageUrl && { source: planned.source }) }
              })
            }
          }
          return { result: true, documentChanged: !!task }
        })
        if (!committed) throw new ScriptVideoStoreError('视频生成已取消', 409, 'CANCELED')
        return created(c, {
          jobId: job.id,
          taskId: submitted.taskId,
          status: submitted.status,
          duration: job.videoDuration,
          continuation: submitted.continuation,
        })
      } catch (error) {
        if (job) {
          if (submission.controller.signal.aborted || error instanceof ScriptVideoStoreError && error.code === 'CANCELED') {
            return respondError(c, new ScriptVideoStoreError('视频生成已取消', 409, 'CANCELED'))
          }
          const validation =
            (error as any)?.code === 'VALIDATION' &&
            (error as any)?.name === 'ScriptVideoGenerationValidationError'
          const code = validation ? 'VALIDATION' : 'SUBMISSION_UNKNOWN'
          const message = validation
            ? String((error as Error).message)
            : '提交未收到结果。重新提交可能重复计费。'
          await store
            .mutateEpisode(job.projectId, job.episodeId, (record) => {
              const current = record.jobs.find((item) => item.id === job!.id)
              if (current?.status === 'canceled') return { result: null, recordChanged: false }
              if (current) {
                current.status = 'failed'
                current.code = code
                current.error = message
                current.updatedAt = new Date().toISOString()
              }
              const task = record.project.episodes
                .find((ep) => ep.id === job!.episodeId)
                ?.tasks?.find((item: any) => item.id === job!.id)
              if (task) {
                task.status = 'failed'
                task.code = code
                task.error = message
              }
              return { result: null, documentChanged: !!task }
            })
            .catch(() => {})
          return c.json(
            { code: validation ? 400 : 502, errorCode: code, message },
            validation ? 400 : 502,
          )
        }
        return respondError(c, error)
      } finally {
        if (registeredVideoJob) videoSubmissions.delete(registeredVideoJob)
        releaseSubmission?.()
      }
    },
  )

  app.post('/projects/:id/episodes/:episodeId/video-cancel', async (c) => {
    try {
      const id = c.req.param('id'), episodeId = c.req.param('episodeId')
      const session = scriptVideoSession(c.req.header(SESSION_HEADER))
      const body = await c.req.json().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          (body.requestId !== undefined && !isVideoRequestId(body.requestId)) ||
          (body.cardId !== undefined && !isVideoRequestId(body.cardId)) ||
          (body.jobIds !== undefined && (!Array.isArray(body.jobIds) || !body.jobIds.length || !body.jobIds.every(isVideoRequestId)))) {
        throw new ScriptVideoStoreError('取消的视频任务标识无效')
      }
      if (!body.requestId && !body.jobIds?.length) throw new ScriptVideoStoreError('请选择要取消的生成请求或任务')
      const jobIds = body.jobIds ? new Set<string>(body.jobIds) : undefined
      const canceled = await store.mutateEpisode(id, episodeId, (record) => {
        const episode = episodeOf(record.project, episodeId)

        if (body.requestId) {
          if (session) queue.release(id, episodeId, session, body.requestId)
          const now = Date.now()
          for (const [key, expiresAt] of canceledVideoRequests) if (expiresAt <= now) canceledVideoRequests.delete(key)
          canceledVideoRequests.set(videoRequestKey(id, episodeId, session, body.requestId), now + 10 * 60_000)
        }
        const targets = record.jobs.filter(job => job.episodeId === episodeId && job.action === 'video' &&
          (job.status === 'queued' || job.status === 'running') &&
          (!body.requestId || job.requestId === body.requestId && (job.ownerSession ?? null) === session) &&
          (!jobIds || jobIds.has(job.id)) && (!body.cardId || job.cardId === body.cardId))
        const time = new Date().toISOString()
        return {
          result: targets.map(job => {
            const pending = videoSubmissions.get(job.id)
            const taskId = job.taskId ?? pending?.taskId
            const stopped = taskId ? cancelUnsubmittedVideoTask(taskId) : !!pending
            if (stopped) pending?.controller.abort()
            job.status = 'canceled'
            if (taskId) job.taskId = taskId
            job.code = stopped ? 'CANCELED' : 'SUBMISSION_UNKNOWN'
            job.error = stopped ? undefined : '已停止站内等待。服务商可能仍在生成或已计费。'
            job.updatedAt = time
            const task = episode.tasks?.find((entry: any) => entry.id === job.id)
            if (task) Object.assign(task, { status: 'canceled', taskId, code: job.code, error: job.error })
            return { jobId: job.id, taskId, stopped }
          }),
          recordChanged: targets.length > 0,
          documentChanged: targets.length > 0,
        }
      })
      const confirmed = (await Promise.all(canceled.flatMap(task =>
        !task.stopped && task.taskId ? [cancelDispatchedVideoTask(task.taskId).then(stopped => stopped ? task.jobId : undefined)] : [],
      ))).filter(Boolean)
      if (confirmed.length) await store.mutateEpisode(id, episodeId, (record) => {
        const episode = episodeOf(record.project, episodeId)
        const time = new Date().toISOString()
        for (const job of record.jobs) {
          if (!confirmed.includes(job.id) || job.status !== 'canceled' || job.code !== 'SUBMISSION_UNKNOWN') continue
          Object.assign(job, { code: 'CANCELED', error: undefined, updatedAt: time })
          const task = episode.tasks?.find((entry: any) => entry.id === job.id)
          if (task) Object.assign(task, { code: 'CANCELED', error: undefined })
        }
        return { result: null, documentChanged: true }
      })
      return success(c, { canceled: canceled.length,
        upstreamUnconfirmed: canceled.filter(task => !task.stopped && !confirmed.includes(task.jobId)).length })
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/video/:taskId/recover', async (c) => {
    const id = c.req.param('id'),
      taskId = Number(c.req.param('taskId'))
    let job: ScriptVideoJob | undefined
    let originalRecovery = false
    try {
      if (!Number.isSafeInteger(taskId) || taskId <= 0)
        throw new ScriptVideoStoreError('任务标识无效')
      // Resolve project ownership before reading the underlying task. A stale
      // display flag alone never authorizes an original-task query.
      const previous = await store.getVideoJob(id, taskId)
      if (previous.status === 'failed' && !previous.code?.endsWith('_ACKNOWLEDGED')) {
        const state = await dependencies.getScriptVideoGeneration(taskId)
        if (state.status === 'completed') {
          await reconcileVideoResults(id, [{ job: previous, state }])
          return success(c, state)
        }
        originalRecovery = previous.code !== 'DELIVERY_FAILED' && state.status === 'failed' && state.canRecover === true
      }
      const session = scriptVideoSession(c.req.header(SESSION_HEADER))
      job = await store.mutate(id, (record) => {
        const match = record.jobs.find(
          (item) => item.action === 'video' && item.taskId === taskId,
        )
        if (!match)
          throw new ScriptVideoStoreError('任务不属于此项目', 404, 'NOT_FOUND')

        if (match.status !== 'failed' || match.code !== 'DELIVERY_FAILED' && !originalRecovery)
          throw new ScriptVideoStoreError(
            '该任务当前无需或无法恢复',
            409,
            'RECOVERY_UNAVAILABLE',
          )
        match.status = 'running'
        match.code = undefined
        match.error = undefined
        match.canRecover = undefined
        match.updatedAt = new Date().toISOString()
        const task = record.project.episodes
          .find((ep) => ep.id === match.episodeId)
          ?.tasks?.find((item: any) => item.id === match.id)
        if (task) {
          task.status = 'processing'
          task.code = undefined
          task.error = undefined
          task.canRecover = undefined
        }
        return { result: structuredClone(match), documentChanged: !!task }
      })
      await dependencies.recoverVideoTask(taskId)
      return success(c, { taskId, status: 'processing' })
    } catch (error) {
      if (job)
        await store
          .mutate(id, (record) => {
            const current = record.jobs.find((item) => item.id === job!.id)
            if (current) {
              current.status = 'failed'
              current.code = originalRecovery ? 'SUBMISSION_UNKNOWN' : 'DELIVERY_FAILED'
              current.error = originalRecovery ? safeTaskError(error) : '恢复失败，请检查原视频服务配置后重试。'
              current.canRecover = originalRecovery ? true : undefined
              current.updatedAt = new Date().toISOString()
            }
            const task = record.project.episodes
              .find((ep) => ep.id === job!.episodeId)
              ?.tasks?.find((item: any) => item.id === job!.id)
            if (task) {
              task.status = 'failed'
              task.code = current?.code
              task.error = current?.error
              task.canRecover = current?.canRecover
            }
            return { result: null, documentChanged: !!task }
          })
          .catch(() => {})
      return job
        ? c.json(
            {
              code: 409,
              errorCode: originalRecovery ? 'SUBMISSION_UNKNOWN' : 'DELIVERY_FAILED',
              message: originalRecovery ? safeTaskError(error) : '恢复失败，请检查原视频服务配置后重试。',
            },
            409,
          )
        : respondError(c, error)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/cards/:cardId/video-version', async (c) => {
    try {
      const { id, episodeId, cardId } = c.req.param()
      const body = await c.req.json().catch(() => null)
      if (typeof body?.url !== 'string' || !body.url.trim()) throw new ScriptVideoStoreError('请选择要设为正片的视频版本。')
      const { url } = body
      await store.mutateEpisode(id, episodeId, async ({ project, jobs }) => {
        const episode = episodeOf(project, episodeId)
        const card = episode.cards.find((item: any) => item.id === cardId)
        if (!card) throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
        const active = jobs.some(job => job.action === 'video' && job.cardId === cardId &&
          (job.status === 'queued' || job.status === 'running'))
        if (active || store.queue.list(id, episodeId).some(item => item.cardId === cardId))
          throw new ScriptVideoStoreError('请等本段生成完成后再设置正片。', 409, 'VIDEO_ACTIVE')
        const versions = listScriptVideoVersions(card, episode.tasks)
        if (!versions.some(version => version.url === url) || !await resolveStoredVideo(url).catch(() => null)) {
          throw new ScriptVideoStoreError('该片段的视频版本已不可用。', 404, 'VIDEO_VERSION_UNAVAILABLE')
        }
        if (card.status === 'ready' && card.videoUrl === url) return { result: null, recordChanged: false }
        card.videoVersions = versions
        card.videoUrl = url
        card.status = 'ready'
        return { result: null, documentChanged: true }
      })
      return success(c, { url })
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.get('/projects/:id/episodes/:episodeId/video-export', async (c) => {
    try {
      const { project } = await store.episodeSnapshot(c.req.param('id'), c.req.param('episodeId'))
      const episode = episodeOf(project, c.req.param('episodeId'))
      const requestedId = c.req.query('id')
      const mergeId = requestedId === undefined ? undefined : Number(requestedId)
      if (mergeId !== undefined && (!Number.isSafeInteger(mergeId) || mergeId <= 0)) {
        throw new ScriptVideoStoreError('导出任务标识无效。')
      }
      const merge = getScriptVideoMerge(`script-video:${project.id}/${episode.id}`, mergeId)
      c.header('Cache-Control', 'no-store')
      return success(c, { merge: merge && {
        id: merge.id,
        status: merge.status,
        videoUrl: merge.mergedUrl ? '/' + merge.mergedUrl : undefined,
        error: merge.errorMsg || undefined,
      } })
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/video-export', async (c) => {
    try {
      const { project } = await store.episodeSnapshot(c.req.param('id'), c.req.param('episodeId'))
      const episode = episodeOf(project, c.req.param('episodeId'))
      const body = await c.req.json().catch(() => null)
      const requested: unknown = body?.cardIds
      if (!Array.isArray(requested) || !requested.length || requested.length > episode.cards.length ||
          requested.some(id => typeof id !== 'string') || new Set(requested).size !== requested.length) {
        throw new ScriptVideoStoreError('请选择要导出的已生成片段。')
      }
      const ids = new Set<string>(requested)
      const clips: string[] = []
      const completed = latestScriptVideoTaskUrls(episode.tasks)
      for (const [index, card] of episode.cards.entries()) {
        if (!ids.delete(card.id)) continue
        // Use the same available version as the preview for this segment.
        const url = selectScriptVideoPlayback(card, completed.get(card.id))?.url
        if (!url) {
          throw new ScriptVideoStoreError(`第 ${index + 1} 段还没有可导出的成片。`)
        }
        const source = await resolveStoredVideo(url).catch(() => null)
        if (!source) {
          throw new ScriptVideoStoreError(`第 ${index + 1} 段的视频文件无法读取，请重新选择。`)
        }
        clips.push(source.input)
      }
      if (ids.size) throw new ScriptVideoStoreError('所选片段已变更，请重新选择。', 409, 'CLIPS_CHANGED')
      try {
        const id = await mergeScriptVideoClips(`script-video:${project.id}/${episode.id}`, clips)
        return created(c, { id, status: 'processing' })
      } catch (error) {
        throw new ScriptVideoStoreError(safeTaskError(error))
      }
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.get('/projects/:id/episodes/:episodeId/video-status', async (c) => {
    try {
      c.header('Cache-Control', 'no-store')
      const tasks = await refreshPendingVideos(c.req.param('id'), c.req.param('episodeId'), true)
      return success(c, { tasks })
    } catch (e) {
      return respondError(c, e)
    }
  })

  app.get('/projects/:id/video/:taskId', async (c) => {
    try {
      const id = c.req.param('id'),
        taskId = Number(c.req.param('taskId'))
      if (!Number.isSafeInteger(taskId) || taskId <= 0)
        throw new ScriptVideoStoreError('任务标识无效')
      c.header('Cache-Control', 'no-store')
      const job = await store.getVideoJob(id, taskId)
      if (job.status === 'canceled') return success(c, { taskId, status: 'canceled', stage: 'canceled' })
      const state = await dependencies.getScriptVideoGeneration(taskId, { resumeOriginal: job.status === 'queued' || job.status === 'running' })
      await reconcileVideoResults(id, [{ job, state }])
      if (state.status !== 'processing' && (await store.getVideoJob(id, taskId)).status === 'canceled')
        return success(c, { taskId, status: 'canceled', stage: 'canceled' })
      return success(c, state)
    } catch (e) {
      return respondError(c, e)
    }
  })
  return app
}

export const scriptVideoStore = getDefaultScriptVideoStore()
export default createScriptVideoRoutes(scriptVideoStore)
