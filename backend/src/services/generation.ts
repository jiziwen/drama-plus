/**
 * 统一生成任务服务 — 图片/视频生成共用 sys_task 表与同一条生命周期：
 * 创建(processing) → 适配器构建请求 → 同步完成或异步轮询 → 下载落盘 → 回写业务表
 */
import { isSeedance25Model } from './seedance-models.js'
import { inlineSeedanceVoice } from './seedance-reference-media.js'
import { db, getInsertId, schema } from '../db/index.js'
import { and, desc, eq, gt, ne } from 'drizzle-orm'
import fs from 'node:fs'
import { getAbsolutePath } from '../utils/storage.js'
import { downloadVideo, safeTaskError } from './video-download.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { now } from '../utils/response.js'
import { withImageTaskSubmission } from './image-submission.js'
import { assertImageMode, resolveMediaConfig, validateReferenceImages } from './media-selection.js'
import { downloadFile, fetchImageAsCompressedDataUrl, generateImageThumb, readImageAsCompressedDataUrl, readImageAsDataUrl, saveBase64Image } from '../utils/storage.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { getImageAdapter, getVideoAdapter, videoAdapters } from './adapters/registry'
import { aicostVideoSubmissionRejection } from './adapters/aicost-video.js'
import type { AIConfig, VideoGenerationRecord } from './adapters/types'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess, logTaskWarn, redactUrl } from '../utils/task-logger.js'
import { buildComfyWorkflow, comfyHeaders, submitComfyWorkflow, pollComfyWorkflow } from './comfyui.js'
import { recordedFetch as fetch, withApiCallContext } from './api-call-log.js'
import { resolvePublicMediaUrl, resolvePublicMediaUrls } from './public-media.js'
import { isPreTlsConnectionReset } from '../utils/network-error.js'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import { downloadJimengVideo, inspectJimengVideo, JimengCliError, runJimengVideo, type JimengVideoRunInput } from './jimeng-cli.js'
import { claimJimengVideoQuote, quoteJimengVideo, validateJimengVideo } from './jimeng-video.js'
import { createLibTVVideoNode, inspectLibTVVideo, LibTVCliError, libtvProjectId, runLibTVVideo, validateLibTVVideo, withLibTVCanvas, type LibTVNode } from './libtv-cli.js'
import { assertVideoCliNotDisconnecting } from './video-cli-tasks.js'
import { cancelUpstreamVideo } from './video-upstream-cancel.js'

type TaskType = 'image' | 'video'

export const VIDEO_REQUEST_NOT_SENT_MESSAGE = '连接视频服务时 TLS 握手断开，生成请求未送达，可直接重试。'

const activeTasks = new Set<number>()
export function isGenerationTaskActive(id: number): boolean { return activeTasks.has(id) }
const videoSubmissions = new Set<number>()
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

interface GenerateImageParams {
  storyboardId?: number
  dramaId?: number
  sceneId?: number
  characterId?: number
  propId?: number
  prompt: string
  model?: string
  size?: string
  referenceImages?: string[]
  frameType?: string
  configId?: number
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
  jimengQuoteId?: string
  jimengScope?: string
  allowLibTV?: boolean
}

export async function generateImage(params: GenerateImageParams): Promise<number> {
  return withImageTaskSubmission(params, () => enqueueImage(params))
}

async function enqueueImage(params: GenerateImageParams): Promise<number> {
  const config = await resolveMediaConfig('image', params)
  const referenceImages = params.referenceImages === undefined ? [] : validateReferenceImages(params.referenceImages)
  assertImageMode(config, referenceImages.length ? 'reference' : 'text')

  const id = await createTask('image', config, {
    storyboardId: params.storyboardId,
    dramaId: params.dramaId,
    sceneId: params.sceneId,
    characterId: params.characterId,
    propId: params.propId,
    prompt: params.prompt,
    model: params.model || config.model,
  }, {
    size: params.size || (config.provider === 'comfyui' ? undefined : '1920x1080'),
    frameType: params.frameType,
    referenceImages,
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

export type VideoSubmissionControl = {
  signal: AbortSignal
  onTaskCreated: (taskId: number) => void
}

export async function generateVideo(params: GenerateVideoParams, control?: VideoSubmissionControl): Promise<number> {
  const storyboardId = params.storyboardId
  if (storyboardId && videoSubmissions.has(storyboardId)) throw new Error('该分镜正在提交任务，请勿重复点击')
  if (storyboardId) videoSubmissions.add(storyboardId)
  try {
    if (storyboardId) {
      const [latest] = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.type, 'video'), eq(schema.sysTask.storyboardId, storyboardId)))
        .orderBy(desc(schema.sysTask.id)).limit(1)
      if (latest?.status === 'processing') throw new Error('该分镜已有运行中的任务，请等待结果')
      if (latest?.status === 'failed' && params.forceNew !== true) throw new Error('请先恢复原任务；重新生成需确认可能再次计费')
    }
    const config = await resolveMediaConfig('video', params)
    if (config.provider === 'libtv') {
      if (!params.allowLibTV) throw new Error('请通过私有站点的「剧本转视频」使用 LibTV')
      await libtvProjectId()
      validateLibTVVideo({ ...params, model: config.model })
    }
    control?.signal.throwIfAborted()
    assertVideoCliNotDisconnecting(config.provider)
    const jimeng = config.provider === 'jimeng' ? claimJimengVideoQuote(params, config) : undefined

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
      params: { ...params, jimengQuoteId: undefined },
    })
    return id
  } finally {
    if (storyboardId) videoSubmissions.delete(storyboardId)
  }
}

export async function quoteVideo(params: GenerateVideoParams) {
  const config = await resolveMediaConfig('video', params)
  if (config.provider !== 'jimeng') throw new Error('请选择「即梦积分」视频模型以获取报价')
  return quoteJimengVideo(params, config)
}

function videoTaskInputs(params: GenerateVideoParams, provider: string) {
  const { referenceMode, imageUrl, firstFrameUrl, lastFrameUrl, referenceImageUrls, referenceVideoUrls, referenceAudioUrls,
    referenceFileUrl, referenceLinkUrl, generateAudio, duration, aspectRatio, resolution, seed, promptExtend, watermark } = params
  return {
    referenceMode: referenceMode || 'reference',
    imageUrl, firstFrameUrl, lastFrameUrl, referenceImageUrls, referenceVideoUrls, referenceAudioUrls, referenceFileUrl,
    referenceLinkUrl, generateAudio: generateAudio === false ? 0 : 1, duration, aspectRatio,
    resolution: normalizeStoredVideoResolution(resolution, provider), seed, promptExtend, watermark,
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
    if (fields.storyboardId) {
      const shot = tx.select({ id: schema.storyboards.id, deletedAt: schema.storyboards.deletedAt })
        .from(schema.storyboards).where(eq(schema.storyboards.id, fields.storyboardId)).get()
      if (!shot || shot.deletedAt) throw new Error('镜头不存在')
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
      if (!input) throw new Error('缺少已确认的即梦报价')
      await db.update(schema.sysTask).set({ taskId: input.submitId, updatedAt: now() }).where(eq(schema.sysTask.id, id))
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
      await withLibTVCanvas(async () => {
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
        beginSubmission('polling')
        let url: string | undefined
        try { url = await runLibTVVideo(node) } catch (error) {
          if (error instanceof LibTVCliError && error.terminal) {
            await failTask(id, safeTaskError(error), 'generation_failed')
            return
          }
        }
        if (url) await handleVideoComplete(record, url, params.duration)
        else await recoverLibTVNode(record, node)
      })
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
      const adapter = getImageAdapter(config.provider)
      const supportsPublicImage = (url?: string) => !!adapter.supportsReferenceImageUrls?.(config, record.model || config.model, url)
      const resolvedReferenceImages = await normalizeReferenceImages(params.referenceImages,
        publicMedia && supportsPublicImage() ? supportsPublicImage : undefined)
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
      const adapter = getImageAdapter(config.provider)
      const { isAsync, taskId, imageUrl } = adapter.parseGenerateResponse(result)

      if (!isAsync && imageUrl) {
        logTaskProgress(label, 'sync-complete', { id, imageUrl })
        await handleImageComplete(record, imageUrl)
        return
      }

      if (!isAsync && !imageUrl) {
        // 同步模式但无 URL（Gemini 等返回 base64）
        const b64 = adapter.extractImageBase64(result)
        if (b64) {
          logTaskProgress(label, 'sync-base64-complete', { id, mimeType: b64.mimeType })
          await handleImageCompleteBase64(record, b64.data, b64.mimeType)
          return
        }
        throw new Error('No image URL or base64 data in response')
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
    const uncertain = submittedVideoRequest && current?.type === 'video' && !current.taskId && !current.resultUrl
      && (err instanceof TypeError || err instanceof SyntaxError || /timeout|abort|No task_id|API error 5/i.test(err.message))
    await failTask(id, safeTaskError(err), uncertain ? 'submission_unknown' : undefined)
  }
}

async function markPolling(id: number, taskId: string | undefined) {
  await db.update(schema.sysTask)
    .set({ taskId, stage: 'polling', status: 'processing', updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled')))
  logTaskProgress('SysTask', 'poll-start', { id, taskId })
}

async function failTask(id: number, message: string, code?: string) {
  message = safeTaskError(message)
  logTaskError('SysTask', 'failed', { id, error: message })
  await db.update(schema.sysTask)
    .set({ status: 'failed', errorMsg: safeTaskError(message), ...(code ? { errorCode: code } : {}), updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'canceled')))
}

type SysTaskRecord = typeof schema.sysTask.$inferSelect

export function cancelUnsubmittedVideoTask(id: number) {
  return db.update(schema.sysTask).set({ status: 'canceled', stage: 'canceled', updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), eq(schema.sysTask.type, 'video'),
      eq(schema.sysTask.status, 'processing'), eq(schema.sysTask.stage, 'preparing'))).run().changes > 0
}

export async function cancelDispatchedVideoTask(id: number) {
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
  if (!record || record.type !== 'video' || record.provider !== 'aliyun' ||
      record.status !== 'processing' || !record.taskId || record.resultUrl) return false
  const config = await recoveryConfig(record).catch(() => null)
  if (!config || !await cancelUpstreamVideo(config, record.taskId)) return false
  return db.update(schema.sysTask).set({ status: 'canceled', stage: 'canceled', errorCode: null, errorMsg: null, updatedAt: now() })
    .where(and(eq(schema.sysTask.id, id), ne(schema.sysTask.status, 'completed'))).run().changes > 0
}

async function pollTask(record: SysTaskRecord, config: AIConfig, taskId: string) {
  return withApiCallContext({ taskId: record.id, dramaId: record.dramaId || undefined, provider: config.provider, model: record.model || config.model, category: record.type }, () => pollTaskResponse(record, config, taskId))
}

async function pollTaskResponse(record: SysTaskRecord, config: AIConfig, taskId: string) {
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
  const adapter = type === 'image' ? getImageAdapter(config.provider) : getVideoAdapter(config.provider)
  const startedAt = Date.now()

  for (let i = 0; i < profile.attempts; i++) {
    if (profile.maxDurationMs && Date.now() - startedAt >= profile.maxDurationMs) {
      await failTask(record.id, 'Timeout: Polling exceeded 10 minutes')
      return
    }
    await new Promise(r => setTimeout(r, profile.intervalMs))
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
          if (pollResp.imageUrl) {
            logTaskSuccess(label, 'poll-complete', { id: record.id, taskId, imageUrl: pollResp.imageUrl })
            await handleImageComplete(record, pollResp.imageUrl)
            return
          }
          if (adapter.provider === 'gemini') {
            // Gemini 可能返回 base64
            const b64 = (adapter as ReturnType<typeof getImageAdapter>).extractImageBase64(result)
            if (b64) {
              logTaskSuccess(label, 'poll-base64-complete', { id: record.id, taskId, mimeType: b64.mimeType })
              await handleImageCompleteBase64(record, b64.data, b64.mimeType)
              return
            }
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
        await failTask(record.id, `Timeout: ${err.message}`)
        return
      }
      logTaskWarn(label, 'poll-retry', { id: record.id, taskId, attempt: i + 1, error: err.message })
    }
  }
  await failTask(record.id, 'Timeout: polling attempts exhausted')
}

async function recoverLibTVNode(record: SysTaskRecord, node: LibTVNode) {
  let url: string | undefined
  try { url = await inspectLibTVVideo(node) } catch (error) {
    await failTask(record.id, safeTaskError(error), 'submission_unknown')
    return
  }
  if (url) await handleVideoComplete(record, url, parseTaskParams(record.params).duration)
  else await failTask(record.id, 'LibTV 原画布节点尚未返回成片。请先在 LibTV 核对原任务，或恢复任务再查。', 'submission_unknown')
}

async function pollJimengTask(record: SysTaskRecord, input: JimengVideoRunInput) {
  const profile = POLL_PROFILES.video
  let lastError = ''
  for (let attempt = 0; attempt < profile.attempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, profile.intervalMs))
    let operation: Awaited<ReturnType<typeof inspectJimengVideo>>
    try {
      operation = await inspectJimengVideo(input.projectId, input.submitId)
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
          await downloadJimengVideo(input.projectId, operation.resourceId, output)
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
      if (record.type === 'image') await handleImageComplete(record, result.url, comfyHeaders(config))
      else await handleVideoComplete(record, result.url, params.comfyui.duration, comfyHeaders(config))
      return
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  await failTask(record.id, `ComfyUI 等待超时，上游任务可能仍在运行，请勿重复提交。${lastError}`, 'polling_timeout')
}

async function handleImageComplete(record: SysTaskRecord, imageUrl: string, headers?: Record<string, string>) {
  const localPath = await downloadFile(imageUrl, 'images', headers)
  // 列表页缩略图（前端按命名约定推导地址，失败不影响主流程）
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ resultUrl: imageUrl, localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'downloaded', { id: record.id, provider: record.provider, localPath })

  await writeBackImageAssets(record, localPath)
}

async function handleImageCompleteBase64(record: SysTaskRecord, base64Data: string, mimeType: string) {
  const localPath = await saveBase64Image(base64Data, mimeType, 'images')
  await generateImageThumb(localPath)

  await db.update(schema.sysTask)
    .set({ localPath, status: 'completed', completedAt: now(), updatedAt: now() })
    .where(eq(schema.sysTask.id, record.id))

  logTaskSuccess('ImageTask', 'saved-base64', { id: record.id, provider: record.provider, mimeType, localPath })

  await writeBackImageAssets(record, localPath)
}

// 图片完成后回写业务表：分镜(按 frameType)、角色、场景、道具
async function writeBackImageAssets(record: SysTaskRecord, localPath: string) {
  const params = parseTaskParams(record.params)
  if (record.storyboardId) {
    const sbUpdate: Record<string, any> = { updatedAt: now() }
    if (params.frameType === 'first_frame') sbUpdate.firstFrameImage = localPath
    else if (params.frameType === 'last_frame') sbUpdate.lastFrameImage = localPath
    else sbUpdate.composedImage = localPath
    await db.update(schema.storyboards).set(sbUpdate).where(eq(schema.storyboards.id, record.storyboardId))
  }
  if (record.characterId) {
    await db.update(schema.characters).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.characters.id, record.characterId))
  }
  if (record.sceneId) {
    await db.update(schema.scenes).set({ imageUrl: localPath, status: 'completed', updatedAt: now() }).where(eq(schema.scenes.id, record.sceneId))
  }
  if (record.propId) {
    await db.update(schema.props).set({ imageUrl: localPath, updatedAt: now() }).where(eq(schema.props.id, record.propId))
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
  await extractVideoPoster(localPath)
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
}

async function recoveryConfig(record: SysTaskRecord): Promise<AIConfig> {
  if (record.configId) {
    const config = await getConfigById(record.configId)
    if (config && config.provider === record.provider && config.baseUrl === record.configBaseUrl) return config
    throw new Error('原视频服务配置已删除、停用或地址变更，请恢复原配置')
  }
  // 旧任务只在同厂商唯一配置时恢复，绝不任意换服务商查询。
  const rows = (await db.select().from(schema.aiServiceConfigs)).filter(c => c.isActive && c.serviceType === 'video' && c.provider === record.provider)
  if (rows.length === 1) {
    const config = await getConfigById(rows[0].id)
    if (config) return config
  }
  throw new Error('历史任务无法确定原服务配置，请先核对配置')
}

export async function recoverVideoTask(id: number): Promise<void> {
  const [record] = await db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id))
  if (!record || record.type !== 'video') throw new Error('视频任务不存在')
  if (record.status === 'canceled') throw new Error('视频任务已取消')
  if (activeTasks.has(id) || record.status === 'completed') return
  if (!record.resultUrl && !record.taskId) throw new Error('未保存上游任务编号，请先核对上游记录，勿重复生成')
  if (record.errorCode === 'generation_failed') throw new Error('上游已确认生成失败，无法恢复原任务')
  // 在任何异步配置读取前获取锁，重复点击不会启动多个下载。
  activeTasks.add(id)
  try {
    if (record.storyboardId) {
      const shot = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, record.storyboardId)).get()
      if (!shot || shot.deletedAt) throw new Error('分镜已删除，请先从回收站恢复')
    }
    const config = record.taskId && !record.resultUrl ? await recoveryConfig(record) : null
    assertVideoCliNotDisconnecting(record.provider)
    db.update(schema.sysTask).set({ status: 'processing', errorMsg: null, errorCode: null,
      stage: record.resultUrl ? 'downloading' : record.stage === 'transferring' || record.errorCode === 'delivery_failed' ? 'transferring' : 'polling', updatedAt: now() }).where(eq(schema.sysTask.id, id)).run()
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
      await markPolling(id, record.taskId!)
      await pollTask(record, originalConfig, record.taskId!)
    })().catch(error => failTask(id, safeTaskError(error), 'recovery_failed')).finally(() => activeTasks.delete(id))
  } catch (error) {
    activeTasks.delete(id)
    throw error
  }
}

export async function resumeInterruptedTasks() {
  const tasks = await db.select().from(schema.sysTask).where(eq(schema.sysTask.status, 'processing')).orderBy(desc(schema.sysTask.id))
  for (const task of tasks) {
    if (task.type === 'image' && task.provider === 'comfyui' && task.taskId) {
      runBackground(task.id, async () => {
        const config = await getConfigById(task.configId!)
        if (!config || config.provider !== 'comfyui' || config.baseUrl !== task.configBaseUrl) throw new Error('原 ComfyUI 配置不可用，请恢复原配置')
        await pollTask(task, config, task.taskId!)
      })
    } else if (task.type === 'video' && (task.taskId || task.resultUrl)) {
      try { await recoverVideoTask(task.id) } catch (error) { await failTask(task.id, safeTaskError(error), 'recovery_failed') }
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
