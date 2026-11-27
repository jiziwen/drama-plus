/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { isSeedance25Model } from './seedance-models.js'
import { inlineSeedanceVoice } from './seedance-reference-media.js'
import { db, getInsertId, schema } from '../db/index.js'
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm'
import fs from 'node:fs'
import { getAbsolutePath } from '../utils/storage.js'
import { downloadVideo, safeTaskError } from './video-download.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { withImageTaskSubmission } from './image-submission.js'
import { assertImageMode, resolveMediaConfig, validateReferenceImages } from './media-selection.js'
import { downloadImage, fetchImageAsCompressedDataUrl, generateImageThumb, imageThumbnail, readImageAsCompressedDataUrl, readImageAsDataUrl, saveUploadedFile } from '../utils/storage.js'
import { imageExtensionFromMetadata } from '../utils/reference-image-format.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter, videoAdapters } from './adapters/registry'
import { aicostVideoSubmissionRejection } from './adapters/aicost-video.js'
import { isMidjourneyBlend, isMidjourneyImageConfig } from './adapters/midjourney-image.js'
import type { AIConfig, VideoGenerationRecord } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { buildComfyWorkflow, comfyHeaders, submitComfyWorkflow, pollComfyWorkflow } from './comfyui.js'
import { recordedFetch as fetch, withApiCallContext } from './api-call-log.js'
import { resolvePublicMediaUrl, resolvePublicMediaUrls } from './public-media.js'
import { isPreTlsConnectionReset } from '../utils/network-error.js'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { STORAGE_ROOT } from '../utils/paths.js'
import { downloadJimengVideo, inspectJimengVideo, JimengCliError, runJimengVideo, withJimengAccount, type JimengVideoRunInput } from './jimeng-cli.js'
import { prepareJimengVideo, validateJimengVideo } from './jimeng-video.js'
import { createLibTVVideoNode, inspectLibTVVideoStatus, LIBTV_GENERATION_TIMEOUT_MS, LibTVCliError, libtvProjectId, runLibTVVideo, validateLibTVVideo, withLibTVAccount, withLibTVCanvas, type LibTVNode } from './libtv-cli.js'
import { assertVideoCliNotDisconnecting, holdVideoCliSubmission } from './video-cli-tasks.js'
import { resolveVideoCliAccountId } from './video-cli-accounts.js'
import { cancelUpstreamVideo } from './video-upstream-cancel.js'
import { scheduleRetiredUploadCleanup } from './script-video-media-retention.js'
import { isScriptVideoVoiceModel, saveGeneratedCharacterVoice, scriptVideoVoiceTaskScope, scriptVideoVoiceRequest, type ScriptVideoVoiceRequest } from './script-video-voice-generation.js'
import { ScriptVideoStoreError } from './script-video-store.js'
import { GALLERY_IMAGE_SIZES, isGalleryImageAspect, type GalleryImageAspect } from './gallery-asset-types.js'

type TaskType = 'image' | 'video'

export const VIDEO_REQUEST_NOT_SENT_MESSAGE = '连接视频服务时 TLS 握手断开，生成请求未送达，可直接重试。'

const activeTasks = new Set<number>()
export function isGenerationTaskActive(id: number): boolean { return activeTasks.has(id) }
const videoSubmissions = new Set<number>()
const voiceSubmissions = new Set<string>()
const voiceGenerationActive = () => new ScriptVideoStoreError('该角色已有声音生成任务，请等待完成', 409, 'VOICE_GENERATION_ACTIVE')
function runBackground(id: number, job: () => Promise<void>) {
  if (activeTasks.has(id)) return
  activeTasks.add(id)
  void job().catch(error => failTask(id, safeTaskError(error))).finally(() => activeTasks.delete(id))
}

const taskLabel = (type: TaskType) => (type === 'image' ? 'ImageTask' : 'VideoTask')

// 轮询节奏：图片 5s×120（上限 10 分钟）；视频 10s×300
const POLL_PROFILES: Record<TaskType, { attempts: number; intervalMs: number; maxDurationMs: number | null }> = {
  image: { attempts: 120, intervalMs: 5000, maxDurationMs: 600_000 },
  video: { attempts: 300, intervalMs: 10_000, maxDurationMs: null },
}
const VIDEO_RECOVERY_RETRY_MS = 60_000

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  requireLandscape16x9?: boolean
  galleryAspect?: GalleryImageAspect
  referenceImages?: string[]
  frameType?: string
  configId?: number
  scriptVideoAsset?: { projectId: string; assetId: string; requestId: string }
}

export interface GenerateVideoParams {
  storyboardId?: number
  dramaId?: number
  prompt: string
  model?: string
  referenceMode?: string
  imageUrl?: string
  firstFrameUrl?: string
  lastFrameUrl?: string
  referenceImageUrls?: string[]
  referenceVideoUrls?: string[]
  referenceAudioUrls?: string[]
  /** Original uploads behind provider-specific submission copies. Local retention only. */
  sourceUploadUrls?: string[]
  referenceFileUrl?: string
  referenceLinkUrl?: string
  generateAudio?: boolean
  duration?: number
  aspectRatio?: string
  resolution?: string
  seed?: number
  promptExtend?: boolean
  watermark?: boolean
  configId?: number
  forceNew?: boolean
  allowJimeng?: boolean
  allowLibTV?: boolean
  /** 提交时固定的本地账号，切换默认账号不改变已有任务。 */
  videoCliAccountId?: string
  scriptVideoVoice?: ScriptVideoVoiceRequest
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  return withImageTaskSubmission(params, () => enqueueImage(params))
}

async function enqueueImage(params: GenerateImageParams): Promise<number> {
  const config = await resolveMediaConfig('image', params)
  const referenceImages = params.referenceImages === undefined ? [] : validateReferenceImages(params.referenceImages)
  assertImageMode(config, referenceImages.length ? 'reference' : 'text', referenceImages.length)
  const size = params.galleryAspect ? galleryRequestSize(config, params.galleryAspect) : params.size

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: config.model,
  }, {
    size: size || (config.provider === 'comfyui' ? undefined : '1920x1080'),
    ...(params.galleryAspect && { galleryAspect: params.galleryAspect }),
    ...(params.requireLandscape16x9 && { requireLandscape16x9: true }),
    frameType: params.frameType,
    referenceImages,
    ...(params.scriptVideoAsset && { scriptVideoAsset: params.scriptVideoAsset }),
  })

  logTaskStart('ImageTask', 'enqueue', {
    id,
    provider: config.provider,
    storyboardId: params.storyboardId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    frameType: params.frameType,
    model: params.model || config.model,
  })
  logTaskPayload('ImageTask', 'enqueue params', {
    id,
    config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
    params,
  })
  return id
}

function galleryRequestSize(config: AIConfig, aspect: GalleryImageAspect) {
  if (config.provider === 'openai') {
    if (config.model === 'dall-e-2') return '1024x1024'
    if (config.model === 'dall-e-3') {
      return { '9:16': '1024x1792', '16:9': '1792x1024', '1:1': '1024x1024' }[aspect]
    }
  }
  return GALLERY_IMAGE_SIZES[aspect]
}

export type VideoSubmissionControl = {
  signal: AbortSignal
  onTaskCreated: (taskId: number) => void
}

export async function generateVideo(params: GenerateVideoParams, control?: VideoSubmissionControl): Promise<number> {
  let releaseCliSubmission: (() => void) | undefined
  const storyboardId = params.storyboardId
  const voice = params.scriptVideoVoice
  const voiceKey = voice && `${voice.projectId}/${voice.assetId}`
  if (storyboardId && videoSubmissions.has(storyboardId)) throw new Error('该分镜正在提交任务，请勿重复点击')
  if (voiceKey && voiceSubmissions.has(voiceKey)) throw voiceGenerationActive()
  if (voiceKey) voiceSubmissions.add(voiceKey)
  if (storyboardId) videoSubmissions.add(storyboardId)
  try {
    if (voice && activeVoiceTask(db, voice)) throw voiceGenerationActive()
    if (storyboardId) {
      const [latest] = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId)))
        .orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') throw new Error('该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && params.forceNew !== true) throw new Error('请先恢复原任务；重新生成需确认可能再次计费')
    }
    const config = await resolveMediaConfig('video', params, voice ? isScriptVideoVoiceModel : undefined)
    if (voice && !isScriptVideoVoiceModel(config.provider, config.model))
      throw new ScriptVideoStoreError('请选择即梦积分或 LibTV 的 Seedance 2.0 Mini 视频服务')
    if (config.provider === 'jimeng' || config.provider === 'libtv') {
      const accountId = resolveVideoCliAccountId(config.provider, params.videoCliAccountId ?? config.videoCliAccountId)
      params = { ...params, videoCliAccountId: accountId }
      releaseCliSubmission = holdVideoCliSubmission(config.provider, params.videoCliAccountId)
    }
    if (config.provider === 'libtv') {
      if (!params.allowLibTV) throw new LibTVCliError('请通过私有站点的「剧本转视频」使用 LibTV')
      await withLibTVAccount(params.videoCliAccountId!, () => libtvProjectId())
      validateLibTVVideo({ ...params, model: config.model })
    }
    control?.signal.throwIfAborted()
    assertVideoCliNotDisconnecting(config.provider, params.videoCliAccountId)
    let jimeng: JimengVideoRunInput | undefined
    if (config.provider === 'jimeng') {
      if (!params.allowJimeng) throw new JimengCliError('请通过私有站点的「剧本转视频」使用即梦积分')
      try {
        jimeng = await withJimengAccount(params.videoCliAccountId!, () => prepareJimengVideo(params, config, control?.signal))
      } catch (error) {
        control?.signal.throwIfAborted()
        if (error instanceof JimengCliError) throw error
        throw new JimengCliError(safeTaskError(error))
      }
    }

    const id = await createTask('video', config, {
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      prompt: params.prompt,
      model: params.model || config.model,
    }, { ...videoTaskInputs(params, config.provider), ...(jimeng && { jimeng }) }, control)

    logTaskStart('VideoTask', 'enqueue', {
      id,
      provider: config.provider,
      storyboardId: params.storyboardId,
      dramaId: params.dramaId,
      referenceMode: params.referenceMode || 'reference',
      duration: params.duration || 5,
    })
    logTaskPayload('VideoTask', 'enqueue params', {
      id,
      config: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      params,
    })
    return id
  } finally {
    releaseCliSubmission?.()
    if (storyboardId) videoSubmissions.delete(storyboardId)
    if (voiceKey) voiceSubmissions.delete(voiceKey)
  }
}

function activeVoiceTask(database: Pick<typeof db, 'select'>, voice: ScriptVideoVoiceRequest) {
  const task = schema.sysTask
  return database.select({ id: task.id }).from(task).where(and(eq(task.status, 'processing'), scriptVideoVoiceTaskScope(voice))).get()
}

function videoTaskInputs(params: GenerateVideoParams, provider: string) {
  const { referenceMode, imageUrl, firstFrameUrl, lastFrameUrl, referenceImageUrls, referenceVideoUrls, referenceAudioUrls,
    referenceFileUrl, referenceLinkUrl, generateAudio, duration, aspectRatio, resolution, seed, promptExtend, watermark } = params
  return {
    referenceMode: referenceMode || 'reference',
    imageUrl, firstFrameUrl, lastFrameUrl, referenceImageUrls, referenceVideoUrls, referenceAudioUrls, referenceFileUrl,
    ...(params.sourceUploadUrls?.length && { sourceUploadUrls: params.sourceUploadUrls }),
    referenceLinkUrl, generateAudio: generateAudio === false ? 0 : 1, duration, aspectRatio,
    resolution: normalizeStoredVideoResolution(resolution, provider), seed, promptExtend, watermark,
    ...(params.videoCliAccountId && { videoCliAccountId: params.videoCliAccountId }),
    ...(params.scriptVideoVoice && { scriptVideoVoice: params.scriptVideoVoice }),
  }
}

type VideoTaskInputs = Partial<ReturnType<typeof videoTaskInputs>>

async function buildVideoProviderRequest(
  config: AIConfig, record: Pick<VideoGenerationRecord, 'id' | 'model' | 'prompt'>, params: VideoTaskInputs,
) {
  const publicMedia = !!process.env.PUBLIC_BASE_URL?.trim()
  const adapter = getVideoAdapter(config.provider)
  const directReferences = !publicMedia && adapter.provider === 'aicost'
  const publicImageOptions = { matchImageExtension: adapter.provider === 'aicost' }
  const resolveImage = (value?: string) => publicMedia ? resolvePublicMediaUrl(value, 'image', publicImageOptions)
    : directReferences ? value : normalizeVideoReferenceUrl(value)
  const resolvedReferenceImageUrls = publicMedia ? await resolvePublicMediaUrls(params.referenceImageUrls, 'image', publicImageOptions)
    : directReferences ? params.referenceImageUrls : await normalizeVideoReferenceUrls(params.referenceImageUrls)
  const useInlineVoice = !publicMedia && adapter.provider === 'volcengine' && isSeedance25Model(record.model || config.model)
  const resolvedReferenceAudioUrls = directReferences ? params.referenceAudioUrls : useInlineVoice
    ? Promise.all((params.referenceAudioUrls || []).map(url =>
        /^\/?static\//u.test(url) ? inlineSeedanceVoice(url) : resolvePublicMediaUrl(url, 'audio'),
      ))
    : resolvePublicMediaUrls(params.referenceAudioUrls, 'audio')
  const [imageUrl, firstFrameUrl, lastFrameUrl, referenceVideoUrls, referenceAudioUrls, referenceFileUrl, referenceLinkUrl] = await Promise.all([
    resolveImage(params.imageUrl), resolveImage(params.firstFrameUrl), resolveImage(params.lastFrameUrl),
    directReferences ? params.referenceVideoUrls : resolvePublicMediaUrls(params.referenceVideoUrls, 'video'),
    resolvedReferenceAudioUrls,
    directReferences ? params.referenceFileUrl : resolvePublicMediaUrl(params.referenceFileUrl, 'file'),
    publicMedia ? resolvePublicMediaUrl(params.referenceLinkUrl, 'file') : params.referenceLinkUrl,
  ])
  return adapter.buildGenerateRequest(config, {
    id: record.id, model: record.model, prompt: record.prompt, referenceMode: params.referenceMode,
    imageUrl, firstFrameUrl, lastFrameUrl,
    referenceImageUrls: resolvedReferenceImageUrls?.length ? JSON.stringify(resolvedReferenceImageUrls) : null,
    referenceVideoUrls: referenceVideoUrls?.length ? JSON.stringify(referenceVideoUrls) : null,
    referenceAudioUrls: referenceAudioUrls?.length ? JSON.stringify(referenceAudioUrls) : null,
    referenceFileUrl, referenceLinkUrl, generateAudio: params.generateAudio, duration: params.duration,
    aspectRatio: params.aspectRatio, resolution: params.resolution, seed: params.seed,
    promptExtend: params.promptExtend, watermark: params.watermark,
  })
}

/** Build and validate the provider submission locally, without enqueuing a task or sending it. */
export async function validateVideoSubmissionRequest(config: AIConfig, params: GenerateVideoParams): Promise<void> {
  if (config.provider === 'jimeng') return validateJimengVideo(params, config)
  if (config.provider === 'libtv') {
    validateLibTVVideo({ ...params, model: config.model })
    return
  }
  if (config.provider === 'comfyui') {
    // ComfyUI uses upload-generated filenames. Validate the same workflow with placeholders locally.
    const names = (params.referenceImageUrls || []).map((_, index) => `reference-${index}.png`)
    buildComfyWorkflow(config, 'video', { prompt: params.prompt, aspectRatio: params.aspectRatio,
      duration: params.duration, seed: params.seed, assetType: 'storyboard' }, names)
    return
  }
  await buildVideoProviderRequest(config, { id: 0, model: params.model, prompt: params.prompt }, videoTaskInputs(params, config.provider))
}

async function createTask(
  type: TaskType,
  config: AIConfig,
  fields: {
    storyboardId?: number
    dramaId?: number
    sceneId?: number
    characterId?: number
    propId?: number
    prompt: string
    model?: string | null
  },
  params: Record<string, unknown>,
  control?: VideoSubmissionControl,
): Promise<number> {
  control?.signal.throwIfAborted()
  const ts = now()
  const res = db.transaction(tx => {
    const voice = params.scriptVideoVoice as ScriptVideoVoiceRequest | undefined
    if (voice && activeVoiceTask(tx, voice)) throw voiceGenerationActive()
    if (fields.storyboardId) {
      const shot = tx.select({ id: schema.storyboards.id, deletedAt: schema.storyboards.deletedAt })
        .from(schema.storyboards).where(eq(schema.storyboards.id, fields.storyboardId)).get()
      if (!shot || shot.deletedAt) throw new Error('镜头不存在')
    }
    if (params.galleryAspect && !params.scriptVideoAsset) {
      const target = fields.characterId ? { table: schema.characters, id: fields.characterId }
        : fields.sceneId ? { table: schema.scenes, id: fields.sceneId }
          : fields.propId ? { table: schema.props, id: fields.propId } : null
      if (!target || fields.dramaId === undefined) throw new Error('项目资产不存在')
      const saved = tx.update(target.table).set({
        finalPrompt: fields.prompt, imageModel: fields.model, imageConfigId: config.id, updatedAt: ts,
      }).where(and(eq(target.table.id, target.id), eq(target.table.dramaId, fields.dramaId), isNull(target.table.deletedAt))).run()
      if (!saved.changes) throw new Error('项目资产不存在')
    }
    return tx.insert(schema.sysTask).values({
      type,
      ...fields,
      provider: config.provider,
      configId: config.id,
      configBaseUrl: config.baseUrl,
      stage: control ? 'preparing' : 'submitting',
      params: JSON.stringify(params),
      status: 'processing',
      createdAt: ts,
      updatedAt: ts,
    }).run()
  })

  const id = getInsertId(res)
  control?.onTaskCreated(id)
  runBackground(id, () => withApiCallContext({ taskId: id, dramaId: fields.dramaId, provider: config.provider, model: fields.model || config.model, category: type }, () => processTask(id, config)))
  return id
}

function parseTaskParams(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) || {}
  } catch {
    return {}
  }
}

async function processTask(id: number, config: AIConfig) {
  let submittedVideoRequest = false
  try {
    const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    if (!record || record.status === 'canceled') return
    const type = record.type as TaskType
    const label = taskLabel(type)
    const params = parseTaskParams(record.params)
    // A scoped video can be stopped until the last point before sending the
    // chargeable request. After this transition, a lost response is ambiguous.
    function beginSubmission(stage = 'submitting') {
      if (record.stage !== 'preparing') return
      const dispatched = db.update(schema.sysTask).set({ stage, updatedAt: now() })
        .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.status, 'processing'), eq(schema.sysTask.stage, 'preparing'))).run()
      if (!dispatched.changes) throw new DOMException('视频生成已取消', 'AbortError')
    }
    if (config.provider === 'jimeng') {
      const input = params.jimeng as JimengVideoRunInput | undefined
      if (!input) throw new Error('缺少即梦视频草稿')
      const stored = db.update(schema.sysTask).set({ taskId: input.submitId, updatedAt: now() })
        .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.status, 'processing'))).run()
      if (!stored.changes) return
      try {
        await runJimengVideo(input, () => beginSubmission())
      } catch (error) {
        const uncertain = !(error instanceof JimengCliError) || error.possiblySubmitted
        await failTask(id, safeTaskError(error), uncertain ? 'submission_unknown' : 'submission_not_sent')
        return
      }
      await markPolling(id, input.submitId)
      await pollJimengTask(record, input)
      return
    }
    if (config.provider === 'libtv') {
      const createdAt = Date.parse(record.createdAt || '')
      const deadline = (Number.isFinite(createdAt) ? createdAt : Date.now()) + LIBTV_GENERATION_TIMEOUT_MS
      await withLibTVAccount(params.videoCliAccountId || 'default', () => withLibTVCanvas(async () => {
        if (Date.now() >= deadline) throw new LibTVCliError('LibTV 排队等待超时，尚未提交生成，请稍后重试', false, 'timeout')
        const node = await createLibTVVideoNode({
          ...params, model: record.model || config.model, prompt: record.prompt || '', generateAudio: params.generateAudio !== 0,
        }, id).catch(async error => {
          await failTask(id, safeTaskError(error), 'submission_not_sent')
        })
        if (!node) return
        // Store the original canvas/node before the only potentially billable invocation.
        record.taskId = node.nodeKey
        record.params = JSON.stringify({ ...params, libtv: node })
        await db.update(schema.sysTask).set({
          taskId: record.taskId, params: record.params,
          stage: record.stage === 'preparing' ? 'preparing' : 'polling', updatedAt: now(),
        }).where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled')))
        if (Date.now() >= deadline) {
          await failTask(id, 'LibTV 准备素材超时，尚未提交生成，请稍后重试', 'submission_not_sent')
          return
        }
        beginSubmission('polling')
        let url: string | undefined
        let submissionFailure: string | undefined
        try { url = await runLibTVVideo(node, Math.max(1, deadline - Date.now())) } catch (error) {
          if (error instanceof LibTVCliError && error.terminal) {
            await failTask(id, safeTaskError(error), 'generation_failed')
            return
          }
          submissionFailure = safeTaskError(error)
        }
        if (url) await handleVideoComplete(record, url, params.duration)
        else await recoverLibTVNode(record, node, submissionFailure)
      }, Math.max(1, deadline - Date.now())))
      return
    }
    if (config.provider === 'comfyui') {
      if (type === 'video' && (params.referenceVideoUrls?.length || params.referenceAudioUrls?.length || params.referenceFileUrl || params.referenceLinkUrl || params.firstFrameUrl || params.lastFrameUrl)) {
        throw new Error('当前 ComfyUI 工作流支持文生视频和参考图生视频；请使用参考图片，暂不支持视频、音频或首尾帧模式')
      }
      const refs = type === 'image' ? params.referenceImages || [] : params.referenceImageUrls?.length ? params.referenceImageUrls : params.imageUrl ? [params.imageUrl] : []
      const comfyConfig = { ...config, model: record.model || config.model }
      const taskId = await submitComfyWorkflow(comfyConfig, type, {
        prompt: record.prompt || '', size: params.size, aspectRatio: params.aspectRatio,
        duration: params.duration, seed: params.seed,
        assetType: record.sceneId ? 'scene' : record.characterId ? 'character' : record.propId ? 'prop' : 'storyboard',
      }, refs, async (promptId, built) => {
        // Persist before POST so an interrupted response can be reconciled by the original ID.
        params.comfyui = { outputNode: built.outputNode, duration: built.duration, width: built.width, height: built.height, preset: built.preset, sourceHash: built.sourceHash }
        record.params = JSON.stringify(params)
        await db.update(schema.sysTask).set({ taskId: promptId, params: record.params, updatedAt: now() })
          .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled')))
        beginSubmission()
      })
      await markPolling(id, taskId)
      await pollTask(record, comfyConfig, taskId)
      return
    }
    logTaskProgress(label, 'build-request', {
      id,
      provider: config.provider,
      storyboardId: record.storyboardId,
      sceneId: record.sceneId,
      characterId: record.characterId,
    })

    let url: string, method: string, headers: Record<string, string>, body: unknown
    const publicMedia = !!process.env.PUBLIC_BASE_URL?.trim()

    if (type === 'image') {
      const model = record.model || config.model
      const adapter = getImageAdapter(config, model)
      const supportsPublicImage = (url?: string) => !!adapter.supportsReferenceImageUrls?.(config, model, url)
      const resolvedReferenceImages = isMidjourneyBlend({ ...config, model })
        ? await resolvePublicMediaUrls(params.referenceImages, 'image', { matchImageExtension: true })
        : await normalizeReferenceImages(params.referenceImages, publicMedia && supportsPublicImage() ? supportsPublicImage : undefined)
      ;({ url, method, headers, body } = adapter.buildGenerateRequest(config, {
        id: record.id,
        model: record.model,
        prompt: record.prompt,
        size: params.size,
        frameType: params.frameType,
        referenceImages: resolvedReferenceImages.length ? JSON.stringify(resolvedReferenceImages) : null,
      }))
    } else {
      ;({ url, method, headers, body } = await buildVideoProviderRequest(config, record, params))
    }

    logTaskProgress(label, 'request', {
      id,
      provider: config.provider,
      method,
      url: redactUrl(url),
      model: record.model,
    })

    const isMultipart = body instanceof FormData
    logTaskPayload(label, 'request payload', {
      id, method, url, headers,
      // multipart 表单（如 OpenAI /v1/images/edits）无法 JSON 化，记录字段摘要
      body: isMultipart ? `[multipart/form-data: ${[...(body as FormData).keys()].join(', ')}]` : body,
    })

    if (type === 'video') beginSubmission()
    submittedVideoRequest = type === 'video'
    const resp = await fetch(url, {
      method,
      headers,
      body: isMultipart ? (body as FormData) : JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    }).catch(error => {
      if (submittedVideoRequest && config.provider.toLowerCase() === 'aicost' && isPreTlsConnectionReset(error)) return null
      throw error
    })
    if (!resp) {
      await failTask(id, VIDEO_REQUEST_NOT_SENT_MESSAGE, 'submission_not_sent')
      return
    }

    // Firemux 在响应头提供内部任务编号；即使 JSON 响应体中断也能查询原任务。
    const gatewayTaskId = resp.headers.get('X-Firemux-Task-Id') || resp.headers.get('X-Huobao-Task-Id')
    if (type === 'video' && gatewayTaskId) {
      await markPolling(id, gatewayTaskId)
      record.taskId = gatewayTaskId
    }

    if (!resp.ok) {
      const raw = await resp.text()
      if (submittedVideoRequest && !gatewayTaskId && config.provider.toLowerCase() === 'aicost') {
        const rejection = aicostVideoSubmissionRejection(resp.status, parseTaskParams(raw), record.model)
        if (rejection) {
          await failTask(id, rejection, 'submission_rejected')
          return
        }
      }
      throw new Error(`API error ${resp.status}: ${raw}`)
    }
    const result = await resp.json() as any
    logTaskPayload(label, 'response payload', { id, provider: config.provider, result })

    if (type === 'image') {
      const adapter = getImageAdapter(config, record.model || config.model)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync) {
        const base64 = adapter.extractImageBase64(result)?.data
        if (!imageUrl && !base64) throw new Error('No image URL or base64 data in response')
        await saveImageResult(record, { imageUrl, base64 })
        return
      }

      await markPolling(id, taskId)
      await pollTask(record, config, taskId!)
      return
    }

    const adapter = getVideoAdapter(config.provider)
    const { isAsync, taskId, videoUrl, duration } = adapter.parseGenerateResponse(result)
    if (taskId) {
      await markPolling(id, taskId)
      record.taskId = taskId
    }

    if (!isAsync && videoUrl) {
      logTaskProgress(label, 'sync-complete', { id, videoUrl })
      const delivery = resolveVideoDownload(config, taskId, videoUrl)
      await handleVideoComplete(record, videoUrl, duration ?? params.duration, delivery?.headers)
      return
    }

    await markPolling(id, taskId)
    await pollTask(record, config, taskId!)
  } catch (err: any) {
    const [current] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
    const uncertain = submittedVideoRequest && current?.type === 'video' && !current.resultUrl
      && (err instanceof TypeError || err instanceof SyntaxError || /timeout|abort|No task_id|API error 5/i.test(err.message))
    await failTask(id, safeTaskError(err), uncertain ? 'submission_unknown'
      : current?.provider === 'libtv' && !current.taskId && err instanceof LibTVCliError ? 'submission_not_sent' : undefined)
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  const updated = db.update(schema.sysTask)
    .set({ taskId, stage: 'polling', status: 'processing', updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled'), ne(schema.sysTask.status, 'completed'))).run().changes > 0
  if (updated) logTaskProgress('SysTask', 'poll-start', { id, taskId })
  return updated
}

async function failTask(id: number, message: string, code?: string) {
  message = safeTaskError(message)
  logTaskError('SysTask', 'failed', { id, error: message })
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: safeTaskError(message), ...(code ? { errorCode: code } : {}), updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled'), ne(schema.sysTask.status, 'completed')))
  scheduleRetiredUploadCleanup()
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

export function cancelUnsubmittedVideoTask(id: number) {
  const canceled = db.update(schema.sysTask).set({ status: 'canceled', stage: 'canceled', updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.status, 'processing'), eq(schema.sysTask.stage, 'preparing'))).run().changes > 0
  if (canceled) scheduleRetiredUploadCleanup()
  return canceled
}

export async function cancelDispatchedVideoTask(id: number) {
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record || record.type !== 'video' || record.provider !== 'aliyun' ||
      record.status !== 'processing' || !record.taskId || record.resultUrl) return false
  const config = await recoveryConfig(record).catch(() => null)
  if (!config || !await cancelUpstreamVideo(config, record.taskId)) return false
  const canceled = db.update(schema.sysTask).set({ status: 'canceled', stage: 'canceled', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'completed'))).run().changes > 0
  if (canceled) scheduleRetiredUploadCleanup()
  return canceled
}

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string, recover = false) {
  return withApiCallContext({ taskId: record.id, dramaId: record.dramaId || undefined, provider: config.provider, model: record.model || config.model, category: record.type }, () => pollTaskResponse(record, config, taskId, recover))
}

async function pollTaskResponse(record: SysTaskRecord, config: AIConfig, taskId: string, recover: boolean) {
  if (config.provider === 'jimeng') {
    const input = parseTaskParams(record.params).jimeng as JimengVideoRunInput | undefined
    if (!input || input.submitId !== taskId) throw new Error('未找到原即梦提交信息')
    return pollJimengTask(record, input)
  }
  if (config.provider === 'libtv') {
    const node = parseTaskParams(record.params).libtv as LibTVNode | undefined
    if (!node || node.nodeKey !== taskId) throw new Error('未找到原 LibTV 画布节点')
    return recoverLibTVNode(record, node)
  }
  if (config.provider === 'comfyui') return pollComfyTask(record, config, taskId)
  const type = record.type as TaskType
  const label = taskLabel(type)
  const profile = config.provider === 'aicost' && type === 'video'
    ? { ...POLL_PROFILES.video, intervalMs: 5_000, attempts: 600 }
    : POLL_PROFILES[type]
  const adapter = type === 'image' ? getImageAdapter(config, record.model || config.model) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    if (!recover || i > 0) await new Promise(r => setTimeout(r, profile.intervalMs))
    if (type === 'video' && db.select({ status: schema.sysTask.status }).from(schema.sysTask)
      .where(eq(schema.sysTask.id, record.id)).get()?.status === 'canceled') return
    try {
      const { url, method, headers } = adapter.buildPollRequest(config, taskId)
      logTaskProgress(label, 'poll-request', {
        id: record.id,
        taskId,
        provider: config.provider,
        method,
        url: redactUrl(url),
        attempt: i + 1,
      })
      const remainingMs = profile.maxDurationMs
        ? Math.max(1_000, profile.maxDurationMs - (Date.now() - startedAt))
        : 600_000
      const resp = await fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(remainingMs),
      })
      if (!resp.ok) continue
      const result = await resp.json() as any

      // 图片/视频 PollResponse 结构不同，这里统一按 any 取值后按 type 分支
      const pollResp: any = adapter.parsePollResponse(result)
      if (type === 'video' && pollResp.stage === 'transferring') {
        await db.update(schema.sysTask).set({ stage: 'transferring', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
      }

      if (pollResp.status === 'completed') {
        if (type === 'image') {
          const imageUrl = pollResp.imageUrl
          const base64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)?.data
          if (imageUrl || base64) {
            await saveImageResult(record, { imageUrl, base64 })
            return
          }
        } else {
          const delivery = resolveVideoDownload(config, taskId, pollResp.videoUrl)
          if (delivery) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, videoUrl: delivery.url })
            await handleVideoComplete(record, delivery.url, pollResp.duration, delivery.headers)
            return
          }
        }
      }
      if (pollResp.status === 'failed') {
        // 上游明确失败（如内容审核拦截）属终态：立即落库，不重试不等待超时
        const deliveryFailed = /video_transfer_failed/.test(pollResp.error || '')
        if (deliveryFailed) await db.update(schema.sysTask).set({ stage: 'transferring' }).where(eq(schema.sysTask.id, record.id))
        await failTask(record.id, pollResp.error || 'Generation failed', deliveryFailed ? 'delivery_failed' : 'generation_failed')
        return
      }
    } catch (err: any) {
      const exhausted = i === profile.attempts - 1
        || (profile.maxDurationMs != null && Date.now() - startedAt >= profile.maxDurationMs)
      if (exhausted) {
        await failTask(record.id, `Timeout: ${err.message}`, type === 'video' ? 'poll_timeout' : undefined)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted', type === 'video' ? 'poll_timeout' : undefined)
}

async function recoverLibTVNode(record: SysTaskRecord, node: LibTVNode, submissionFailure?: string) {
  let result: Awaited<ReturnType<typeof inspectLibTVVideoStatus>>
  try { result = await inspectLibTVVideoStatus(node) } catch (error) {
    await failTask(record.id, [submissionFailure, safeTaskError(error)].filter(Boolean).join('；'),
      error instanceof LibTVCliError && error.terminal ? 'generation_failed' : 'submission_unknown')
    return
  }
  if (result.upstreamTaskId && node.upstreamTaskId !== result.upstreamTaskId) {
    node.upstreamTaskId = result.upstreamTaskId
    record.params = JSON.stringify({ ...parseTaskParams(record.params), libtv: node })
    await db.update(schema.sysTask).set({ params: record.params, updatedAt: now() })
      .where(and(eq(schema.sysTask.id, record.id), ne(schema.sysTask.status, 'canceled')))
  }
  if (result.state === 'completed' && result.url) {
    await handleVideoComplete(record, result.url, parseTaskParams(record.params).duration)
  } else if (result.state === 'failed') {
    await failTask(record.id, result.message || 'LibTV 已确认原视频任务失败', 'generation_failed')
  } else {
    const pending = result.state === 'pending'
      ? 'LibTV 原任务仍在排队或生成，站内已停止本次等待。可点击「查询原任务」获取结果，不会重新生成。'
      : '暂未确认 LibTV 原任务结果。可点击「查询原任务」继续查询，不会重新生成。'
    await failTask(record.id, [submissionFailure, result.message, pending].filter(Boolean).join('；'), 'submission_unknown')
  }
}

async function pollJimengTask(record: SysTaskRecord, input: JimengVideoRunInput) {
  const profile = POLL_PROFILES.video
  let lastError = ''
  for (let attempt = 0; attempt < profile.attempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, profile.intervalMs))
    let operation: Awaited<ReturnType<typeof inspectJimengVideo>>
    try {
      operation = await inspectJimengVideo(input.projectId, input.submitId, input.profileId)
    } catch (error) {
      lastError = safeTaskError(error)
      continue
    }
    if (operation.state === 'failed') {
      await failTask(record.id, operation.message || '即梦生成失败', 'generation_failed')
      return
    }
    if (operation.state !== 'completed' || !operation.resourceId) continue
    const duration = operation.duration ?? parseTaskParams(record.params).duration
    const localPath = `static/videos/jimeng-${input.submitId}.mp4`
    try {
      const folder = path.join(STORAGE_ROOT, 'videos')
      await mkdir(folder, { recursive: true })
      await db.update(schema.sysTask).set({ stage: 'downloading', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
      if (!fs.existsSync(getAbsolutePath(localPath))) {
        const temporary = await mkdtemp(path.join(folder, '.jimeng-'))
        try {
          const output = path.join(temporary, 'result.mp4')
          await downloadJimengVideo(input.projectId, operation.resourceId, output, input.profileId)
          if (!(await stat(output)).size) throw new Error('即梦返回了空视频文件')
          await rename(output, getAbsolutePath(localPath))
        } finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}) }
      }
      await saveCompletedVideo(record, localPath, duration)
    } catch (error) {
      await failTask(record.id, safeTaskError(error), 'delivery_failed')
    }
    return
  }
  await failTask(record.id, lastError || '即梦任务仍未返回结果，可恢复原任务继续查询', 'poll_timeout')
}

function resolveVideoDownload(config: AIConfig, taskId?: string | null, videoUrl?: string) {
  const endpoint = taskId ? getVideoAdapter(config.provider).buildDownloadRequest?.(config, taskId) : undefined
  if (!videoUrl || videoUrl === endpoint?.url) return endpoint
  return { url: videoUrl, headers: undefined }
}

async function pollComfyTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  const params = parseTaskParams(record.params)
  const outputNode = params.comfyui?.outputNode
  if (!outputNode) throw new Error('ComfyUI 任务缺少输出节点记录')
  const deadline = Date.now() + (config.comfyui?.timeoutMinutes || 120) * 60_000
  let lastError = ''
  while (Date.now() < deadline) {
    let result
    try {
      result = await pollComfyWorkflow(config, taskId, outputNode, record.type as TaskType)
      lastError = ''
    } catch (error: any) { lastError = safeTaskError(error) }
    if (result?.status === 'failed') {
      await failTask(record.id, result.error || 'ComfyUI 执行失败', 'generation_failed')
      return
    }
    if (result?.status === 'completed' && result.url) {
      if (record.type === 'image') await saveImageResult(record, { imageUrl: result.url, headers: comfyHeaders(config) })
      else await handleVideoComplete(record, result.url, params.comfyui.duration, comfyHeaders(config))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  await failTask(record.id, `ComfyUI 等待超时，上游任务可能仍在运行，请勿重复提交。${lastError}`, 'polling_timeout')
}

class InvalidGeneratedImage extends Error {
  constructor(message: string, public aspectMismatch = false) { super(message) }
}

async function saveImageResult(record: SysTaskRecord, source: {
  imageUrl?: string | null; base64?: string; headers?: Record<string, string>
}) {
  const { imageUrl, base64, headers } = source
  const task = schema.sysTask
  let localPath = record.localPath && fs.existsSync(getAbsolutePath(record.localPath)) ? record.localPath : null
  let thumbnail: Buffer | undefined
  // 上游已出图，先保存交付地址，下载或保存中断时可取回同一张图。
  db.update(task).set({ status: 'processing', stage: base64 || localPath ? 'saving' : 'downloading',
    resultUrl: imageUrl, localPath, errorMsg: null, errorCode: null, updatedAt: now() }).where(eq(task.id, record.id)).run()
  try {
    if (!localPath) {
      let image: Awaited<ReturnType<typeof prepareGeneratedImage>> | undefined
      if (typeof base64 === 'string' && base64) {
        try {
          image = await prepareGeneratedImage(record, Buffer.from(base64, 'base64'))
        } catch (error) {
          if (!(error instanceof InvalidGeneratedImage) || !imageUrl) throw error
        }
      }
      if (!image && imageUrl) {
        if (base64) db.update(task).set({ stage: 'downloading', updatedAt: now() }).where(eq(task.id, record.id)).run()
        image = await prepareGeneratedImage(record, await downloadImage(imageUrl, headers))
      }
      if (!image) throw new InvalidGeneratedImage('图片服务返回的文件无法读取，请重试或切换图片模型。')
      localPath = await saveUploadedFile(image.buffer, 'images', 'result' + image.extension)
      thumbnail = image.thumbnail
      db.update(task).set({ localPath, stage: 'saving', updatedAt: now() }).where(eq(task.id, record.id)).run()
    }

    await generateImageThumb(localPath, thumbnail)
    const completedPath = localPath
    db.transaction(tx => {
      writeBackImageAssets(tx, record, completedPath)
      tx.update(task).set({ status: 'completed', stage: 'completed', completedAt: now(), updatedAt: now() })
        .where(eq(task.id, record.id)).run()
    })
    logTaskSuccess('ImageTask', 'saved', { id: record.id, provider: record.provider, localPath })
    scheduleRetiredUploadCleanup()
  } catch (error) {
    if (error instanceof InvalidGeneratedImage && (error.aspectMismatch || !imageUrl)) {
      await failTask(record.id, error.message, 'image_aspect_invalid')
    } else {
      deferImageDelivery(record.id, error)
    }
  }
}

function deferImageDelivery(id: number, error: unknown) {
  logTaskWarn('ImageTask', 'delivery-pending', { id, error: safeTaskError(error) })
  const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
  db.update(schema.sysTask).set({ status: 'delivery_pending', errorCode: 'image_delivery_pending',
    errorMsg: timeout ? '图片已生成，原图下载超时。' : '图片已生成，暂未保存到资产。', updatedAt: now() })
    .where(eq(schema.sysTask.id, id)).run()
  scheduleRetiredUploadCleanup()
}

async function prepareGeneratedImage(record: SysTaskRecord, buffer: Buffer) {
  const params = parseTaskParams(record.params)
  const galleryAspect = isGalleryImageAspect(params.galleryAspect) ? params.galleryAspect : undefined
  const image = sharp(buffer)
  const metadata = await image.metadata().catch(() => undefined)
  const { width, height } = metadata?.autoOrient ?? metadata ?? {}
  if (!width || !height) throw new InvalidGeneratedImage('图片服务返回的文件无法读取，请重试或切换图片模型。')
  const extension = imageExtensionFromMetadata(metadata, '')
  let needsEncoding = !extension
  if (galleryAspect) {
    const [w, h] = galleryAspect.split(':').map(Number)
    const scale = Math.floor(Math.min(width / w, height / h))
    if (scale === 0) throw new InvalidGeneratedImage('模型返回的尺寸太小，无法裁成所选比例。', true)
    if (width !== w * scale || height !== h * scale) {
      image.autoOrient().resize(w * scale, h * scale, { fit: 'cover', position: 'centre' })
      needsEncoding = true
    }
  } else if (params.requireLandscape16x9 && Math.abs(height - width * 9 / 16) > 1) {
    throw new InvalidGeneratedImage(`图片为 ${width}×${height}，比例不符。请在右上角设置启用支持 16:9 横图的图片模型。`, true)
  }
  if (!extension) image.png()
  try {
    const prepared = needsEncoding ? await image.toBuffer() : buffer
    // 生成缩略图时同时验证像素可解码，避免把只有图片头的截断响应写成成品。
    const thumbnail = await imageThumbnail(prepared).toBuffer()
    return { buffer: prepared, extension: extension || '.png', thumbnail }
  } catch {
    throw new InvalidGeneratedImage('无法读取模型返回的原图。')
  }
}

// 在同一事务里保存任务与资产。旧任务取回的原图留在历史记录中。
function writeBackImageAssets(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  const task = schema.sysTask
  const newer = (field: 'storyboardId' | 'characterId' | 'sceneId' | 'propId', id: number) =>
    tx.select({ params: task.params }).from(task).where(and(eq(task.type, 'image'), eq(task[field], id), gt(task.id, record.id))).all()
  const frameField = (frameType: unknown) =>
    frameType === 'first_frame' ? 'firstFrameImage' : frameType === 'last_frame' ? 'lastFrameImage' : 'composedImage'
  const frame = frameField(params.frameType)
  if (record.storyboardId && !newer('storyboardId', record.storyboardId)
    .some(row => frameField(parseTaskParams(row.params).frameType) === frame)) {
    tx.update(schema.storyboards).set({ [frame]: localPath, updatedAt: now() })
      .where(and(eq(schema.storyboards.id, record.storyboardId), isNull(schema.storyboards.deletedAt))).run()
  }
  if (record.characterId && !newer('characterId', record.characterId).length) {
    tx.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() })
      .where(and(eq(schema.characters.id, record.characterId), isNull(schema.characters.deletedAt))).run()
  }
  if (record.sceneId && !newer('sceneId', record.sceneId).length) {
    tx.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() })
      .where(and(eq(schema.scenes.id, record.sceneId), isNull(schema.scenes.deletedAt))).run()
  }
  if (record.propId && !newer('propId', record.propId).length) {
    tx.update(schema.props).set({ imageUrl: localPath, updatedAt: now() })
      .where(and(eq(schema.props.id, record.propId), isNull(schema.props.deletedAt))).run()
  }
}

async function handleVideoComplete(record: SysTaskRecord, videoUrl: string, duration: number | null | undefined, headers?: Record<string, string>) {
  // 先落库地址与实际时长；后续下载失败仍可恢复，且不重新提交生成。
  const params = { ...parseTaskParams(record.params), resultDuration: duration }
  await db.update(schema.sysTask).set({ resultUrl: videoUrl, params: JSON.stringify(params),
    stage: 'downloading', status: 'processing', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))
  try {
    const localPath = record.localPath && fs.existsSync(getAbsolutePath(record.localPath))
      ? record.localPath : await downloadVideo(videoUrl, record.id, { headers })
    await saveCompletedVideo(record, localPath, duration)
  } catch (error) {
    await failTask(record.id, safeTaskError(error), 'delivery_failed')
  }
}

async function saveCompletedVideo(record: SysTaskRecord, localPath: string, duration: number | null | undefined) {
  await db.update(schema.sysTask).set({ localPath, stage: 'saving', updatedAt: now() }).where(eq(schema.sysTask.id, record.id))
  const voice = scriptVideoVoiceRequest(record.params)
  if (voice) {
    try {
      await saveGeneratedCharacterVoice(voice, localPath)
    } catch (error) {
      await failTask(record.id, safeTaskError(error), 'voice_delivery_failed')
      return
    }
  } else await extractVideoPoster(localPath)
  // 恢复旧任务不能覆盖用户后来生成的视频。
  db.transaction(tx => {
    const newer = record.storyboardId ? tx.select({ id: schema.sysTask.id }).from(schema.sysTask)
      .where(and(eq(schema.sysTask.storyboardId, record.storyboardId), eq(schema.sysTask.type, 'video'), gt(schema.sysTask.id, record.id))).get() : null
    if (record.storyboardId && !newer) tx.update(schema.storyboards)
      .set({ videoUrl: localPath, duration: duration || undefined, updatedAt: now() })
      .where(eq(schema.storyboards.id, record.storyboardId)).run()
    tx.update(schema.sysTask).set({ localPath, status: 'completed', stage: 'completed', errorCode: null,
      errorMsg: null, completedAt: now(), updatedAt: now() }).where(eq(schema.sysTask.id, record.id)).run()
  })
  scheduleRetiredUploadCleanup()
}

async function recoveryConfig(record: SysTaskRecord): Promise<AIConfig> {
  if (record.configId) {
    const config = await getConfigById(record.configId)
    if (config && config.provider === record.provider && config.baseUrl === record.configBaseUrl) return config
    throw new Error(record.type === 'image' ? '原图片服务配置不可用，请恢复原配置' : '原视频服务配置已删除、停用或地址变更，请恢复原配置')
  }
  // 旧任务只在同厂商唯一配置时恢复，绝不任意换服务商查询。
  const rows = (await db.select().from(schema.aiServiceConfigs)).filter(c => c.isActive && c.serviceType === record.type && c.provider === record.provider)
  if (rows.length === 1) {
    const config = await getConfigById(rows[0].id)
    if (config) return config
  }
  throw new Error('历史任务无法确定原服务配置，请先核对配置')
}

function midjourneyTaskId(record: SysTaskRecord): string | null {
  const config = { provider: record.provider || '', baseUrl: record.configBaseUrl || '', model: record.model || '' }
  return isMidjourneyImageConfig(config) ? record.taskId : null
}

export async function recoverImageTask(id: number): Promise<void> {
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record || record.type !== 'image') throw new Error('图片任务不存在')
  if (activeTasks.has(id) || record.status === 'completed') return
  if (record.status === 'canceled' || ['generation_failed', 'image_aspect_invalid'].includes(record.errorCode || '')) {
    throw new Error('此任务没有可恢复的图片')
  }
  const hasLocalFile = record.localPath && fs.existsSync(getAbsolutePath(record.localPath))
  if (!record.resultUrl && !hasLocalFile) {
    const taskId = midjourneyTaskId(record)
    if (!taskId) throw new Error('此任务未保留可取回的原图')
    const config = await recoveryConfig(record)
    runBackground(id, async () => {
      await markPolling(id, taskId)
      await pollTask(record, config, taskId)
    })
    return
  }
  const headers = record.provider === 'comfyui' && !hasLocalFile
    ? comfyHeaders(await recoveryConfig(record)) : undefined
  runBackground(id, () => withApiCallContext({
    taskId: id, dramaId: record.dramaId || undefined, category: 'image',
    provider: record.provider || undefined, model: record.model || undefined,
  }, () => saveImageResult(record, { imageUrl: record.resultUrl, headers })))
}

export function canRecoverOriginalVideoTask(record: SysTaskRecord): boolean {
  if (record.type !== 'video' || !['processing', 'failed'].includes(record.status || '') ||
      ['generation_failed', 'submission_not_sent', 'submission_rejected'].includes(record.errorCode || '') ||
      !record.resultUrl && (!record.taskId?.trim() || record.stage === 'preparing')) return false
  if (!record.resultUrl && (record.provider === 'libtv' || record.provider === 'jimeng')) {
    const params = parseTaskParams(record.params)
    const projectId = /^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/iu
    if (record.provider === 'libtv') {
      const node = params.libtv
      if (node?.nodeKey !== record.taskId || !/^[\w][\w.-]{0,127}$/u.test(node.nodeKey) ||
          typeof node.projectId !== 'string' || !projectId.test(node.projectId)) return false
    } else {
      const operation = params.jimeng
      if (operation?.submitId !== record.taskId || !projectId.test(operation.submitId) ||
          typeof operation.projectId !== 'string' || !projectId.test(operation.projectId)) return false
    }
  }
  return record.status === 'processing' ||
    ['poll_timeout', 'polling_timeout', 'recovery_failed', 'delivery_failed', 'submission_unknown'].includes(record.errorCode || '') ||
    !record.errorCode && (record.stage === 'polling' && /^Timeout:/u.test(record.errorMsg || '') ||
      !!record.resultUrl && ['downloading', 'saving', 'transferring'].includes(record.stage || ''))
}

export async function resumeRecoverableVideoTask(record: SysTaskRecord): Promise<SysTaskRecord> {
  if (!canRecoverOriginalVideoTask(record)) return record
  const readTask = () => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, record.id)).get()
  const current = readTask()
  if (!current || !canRecoverOriginalVideoTask(current) || activeTasks.has(current.id)) return current ?? record
  if (current.status === 'failed' && Date.now() - Date.parse(current.updatedAt) < VIDEO_RECOVERY_RETRY_MS) return current
  try {
    await recoverStoredVideoTask(current)
  } catch (error) {
    await failTask(current.id, safeTaskError(error), 'recovery_failed')
  }
  return readTask() ?? current
}

export async function recoverVideoTask(id: number): Promise<void> {
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record || record.type !== 'video') throw new Error('视频任务不存在')
  return recoverStoredVideoTask(record)
}

async function recoverStoredVideoTask(record: SysTaskRecord): Promise<void> {
  const id = record.id
  if (record.status === 'canceled') throw new Error('视频任务已取消')
  if (activeTasks.has(id) || record.status === 'completed') return
  const voice = scriptVideoVoiceRequest(record.params)
  if (voice) {
    const task = schema.sysTask
    const newer = db.select({ id: task.id }).from(task).where(and(gt(task.id, id), scriptVideoVoiceTaskScope(voice))).get()
    if (newer) throw new Error('已有更新的角色声音生成任务，无法恢复这次生成')
  }
  if (!record.resultUrl && !record.taskId) throw new Error('未保存上游任务编号，请先核对上游记录，勿重复生成')
  if (record.errorCode === 'generation_failed') throw new Error('上游已确认生成失败，无法恢复原任务')
  if (['submission_not_sent', 'submission_rejected'].includes(record.errorCode || '')) throw new Error('视频请求未成功提交，无需查询原任务')
  // 在任何异步配置读取前获取锁，重复点击不会启动多个下载。
  activeTasks.add(id)
  try {
    if (record.storyboardId) {
      const shot = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, record.storyboardId)).get()
      if (!shot || shot.deletedAt) throw new Error('分镜已删除，请先从回收站恢复')
    }
    const config = record.taskId && !record.resultUrl ? await recoveryConfig(record) : null
    const originalParams = parseTaskParams(record.params)
    assertVideoCliNotDisconnecting(record.provider, originalParams.videoCliAccountId ?? originalParams[record.provider || '']?.profileId ?? 'default')
    const started = db.update(schema.sysTask).set({ status: 'processing', errorMsg: null, errorCode: null,
      stage: record.resultUrl ? 'downloading' : record.stage === 'transferring' || record.errorCode === 'delivery_failed' ? 'transferring' : 'polling', updatedAt: now() })
      .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled'), ne(schema.sysTask.status, 'completed'))).run()
    if (!started.changes) {
      activeTasks.delete(id)
      return
    }
    void (async () => {
      if (record.resultUrl) {
        let headers: Record<string, string> | undefined
        if (record.provider === 'comfyui') headers = comfyHeaders(await recoveryConfig(record))
        else if (record.provider && record.taskId && record.configBaseUrl) {
          const adapter = videoAdapters[record.provider.toLowerCase()]
          if (adapter?.buildDownloadRequest) {
            const savedEndpoint = adapter.buildDownloadRequest({
              provider: record.provider, baseUrl: record.configBaseUrl, apiKey: '', model: record.model || '',
            }, record.taskId)
            if (savedEndpoint.url === record.resultUrl) {
              headers = adapter.buildDownloadRequest(await recoveryConfig(record), record.taskId).headers
            }
          }
        }
        await handleVideoComplete(record, record.resultUrl, parseTaskParams(record.params).resultDuration, headers)
        const [fresh] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
        if (fresh?.status !== 'failed' || !record.taskId) return
        // 签名链接可能过期：重新查询原任务拿新地址。
      }
      const originalConfig = config ?? await recoveryConfig(record)
      // Firemux 的交付恢复是独立接口；只在其明确返回交付失败时调用。
      if (record.provider === 'minimax' && (record.errorCode === 'delivery_failed' || record.stage === 'transferring') && !record.resultUrl) {
        const req = getVideoAdapter('minimax').buildPollRequest(originalConfig, record.taskId!)
        const resp = await fetch(`${req.url}/recover`, { method: 'POST', headers: req.headers, signal: AbortSignal.timeout(30_000) })
        if (!resp.ok) throw new Error(`Video delivery recovery HTTP ${resp.status}`)
      }
      if (!await markPolling(id, record.taskId!)) return
      await pollTask(record, originalConfig, record.taskId!, true)
    })().catch(error => failTask(id, safeTaskError(error), 'recovery_failed')).finally(() => activeTasks.delete(id))
  } catch (error) {
    activeTasks.delete(id)
    throw error
  }
}

export async function resumeInterruptedTasks() {
  const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.status, 'processing')).orderBy(desc(schema.sysTask.id))
  for (const task of tasks) {
    if (task.type === 'image' && (task.resultUrl || task.localPath || task.stage === 'saving')) {
      try { await recoverImageTask(task.id) } catch (error) { deferImageDelivery(task.id, error) }
    } else if (task.type === 'image' && midjourneyTaskId(task)) {
      try { await recoverImageTask(task.id) } catch (error) { await failTask(task.id, safeTaskError(error), 'recovery_failed') }
    } else if (task.type === 'image' && task.provider === 'comfyui' && task.taskId) {
      runBackground(task.id, async () => {
        const config = await getConfigById(task.configId!)
        if (!config || config.provider !== 'comfyui' || config.baseUrl !== task.configBaseUrl) throw new Error('原 ComfyUI 配置不可用，请恢复原配置')
        await pollTask(task, config, task.taskId!)
      })
    } else if (task.type === 'video' && canRecoverOriginalVideoTask(task)) {
      await resumeRecoverableVideoTask(task)
    } else {
      await failTask(task.id, task.type === 'video' ? '服务中断，提交结果待确认，请先核对上游记录' : '服务重启，生成任务中断，请重试',
        task.type === 'video' ? 'submission_unknown' : 'interrupted')
    }
  }
}

// ─── 参考素材归一化 ───────────────────────────────────────────────

async function normalizeReferenceImages(refs: string[] | null | undefined, supportsPublicImage?: (url: string) => boolean): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []

  // Keep the explicit order: a missing main image must never promote another image
  // or silently turn an edit into a chargeable text-to-image request.
  const normalized = await Promise.all(refs.map(async (value) => {
    if (value.startsWith('data:image/')) return value
    if (supportsPublicImage) {
      const url = await resolvePublicMediaUrl(value, 'image')
      if (url && supportsPublicImage(url)) return url
    }
    if (value.startsWith('static/') || value.startsWith('/static/')) {
      const localPath = value.startsWith('/static/') ? value.slice(1) : value
      try {
        return await readImageAsCompressedDataUrl(localPath, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
        throw new Error('参考图文件无法读取，请重新上传或选择历史图片')
      }
    }
    // 远程 URL：下载压缩为 data URL，保证 multipart 上传（OpenAI edits）/ inline_data（Gemini）都可用
    if (/^https?:\/\//.test(value)) {
      try {
        return await fetchImageAsCompressedDataUrl(value, {
          maxWidth: 768,
          maxHeight: 768,
          quality: 68,
        })
      } catch (err) {
        logTaskWarn('ImageTask', 'reference-fetch-failed', { url: value, error: (err as Error).message })
        throw new Error('参考图下载失败，请检查地址或重新上传')
      }
    }
    return value
  }))

  return normalized
}

async function normalizeVideoReferenceUrl(value: string | null | undefined): Promise<string | null> {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('static/') || raw.startsWith('/static/')) {
    const localPath = raw.startsWith('/static/') ? raw.slice(1) : raw
    try {
      // 视频参考图直接编码原文件，保留原始尺寸、格式、透明通道和画质。
      return readImageAsDataUrl(localPath)
    } catch (err) {
      logTaskWarn('VideoTask', 'reference-read-failed', { path: localPath, error: (err as Error).message })
      throw new Error('视频参考图文件无法读取，请重新上传或选择历史图片')
    }
  }
  return raw
}

async function normalizeVideoReferenceUrls(refs: string[] | null | undefined): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const normalized = await Promise.all(
    Array.from(new Set(refs.map((item) => String(item || '').trim()).filter(Boolean))).map((item) => normalizeVideoReferenceUrl(item)),
  )
  return normalized.filter((item): item is string => !!item)
}

function normalizeStoredVideoResolution(resolution: string | null | undefined, provider: string): string | undefined {
  const value = String(resolution || '').trim().toLowerCase()
  if (provider === 'aicost') return value || undefined
  if (value === '480p' || value === '720p' || value === '1080p' || value === '4k') return value
  if (value === '2k') return '2K'
  return undefined
}
