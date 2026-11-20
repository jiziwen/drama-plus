import { Hono } from 'hono'
import { randomUUID, createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { isAicostHost } from '../agents/openai-model.js'
import { db, schema } from '../db/index.js'
import { success, created } from '../utils/response.js'
import {
  ScriptVideoStore,
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
import { requireJimengPrivateAccess } from './jimeng.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess } from '../utils/private-access.js'
import {
  startScriptVideoGeneration,
  quoteScriptVideoGeneration,
  getScriptVideoGeneration,
  getScriptVideoSubmissionPrompt,
  prepareScriptVideoArchiveImages,
  prepareScriptVideoDeliveryReferences,
  previewScriptVideoPrompt,
  scriptVideoMissingVoicesMessage,
  type ScriptVideoContinuationSource,
  type ScriptVideoGenerationInput,
  type ScriptVideoGenerationStatus,
} from '../services/script-video-generation.js'
import { getScriptVideoMissingVoices, getScriptVideoVoiceInputs } from '../services/script-video-delivery.js'
import { isScriptVideoGenerationDuration } from '../services/script-video-capabilities.js'
import { isSeedance25Model } from '../services/seedance-models.js'
import { assertScriptVideoFormal, getScriptVideoContentWarnings, type ScriptVideoCard, type ScriptVideoInput } from '../services/script-video-types.js'
import { SCRIPT_VIDEO_STYLE_PRESETS } from '../services/script-video-style.js'
import {
  generateScriptVideoOutline,
  generateScriptVideoCards,
  reviewScriptVideoEpisode,
  reviseScriptVideoCard,
} from '../services/script-video-ai.js'
import { getScriptVideoContinuationScene } from '../services/script-video-scene-boundary.js'
import { planScriptVideoLighting, prepareScriptVideoLighting, reviewScriptVideoLighting, type RenderLightingRange } from '../services/script-video-lighting.js'
import { safeTaskError } from '../services/video-download.js'
import { holdVideoCliSubmission } from '../services/video-cli-tasks.js'
import { getScriptVideoMerge, mergeScriptVideoClips } from '../services/ffmpeg-merge.js'
import { resolveStoredVideo } from '../utils/video-poster.js'

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
function digest(
  project: ScriptVideoProject,
  episodeId: string,
  action: Action | 'video',
  cardId?: string,
  video?: Pick<ScriptVideoJob, 'videoDigestVersion' | 'videoModel' | 'videoProvider'>,
) {
  const ep = episodeOf(project, episodeId)
  const perCard = action === 'revisions' || action === 'video'
  const cardIndex =
    perCard
      ? ep.cards.findIndex((item: any) => item.id === cardId)
      : -1
  const card = cardIndex >= 0 ? ep.cards[cardIndex] : undefined
  const previousCard = cardIndex > 0 ? ep.cards[cardIndex - 1] : undefined
  if (perCard && !card)
    throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
  // Downloading a result changes the display state, not the inputs to this submission.
  const digestVersion = video?.videoDigestVersion ?? 0
  const scopedVoices = digestVersion >= 3
  const videoInput = (value: typeof card, predecessor = false) => {
    if (!value) return value
    const { status: _status, videoUrl: _videoUrl, ...fields } = value
    // A predecessor's voice-only revision does not change the tail frame that
    // was selected for this submission. Its actual shot fields still matter.
    if (scopedVoices && predecessor) delete fields.version
    return fields
  }
  if (digestVersion >= 6) {
    // The submission already owns its provider/model settings. A subsequent
    // picker change or an unrelated edit must not send this render to history.
    const stylePreset = ep.production?.stylePreset || project.settings?.stylePreset
    const cast = ep.production?.characters?.map(({ name }: { name: string }) => ({ name }))
    const voiceInputs = getScriptVideoVoiceInputs(card, project.assets, {
      model: video?.videoModel, provider: video?.videoProvider, cast, stylePreset,
    })
    const assetIds = new Set([...scriptVideoReferencedAssetIds(card), ...voiceInputs.keys()])
    const assets = project.assets.filter(asset => assetIds.has(asset.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(asset => [scriptVideoVisualAssetInput(asset), voiceInputs.get(asset.id)])
    const predecessor = previousCard && getScriptVideoContinuationScene(previousCard, card, project.assets)
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
    // Version 4 jobs were submitted with fallback enabled for unset roles.
    const voiceAssets = digestVersion === 4 ? project.assets.map(asset =>
      asset.kind === 'character' && asset.voiceMode === undefined ? { ...asset, voiceMode: 'model' } : asset,
    ) : project.assets
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
    cards: action === 'video' ? [videoInput(previousCard, true), videoInput(card)] : perCard ? [previousCard, card] : ep.cards,
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
function storyboardResumeKey(project: ScriptVideoProject, episodeId: string, body: any): string {
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
    configs,
  }
  return createHash('sha256').update(JSON.stringify({
    schema: 'script-video-storyboard-resume-v1',
    projectDigest: digest(project, episodeId, 'storyboard'),
    textOptions,
  })).digest('hex')
}
async function storyboardBatchSize(configId?: number) {
  const config = configId == null
    ? await getActiveConfig('text')
    : Number.isSafeInteger(configId) && configId > 0 ? await getConfigById(configId) : undefined
  if (config && config.provider.toLowerCase() !== 'gemini' && isAicostHost(getTextProviderBaseUrl(config))) return 1
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
  if (state.status === 'processing' || job.status === 'completed' || job.status === 'canceled') return false
  if (job.status === 'failed') {
    return job.code === 'SUBMISSION_UNKNOWN' && state.status === 'failed' && state.code === 'VIDEO_FAILED'
  }
  return true
}

export function createScriptVideoRoutes(
  store = new ScriptVideoStore(),
  dependencies: ScriptVideoDependencies = defaultDependencies,
) {
  const app = new Hono()
  const videoSubmissions = new Map<string, { controller: AbortController; taskId?: number }>()
  const canceledVideoRequests = new Map<string, number>()
  const videoRequestKey = (project: string, episode: string, session: string | null, request: string) =>
    `${project}/${episode}/${session}/${request}`
  const isVideoRequestId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
  const aiJobControllers = new Map<string, AbortController>()

  async function continuationSource(
    project: ScriptVideoProject, jobs: ScriptVideoJob[], episodeId: string, cardId: string, readOnly = false,
  ): Promise<ScriptVideoContinuationSource | 'pending' | 'missing' | undefined> {
    const episode = episodeOf(project, episodeId)
    const index = episode.cards.findIndex((card: { id: string }) => card.id === cardId)
    if (index < 1) return undefined
    const predecessor: ScriptVideoCard = episode.cards[index - 1]
    if (!getScriptVideoContinuationScene(predecessor, episode.cards[index], project.assets)) return undefined
    const previous = jobs.filter(job => job.action === 'video' && job.episodeId === episodeId &&
      job.cardId === predecessor.id && job.cardVersion === predecessor.version && job.status !== 'canceled' && !job.staleResult).at(-1)
    if (!previous || previous.status === 'failed') return 'missing'
    if (!previous.taskId) return previous.status === 'completed' ? 'missing' : 'pending'
    const shots = Array.isArray(predecessor.shots) ? predecessor.shots : []
    const state = await dependencies.getScriptVideoGeneration(previous.taskId, {
      reconcileRejection: !readOnly, finalShotNumber: shots.length,
    }).catch(() => null)
    if (state?.status === 'processing') return 'pending'
    if (state?.status !== 'completed' || !state.videoUrl) return 'missing'
    const matchesDuration = (seconds: number, duration: number) => Number.isFinite(duration) && Math.abs(seconds - duration) <= 0.001
    const durations = shots.map(shot => shot?.duration)
    const shotEndSeconds = durations.reduce((total, duration) => total + duration, 0)
    const hasShotTiming = durations.length > 0 && durations.every(duration => Number.isFinite(duration) && duration > 0) &&
      matchesDuration(shotEndSeconds, predecessor.duration)
    const previousDuration = previous.videoDuration ?? predecessor.duration
    const durationScale = previousDuration / predecessor.duration
    const submittedRange = state.finalShotRange
    const shotRange = submittedRange && matchesDuration(submittedRange.shotEndSeconds, previousDuration) ? submittedRange
      : hasShotTiming ? { shotStartSeconds: (shotEndSeconds - durations.at(-1)!) * durationScale, shotEndSeconds: previousDuration } : undefined
    return {
      previousCardId: predecessor.id, previousTaskId: previous.taskId, videoUrl: state.videoUrl,
      ...shotRange,
    }
  }

  async function reconcileVideoResults(projectId: string, checks: VideoCheck[]) {
    const terminal = checks.filter(needsVideoReconciliation)
    if (!terminal.length) return
    const lightingReviews = new Map<string, number[]>()
    for (const { job, state } of terminal) {
      if (state.status === 'completed' && state.videoUrl && job.lightingChecks?.length) {
        const shots = await reviewScriptVideoLighting(state.videoUrl, job.lightingChecks).catch(() => [])
        if (shots.length) lightingReviews.set(job.id, shots)
      }
    }
    await store.mutate(projectId, (record) => {
      let recordChanged = false
      let documentChanged = false
      const currentJobs = new Map(record.jobs.map(job => [job.id, job]))
      const completedCards: { card: any; videoUrl: string }[] = []
      for (const { job, state } of terminal) {
        const current = currentJobs.get(job.id)
        if (!current || current.status !== job.status || current.updatedAt !== job.updatedAt || current.code !== job.code) continue
        const episode = record.project.episodes.find(item => item.id === job.episodeId)
        if (current.status === 'failed') {
          if (!episode) continue
          documentChanged = reconcileRejectedVideoSubmission(episode, current, state) || documentChanged
          recordChanged = true
          continue
        }
        current.status = state.status === 'canceled' ? 'canceled' : state.status === 'completed' ? 'completed' : 'failed'
        current.updatedAt = new Date().toISOString()
        if (state.status === 'failed') {
          current.error = state.error || '视频生成失败，请检查模型配置后重试'
          current.code = state.code || 'VIDEO_FAILED'
        } else if (state.status === 'canceled') {
          current.code = 'CANCELED'
          current.error = undefined
        }
        const card = episode?.cards?.find((item: any) => item.id === job.cardId)
        const task = episode?.tasks?.find((item: any) => item.id === job.id)
        if (state.status === 'completed' && state.videoUrl) {
          const sameLightingSources = (task?.lightingRanges || []).every(({ imageUrl, source }: RenderLightingRange) =>
            !imageUrl || !source || episode.cards.some((c: any) => c.id === source.cardId && c.status === 'ready' && c.videoUrl === source.videoUrl))
          if (card && card.version === job.cardVersion && sameLightingSources &&
              digest(record.project, job.episodeId, job.videoDigestVersion ? 'video' : 'revisions', job.cardId, job) === job.baseDigest) {
            completedCards.push({ card, videoUrl: state.videoUrl })
          } else {
            // A regenerated video can be stale while the same-version old render stays ready.
            current.staleResult = true
          }
        }
        if (task) {
          task.status = state.status
          task.videoUrl = state.videoUrl
          task.error = current.error
          task.code = current.code
          if (lightingReviews.has(job.id)) task.lightingReviewShots = lightingReviews.get(job.id)
          if (current.staleResult) task.staleResult = true
          documentChanged = true
        }
        recordChanged = true
      }
      // Legacy video digests include the previous card's result URL.
      for (const { card, videoUrl } of completedCards) {
        card.videoUrl = videoUrl
        card.status = 'ready'
        documentChanged = true
      }
      return { result: null, recordChanged, documentChanged }
    })
  }

  async function refreshPendingVideos(projectId: string, episodeId?: string) {
    const jobs = await store.listPendingVideoJobs(projectId, episodeId)
    const checks = await Promise.all(jobs.map(async (job): Promise<VideoCheck> => ({
      job,
      // Leave one temporarily unreadable job pending without hiding updates to other tasks.
      state: await dependencies.getScriptVideoGeneration(job.taskId).catch(() => ({
        taskId: job.taskId, status: 'processing', stage: 'submitting',
      })),
    })))
    await reconcileVideoResults(projectId, checks)
    return checks.map(({ state }) => state)
  }

  app.get('/style-presets', (c) => success(c, SCRIPT_VIDEO_STYLE_PRESETS))
  app.get('/projects', async (c) => {
    try {
      return success(c, await store.list())
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
      const project = await store.get(id)
      if (!project.episodes.some(episode => episode.tasks?.some((task: any) => task.status === 'processing' && task.taskId)))
        return success(c, project)
      // A worker can finish while all editing pages are closed.
      await refreshPendingVideos(id)
      return success(c, await store.get(id))
    } catch (e) {
      return respondError(c, e)
    }
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
      return success(c, await store.listJobs(c.req.param('id'), c.req.query('episodeId')))
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

  app.post('/projects/:id/episodes/:episodeId/final-prompt', async (c) => {
    try {
      c.header('Cache-Control', 'no-store')
      const id = c.req.param('id'), episodeId = c.req.param('episodeId')
      const body = await c.req.json().catch(() => null)
      if (typeof body?.cardId !== 'string' || !body.cardId) {
        throw new ScriptVideoStoreError('无效的分镜')
      }
      if (body.jobId !== undefined) {
        if (typeof body.jobId !== 'string' || !body.jobId) throw new ScriptVideoStoreError('无效的视频任务')
        const submission = await store.mutate(id, ({ project, jobs }) => {
          const episode = episodeOf(project, episodeId)
          const job = jobs.find(item => item.id === body.jobId && item.projectId === id && item.episodeId === episodeId &&
            item.cardId === body.cardId && item.action === 'video')
          if (!job) throw new ScriptVideoStoreError('视频任务不属于本段', 404, 'NOT_FOUND')
          const task = episode.tasks?.find((item: any) => item.id === job.id && item.taskId === job.taskId)
          const result = job.taskId && getScriptVideoSubmissionPrompt(job.taskId, project.assets,
            job.videoReferenceNames, task?.continuation, task?.lightingRanges)
          if (!result) throw new ScriptVideoStoreError('该任务暂无可查看的提交提示词', 404, 'VIDEO_PROMPT_UNAVAILABLE')
          return { result, recordChanged: false }
        })
        return success(c, submission)
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
      const prepared = await store.mutate(id, async ({ project, jobs }) => {
        const episode = episodeOf(project, episodeId)
        const card = episode.cards.find((item: any) => item.id === body.cardId)
        if (!card) throw new ScriptVideoStoreError('分镜不存在', 404, 'NOT_FOUND')
        if (card.version !== body.cardVersion) throw new ScriptVideoStoreError('分镜已更新，请刷新后重试', 409, 'CONFLICT')
        if (card.manuallyAdded) {
          if (!card.prompt?.trim()) throw new ScriptVideoStoreError('请先输入本段视频提示词', 422, 'PROMPT_REQUIRED')
        } else {
          requireSynchronized([card])
          if (!card.prompt?.trim() || !Array.isArray(card.shots) || !card.shots.length)
            throw new ScriptVideoStoreError('请先生成本段提示词和分镜脚本', 422, 'STORYBOARD_REQUIRED')
        }
        const cast = episode.production?.characters
        const stylePreset = episode.production?.stylePreset || project.settings?.stylePreset
        if (hasSelection) {
          requireConfirmed(episode, 'revisions')
          if (!card.manuallyAdded && !getScriptVideoMissingVoices(card, project.assets, { cast, stylePreset }).length) {
            dependencies.assertScriptVideoFormal({ production: episode.production, script: episode.confirmedScript,
              assets: project.assets, cards: [card], scope: 'card' })
          }
        }
        const lightingPlan = planScriptVideoLighting(project, episodeId, jobs)[card.id] || []
        const source = await continuationSource(project, jobs, episodeId, card.id, true)
        return { result: { card, assets: project.assets, cast, stylePreset, source, lightingPlan },
          recordChanged: false }
      })
      const { source, lightingPlan, ...input } = prepared
      const continuationSourceForPreview = typeof source === 'string' ? undefined : source
      const pending = source === 'pending' ? '上一段成片仍在生成，出片后将自动补入尾帧。'
        : source === 'missing' ? '先生成上一段视频，系统会自动补入成片尾帧。'
          : !source && lightingPlan.some(range => range.pendingPrevious) ? '同场上一段正在制作，出片后将自动补入光线参考图。' : undefined
      try {
        const lighting = await prepareScriptVideoLighting(lightingPlan)
        const result = await previewScriptVideoPrompt({ ...input, projectId: id, episodeId, waitingForReference: !!pending,
          selection: hasSelection ? { configId: body.configId, model: body.model, aspectRatio: body.aspectRatio, resolution: body.resolution } : undefined,
          duration: body.duration,
          continuationSource: continuationSourceForPreview,
          lightingRanges: lighting.ranges.map(({ source, sceneKey, ...range }) => range),
        })
        return success(c, { ...result, ...(pending && { pending }) })
      } catch (error) {
        throw new ScriptVideoStoreError(safeTaskError(error), 422, 'VIDEO_PROMPT_PREVIEW')
      }
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/continuations', async (c) => {
    try {
      const { cardIds, configId, model } = await c.req.json()
      if (!Array.isArray(cardIds) || cardIds.some(cardId => typeof cardId !== 'string') ||
          !Number.isSafeInteger(configId) || configId <= 0 || typeof model !== 'string' || !model.trim()) {
        throw new ScriptVideoStoreError('视频模型配置或分镜无效')
      }
      const id = c.req.param('id'), episodeId = c.req.param('episodeId')
      const { assets, options, inputs, lightingPlans } = await store.mutate(id, async ({ project, jobs }) => {
        const episode = episodeOf(project, episodeId)
        const lightingPlans = planScriptVideoLighting(project, episodeId, jobs)
        const inputs = []
        for (const card of episode.cards) {
          if (!cardIds.includes(card.id)) continue
          const source = await continuationSource(project, jobs, episodeId, card.id)
          inputs.push({ card, source: source && typeof source !== 'string' ? source : undefined })
        }
        return {
          result: {
            inputs, assets: project.assets,
            lightingPlans: Object.entries(lightingPlans).filter(([cardId]) => cardIds.includes(cardId)),
            options: { configId, model, cast: episode.production?.characters,
              stylePreset: episode.production?.stylePreset || project.settings?.stylePreset },
          },
          recordChanged: false,
        }
      })
      try {
        const lightingRanges = Object.create(null)
        for (const [cardId, plans] of lightingPlans) {
          const prepared = await prepareScriptVideoLighting(plans)
          lightingRanges[cardId] = prepared.ranges.map(({ source, sceneKey, ...range }) => range)
        }
        return success(c, await prepareScriptVideoDeliveryReferences(inputs, assets, options, lightingRanges))
      } catch (error) {
        throw new ScriptVideoStoreError(error instanceof Error ? error.message : '上一段尾帧准备失败', 422, 'CONTINUATION_FRAME')
      }
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/episodes/:episodeId/validate', async (c) => {
    try {
      const project = await store.get(c.req.param('id'))
      const episode = episodeOf(project, c.req.param('episodeId'))
      requireConfirmed(episode, 'revisions')
      const body = await c.req.json()
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
            model: episode.modelName, provider: episode.modelProvider, cast: episode.production?.characters,
            stylePreset: episode.production?.stylePreset || project.settings?.stylePreset,
          }, episode.resolution || '720p')
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
        const prepared = await store.mutate(id, (record) => {
          const ep = episodeOf(record.project, episodeId)
          store.requireEpisodeLease(id, episodeId, session)
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
          const resumeKey = action === 'storyboard' ? storyboardResumeKey(record.project, episodeId, body) : undefined
          const lastResume = resumeKey ? record.jobs.slice().reverse().find(item =>
            item.action === 'storyboard' && item.episodeId === episodeId && item.resumeKey === resumeKey &&
            (item.status === 'canceled' || (item.status === 'failed' && item.checkpoint))) : undefined
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
      const started = await store.mutate(job.projectId, (record) => {
        const current = record.jobs.find((item) => item.id === job.id)
        if (current?.status !== 'queued') return { result: false, recordChanged: false }
        current.status = 'running'
        current.updatedAt = new Date().toISOString()
        return { result: true }
      })
      if (!started || signal.aborted) return
      const ep = episodeOf(project, job.episodeId)
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
        deliverySpecs: { aspectRatio: ep.aspectRatio, resolution: ep.resolution, videoModel: ep.modelName },
        systemPrompt: body.systemPrompt ?? project.settings?.systemPrompt,
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
                batchSize: await storyboardBatchSize(input.configId),
                checkpoint: job.checkpoint,
                onProgress: async (progress, checkpoint) => {
                  signal.throwIfAborted()
                  await store.mutate(job.projectId, (record) => {
                    const current = record.jobs.find(item => item.id === job.id)
                    if (!current || current.status !== 'running' || current.resumeKey !== storyboardResumeKey(record.project, job.episodeId, body))
                      throw new ScriptVideoStoreError('剧本、资产、模型或制作设置已发生变化，请重新生成', 409, 'STALE')
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
      await store.mutate(job.projectId, (record) => {
        const current = record.jobs.find((item) => item.id === job.id)
        if (current?.status !== 'running' || signal.aborted) return { result: null, recordChanged: false }
        if (
          digest(
            record.project,
            job.episodeId,
            job.action as Action,
            body.cardId,
          ) !== base
          || (job.action === 'storyboard' && job.resumeKey !== storyboardResumeKey(record.project, job.episodeId, body))
        ) {
          current.status = 'failed'
          current.code = 'STALE'
          current.error = '剧本、资产或分镜已发生变化，请重新生成'
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
          const target = episodeOf(record.project, job.episodeId)
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
            const { manuallyAdded: _manualOrigin, ...generated } = card
            return {
              ...generated,
              promptNeedsSync: false,
              videoUrl: retimed && (previous?.duration !== card.duration || previous?.prompt !== card.prompt)
                ? undefined : previous?.videoUrl,
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
        .mutate(job.projectId, (record) => {
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
  app.on('POST', [
    '/projects/:id/episodes/:episodeId/cards/:cardId/video',
    '/projects/:id/episodes/:episodeId/cards/:cardId/video/quote',
  ],
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
        const quoteOnly = new URL(c.req.url).pathname.endsWith('/quote')
        if (quoteOnly || body.jimengQuoteId !== undefined) {
          try { requireJimengPrivateAccess(c) }
          catch (error) { throw new ScriptVideoStoreError((error as Error).message, 403, 'FORBIDDEN') }
        }
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
        if (!quoteOnly) {
          const configs = schema.aiServiceConfigs
          const config = db.select({ provider: configs.provider }).from(configs).where(eq(configs.id, body.configId)).get()
          releaseSubmission = holdVideoCliSubmission(config?.provider)
        }
        const session = scriptVideoSession(c.req.header(SESSION_HEADER))
        if (body.requestId !== undefined && !isVideoRequestId(body.requestId))
          throw new ScriptVideoStoreError('视频请求标识无效')
        const prepared = await store.mutate<Pick<ScriptVideoGenerationInput, 'card' | 'assets' | 'cast' | 'stylePreset' | 'continuationSource'> & {
          job?: ScriptVideoJob
          lightingPlan: ReturnType<typeof planScriptVideoLighting>[string]
        }>(id, async (record) => {
          const episode = episodeOf(record.project, episodeId)
          store.requireEpisodeLease(id, episodeId, session)
          if (body.requestId && (canceledVideoRequests.get(videoRequestKey(id, episodeId, session, body.requestId)) || 0) > Date.now()) {
            throw new ScriptVideoStoreError('视频生成已取消', 409, 'CANCELED')
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
          const cast = episode.production?.characters
          const stylePreset = episode.production?.stylePreset || record.project.settings?.stylePreset
          if (card.manuallyAdded) {
            if (!card.prompt?.trim()) throw new ScriptVideoStoreError('请先输入本段视频提示词', 422, 'PROMPT_REQUIRED')
          } else {
            requireSynchronized([card])
            const missingVoices = getScriptVideoMissingVoices(card, record.project.assets, { cast, stylePreset })
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
          if (
            previous.some(
              (item) => item.status === 'queued' || item.status === 'running',
            )
          )
            throw new ScriptVideoStoreError(
              '此分镜已有视频任务正在提交或处理中',
              409,
              'VIDEO_ACTIVE',
            )
          for (const item of previous) {
            if (item.status !== 'failed' || item.code !== 'SUBMISSION_UNKNOWN' || !item.taskId) continue
            const state = await dependencies.getScriptVideoGeneration(item.taskId).catch(() => null)
            reconcileRejectedVideoSubmission(episode, item, state)
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
          const source = await continuationSource(record.project, record.jobs, episodeId, cardId)
          if (source === 'pending') {
            throw new ScriptVideoStoreError('本段从上一段尾帧继续，请等待上一段视频生成完成', 409, 'CONTINUATION_PENDING')
          }
          if (source === 'missing') {
            throw new ScriptVideoStoreError('本段从上一段尾帧继续，请先生成上一段视频', 409, 'CONTINUATION_REQUIRED')
          }
          const lightingPlan = planScriptVideoLighting(record.project, episodeId, record.jobs)[cardId] || []
          if (!source && lightingPlan.some(range => range.pendingPrevious)) {
            throw new ScriptVideoStoreError('同场上一段正在制作，出片后将自动提取光线参考图', 409, 'LIGHTING_PENDING')
          }
          const generation = {
            card: structuredClone(card), assets: structuredClone(record.project.assets), cast: structuredClone(cast),
            stylePreset: structuredClone(stylePreset), continuationSource: source, lightingPlan,
          }
          if (quoteOnly) return { result: { ...generation, job: undefined }, recordChanged: false }
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
          const videoJob: ScriptVideoJob = {
            id: `job-${randomUUID()}`,
            projectId: id,
            episodeId,
            cardId,
            cardVersion: card.version,
            videoDigestVersion: 6,
            videoModel: body.model.trim(),
            videoProvider: episode.modelName === body.model.trim() ? episode.modelProvider : undefined,
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
        })
        job = prepared.job
        const lighting = await prepareScriptVideoLighting(prepared.lightingPlan)
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
          allowLibTV: hasLoopbackAccess(c) || hasPrivateGatewayAccess(c),
          continuationSource: prepared.continuationSource,
          lightingRanges: lighting.ranges.map(({ source, sceneKey, ...range }) => range),
          ...(quoteOnly || body.jimengQuoteId !== undefined ? {
            jimengScope: createHash('sha256').update(JSON.stringify([id, episodeId, cardId, body.expectedCardVersion, session])).digest('hex'),
            jimengQuoteId: body.jimengQuoteId,
          } : {}),
        }
        if (quoteOnly) {
          try { return success(c, await quoteScriptVideoGeneration(generationInput)) }
          catch (error) { throw new ScriptVideoStoreError(safeTaskError(error), 422, 'JIMENG_QUOTE_UNAVAILABLE') }
        }
        if (!job) throw new ScriptVideoStoreError('视频任务未能提交')
        submission.controller.signal.throwIfAborted()
        const submitted = await dependencies.startScriptVideoGeneration(generationInput, {
          signal: submission.controller.signal,
          onTaskCreated: taskId => { submission.taskId = taskId },
        })
        const committed = await store.mutate(id, (record) => {
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
            .mutate(job.projectId, (record) => {
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
      const jobIds = body.jobIds ? new Set<string>(body.jobIds) : undefined
      const canceled = await store.mutate(id, (record) => {
        const episode = episodeOf(record.project, episodeId)
        store.requireEpisodeLease(id, episodeId, session)
        if (body.requestId) {
          const now = Date.now()
          for (const [key, expiresAt] of canceledVideoRequests) if (expiresAt <= now) canceledVideoRequests.delete(key)
          canceledVideoRequests.set(videoRequestKey(id, episodeId, session, body.requestId), now + 10 * 60_000)
        }
        const targets = record.jobs.filter(job => job.episodeId === episodeId && job.action === 'video' &&
          (job.status === 'queued' || job.status === 'running') &&
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
      if (confirmed.length) await store.mutate(id, (record) => {
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
    try {
      if (!Number.isSafeInteger(taskId) || taskId <= 0)
        throw new ScriptVideoStoreError('任务标识无效')
      const session = scriptVideoSession(c.req.header(SESSION_HEADER))
      job = await store.mutate(id, (record) => {
        const match = record.jobs.find(
          (item) => item.action === 'video' && item.taskId === taskId,
        )
        if (!match)
          throw new ScriptVideoStoreError('任务不属于此项目', 404, 'NOT_FOUND')
        store.requireEpisodeLease(id, match.episodeId, session)
        if (match.status !== 'failed' || match.code !== 'DELIVERY_FAILED')
          throw new ScriptVideoStoreError(
            '该任务当前无需或无法恢复',
            409,
            'RECOVERY_UNAVAILABLE',
          )
        match.status = 'running'
        match.code = undefined
        match.error = undefined
        match.updatedAt = new Date().toISOString()
        const task = record.project.episodes
          .find((ep) => ep.id === match.episodeId)
          ?.tasks?.find((item: any) => item.id === match.id)
        if (task) {
          task.status = 'processing'
          task.code = undefined
          task.error = undefined
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
              current.code = 'DELIVERY_FAILED'
              current.error = '恢复失败，请检查原视频服务配置后重试。'
              current.updatedAt = new Date().toISOString()
            }
            const task = record.project.episodes
              .find((ep) => ep.id === job!.episodeId)
              ?.tasks?.find((item: any) => item.id === job!.id)
            if (task) {
              task.status = 'failed'
              task.code = 'DELIVERY_FAILED'
              task.error = current?.error
            }
            return { result: null, documentChanged: !!task }
          })
          .catch(() => {})
      return job
        ? c.json(
            {
              code: 409,
              errorCode: 'DELIVERY_FAILED',
              message: '恢复失败，请检查原视频服务配置后重试。',
            },
            409,
          )
        : respondError(c, error)
    }
  })

  app.get('/projects/:id/episodes/:episodeId/video-export', async (c) => {
    try {
      const project = await store.get(c.req.param('id'))
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
      const project = await store.get(c.req.param('id'))
      const episode = episodeOf(project, c.req.param('episodeId'))
      const body = await c.req.json().catch(() => null)
      const requested: unknown = body?.cardIds
      if (!Array.isArray(requested) || !requested.length || requested.length > episode.cards.length ||
          requested.some(id => typeof id !== 'string') || new Set(requested).size !== requested.length) {
        throw new ScriptVideoStoreError('请选择要导出的已生成片段。')
      }
      const ids = new Set<string>(requested)
      const clips: string[] = []
      const completed = new Map<string, string>()
      for (const task of episode.tasks || []) {
        if (task.status === 'completed' && typeof task.videoUrl === 'string' && task.videoUrl) {
          completed.set(task.cardId, task.videoUrl)
        }
      }
      for (const [index, card] of episode.cards.entries()) {
        if (!ids.delete(card.id)) continue
        // Use the same available version as the preview for this segment.
        const storedUrl = typeof card.videoUrl === 'string' ? card.videoUrl.trim() : ''
        const url = card.status === 'ready' && storedUrl ? storedUrl : completed.get(card.id)?.trim() || storedUrl
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
      const tasks = await refreshPendingVideos(c.req.param('id'), c.req.param('episodeId'))
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
      const state = await dependencies.getScriptVideoGeneration(taskId)
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

export default createScriptVideoRoutes()
