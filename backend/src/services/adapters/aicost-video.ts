import { openAsBlob } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { matchReferenceImageExtension } from '../../utils/reference-image-format.js'
import { isAicostMiniMaxH3Model, isAicostSeedance25Model } from '../aicost-video-models.js'
import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoGenResponse, VideoPollResponse, VideoProviderAdapter } from './types'
import { joinProviderUrl } from './url'

type MediaKind = 'image' | 'video' | 'audio'
type ReferenceGroup = { field: string; kind: MediaKind; values: string[]; single?: boolean }
type LocalReference = { blob: Blob; name: string }
type PreparedReferenceGroup = Pick<ReferenceGroup, 'field' | 'single'> & { values: (string | LocalReference)[] }

const SEEDANCE_INLINE_REQUEST_LIMIT = 64 * 1024 * 1024

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}

function referenceUrls(raw?: string | null): string[] {
  return raw ? JSON.parse(raw) : []
}

function isLocalReference(value: string): boolean {
  return /^\/?static\//.test(value)
}

async function openReference(value: string, kind: MediaKind): Promise<LocalReference> {
  const original = value.replace(/^\/?static\//, '')
  const extension = path.extname(original).toLowerCase()
  if (!mimeTypes[extension]?.startsWith(`${kind}/`)) throw new Error(`AICost 不支持此参考素材格式（${kind}）`)
  try {
    const root = await realpath(STORAGE_ROOT)
    const local = await realpath(path.resolve(root, original))
    if (!local.startsWith(root + path.sep) || !(await stat(local)).isFile()) throw new Error('invalid reference path')
    const actualExtension = kind === 'image' ? await matchReferenceImageExtension(local, extension) : extension
    const name = actualExtension === extension ? path.basename(original) : path.parse(original).name + actualExtension
    return { blob: await openAsBlob(local, { type: mimeTypes[actualExtension] }), name }
  } catch {
    throw new Error(`AICost 无法读取本地参考素材（${kind}），请重新上传`)
  }
}

function dataUrlPrefix(blob: Blob) {
  return `data:${blob.type};base64,`
}

function inlineRequestSize(fields: Record<string, string | number>, groups: PreparedReferenceGroup[]) {
  const body: Record<string, unknown> = { ...fields }
  let encodedBytes = 0
  for (const { field, values, single } of groups) {
    if (!values.length) continue
    const urls = values.map(value => {
      if (typeof value === 'string') return value
      encodedBytes += Math.ceil(value.blob.size / 3) * 4
      return dataUrlPrefix(value.blob)
    })
    body[field] = single ? urls[0] : urls
  }
  return Buffer.byteLength(JSON.stringify(body)) + encodedBytes
}

function auth(config: AIConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}` }
}

function taskPath(taskId: string): string {
  if (!taskId || taskId === '.' || taskId === '..') throw new Error('AICost 返回了无效任务编号')
  return `/videos/${encodeURIComponent(taskId)}`
}

export function aicostVideoSubmissionRejection(status: number | null, body: unknown, model: string | null) {
  if (status == null || status < 400 || !body || typeof body !== 'object') return
  const result = body as { error?: { code?: string }; id?: unknown; task_id?: unknown }
  if (result.id || result.task_id || result.error?.code !== 'model_not_found') return
  return `AICost 当前密钥分组的模型「${model || '所选模型'}」没有可用渠道，请切换视频模型或稍后重试。`
}

export class AICostVideoAdapter implements VideoProviderAdapter {
  provider = 'aicost'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const model = record.model || config.model
    const prompt = record.prompt || ''
    if (!model?.trim()) throw new Error('请在 AICost 配置中填写视频模型 ID')
    if (!prompt.trim()) throw new Error('AICost 视频生成需要提示词')
    if (record.referenceFileUrl || record.referenceLinkUrl) throw new Error('AICost 请使用专门的图片、音频或视频参考字段上传素材')

    const h3 = isAicostMiniMaxH3Model(model)
    const images = referenceUrls(record.referenceImageUrls)
    const videos = referenceUrls(record.referenceVideoUrls)
    const audios = referenceUrls(record.referenceAudioUrls)
    const firstFrame = record.firstFrameUrl || (record.lastFrameUrl ? record.imageUrl : null)
    const lastFrame = record.lastFrameUrl
    if (record.imageUrl && !images.length && !firstFrame) images.push(record.imageUrl)
    if (h3 && videos.length) throw new Error('AICost MiniMax H3 不支持参考视频')
    if (h3 && (firstFrame || lastFrame) && (images.length || audios.length)) {
      throw new Error('AICost MiniMax H3 的首尾帧需要单独使用')
    }
    if (h3 && audios.length && !images.length) throw new Error('AICost MiniMax H3 的参考音频需要搭配参考图片')

    const fields: Record<string, string | number> = { model, prompt }
    if (record.duration != null) fields.seconds = record.duration
    if (record.aspectRatio) fields.aspect_ratio = record.aspectRatio
    if (record.resolution) fields.resolution = record.resolution.toLowerCase() === '1440p' ? '1440P' : record.resolution.toLowerCase()

    const references: ReferenceGroup[] = [
      { field: h3 ? 'reference_images' : 'images', kind: 'image', values: images },
      { field: 'videos', kind: 'video', values: videos },
      { field: h3 ? 'audio_references' : 'audios', kind: 'audio', values: audios },
      { field: 'start_frame', kind: 'image', values: firstFrame ? [firstFrame] : [], single: true },
      { field: 'end_frame', kind: 'image', values: lastFrame ? [lastFrame] : [], single: true },
    ]

    const request = { url: joinProviderUrl(config.baseUrl, '/v1', '/videos'), method: 'POST', headers: auth(config) }
    const prepared = await Promise.all(references.map(async ({ field, kind, values, single }) => ({
      field, single,
      values: await Promise.all(values.map(value => isLocalReference(value) ? openReference(value, kind) : value)),
    })))
    const values = prepared.flatMap(group => group.values)
    const allLocal = values.length > 0 && values.every(value => typeof value !== 'string')
    // AICost turns multipart files into HTTPS URLs before forwarding. Send small
    // Seedance 2.5 voice requests inline to avoid relying on that upload path.
    const inlineVoice = allLocal && isAicostSeedance25Model(model) && audios.length > 0
      && inlineRequestSize(fields, prepared) <= SEEDANCE_INLINE_REQUEST_LIMIT
    if (allLocal && !inlineVoice) {
      const body = new FormData()
      for (const [key, value] of Object.entries(fields)) body.append(key, String(value))
      for (const { field, values } of prepared) {
        for (const value of values) {
          if (typeof value !== 'string') body.append(field, value.blob, value.name)
        }
      }
      return { ...request, body }
    }

    // JSON also preserves upload order for mixed URL and local references.
    const body: Record<string, string | number | string[]> = { ...fields }
    for (const { field, values, single } of prepared) {
      if (!values.length) continue
      const serialized = await Promise.all(values.map(async value => {
        if (typeof value === 'string') return value
        return dataUrlPrefix(value.blob) + Buffer.from(await value.blob.arrayBuffer()).toString('base64')
      }))
      body[field] = single ? serialized[0] : serialized
    }
    return { ...request, headers: { ...request.headers, 'Content-Type': 'application/json' }, body }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const response = this.parsePollResponse(result)
    const taskId = String(result?.task_id || result?.id || '').trim()
    if (response.status === 'failed' && !taskId) throw new Error(response.error)
    if (response.status === 'completed' && response.videoUrl) {
      return { isAsync: false, taskId: taskId || undefined, videoUrl: response.videoUrl, duration: response.duration }
    }
    if (taskId) return { isAsync: true, taskId }
    throw new Error('No task_id in AICost response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return { url: joinProviderUrl(config.baseUrl, '/v1', taskPath(taskId)), method: 'GET', headers: auth(config), body: undefined }
  }

  buildDownloadRequest(config: AIConfig, taskId: string): ProviderRequest {
    return { ...this.buildPollRequest(config, taskId), url: joinProviderUrl(config.baseUrl, '/v1', `${taskPath(taskId)}/content`) }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result?.status || '').toLowerCase().trim()
    if (['success', 'succeeded', 'completed'].includes(status)) {
      const seconds = Number(result.seconds ?? result.duration)
      return { status: 'completed', videoUrl: this.extractVideoUrl(result) || undefined, duration: seconds > 0 && Number.isFinite(seconds) ? seconds : undefined }
    }
    if (['failure', 'failed', 'cancelled', 'canceled'].includes(status)) {
      const error = result.fail_reason || result.error?.message || result.error || 'AICost 视频生成失败'
      return { status: 'failed', error: typeof error === 'string' ? error : JSON.stringify(error) }
    }
    return { status: ['not_start', 'queued', 'pending'].includes(status) ? 'pending' : 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return [result?.result_url, result?.url, result?.video_url].find(value => typeof value === 'string' && /^https?:\/\//i.test(value)) || null
  }
}
