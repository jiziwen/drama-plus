import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../../utils/paths.js'
import { matchReferenceImageExtension } from '../../utils/reference-image-format.js'
import type { AIConfig, ProviderRequest, VideoGenerationRecord, VideoGenResponse, VideoPollResponse, VideoProviderAdapter } from './types'
import { joinProviderUrl } from './url'

const imageTypes: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
}

function urls(raw?: string | null): string[] {
  if (!raw) return []
  const value = JSON.parse(raw)
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error('302.AI 参考素材格式无效')
  return value
}

async function imageValue(value: string): Promise<string> {
  if (/^https?:\/\//i.test(value) || /^data:image\/[\w.+-]+;base64,/i.test(value)) return value
  if (!/^\/?static\//.test(value)) throw new Error('302.AI 图片需要公网 URL 或本地上传素材')
  try {
    const original = value.replace(/^\/?static\//, '')
    const extension = path.extname(original).toLowerCase()
    if (!imageTypes[extension]) throw new Error('invalid image')
    const root = await realpath(STORAGE_ROOT)
    const file = await realpath(path.resolve(root, original))
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('invalid path')
    const actual = await matchReferenceImageExtension(file, extension)
    return `data:${imageTypes[actual]};base64,${(await readFile(file)).toString('base64')}`
  } catch {
    throw new Error('302.AI 无法读取本地图片，请重新上传')
  }
}

function endpoint(config: AIConfig, suffix: string): string {
  // The default endpoint is the origin; also accept a base URL ending in /v1.
  const base = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  return joinProviderUrl(base, '/302/v2/video', suffix)
}

export class ThreeZeroTwoVideoAdapter implements VideoProviderAdapter {
  provider = '302ai'

  async buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): Promise<ProviderRequest> {
    const model = (record.model || config.model || '').trim()
    const prompt = (record.prompt || '').trim()
    if (!model) throw new Error('请填写 302.AI 视频模型 ID')
    if (!prompt) throw new Error('302.AI 视频生成需要提示词')
    const images = urls(record.referenceImageUrls)
    const videos = urls(record.referenceVideoUrls)
    const audios = urls(record.referenceAudioUrls)
    if (images.length > 1 || audios.length || record.referenceFileUrl || record.referenceLinkUrl) {
      throw new Error('302.AI 统一视频接口仅支持一张输入图片或首尾帧，暂不支持音频及其他参考素材')
    }
    if (videos.length > 1) throw new Error('302.AI 统一视频接口仅支持一个参考视频')
    if (images.length && (record.firstFrameUrl || record.lastFrameUrl)) throw new Error('302.AI 参考图片与首尾帧不能同时使用')
    const first = record.firstFrameUrl || images[0] || record.imageUrl
    const last = record.lastFrameUrl
    if (last && !first) throw new Error('302.AI 尾帧需要搭配首帧')
    if (videos.length && (first || last)) throw new Error('302.AI 视频参考与首尾帧不能同时使用')
    if (videos.length && !/^https?:\/\//i.test(videos[0])) throw new Error('302.AI 参考视频需要公网 URL')
    const body: Record<string, string | number> = { model, prompt }
    if (first) body.image = await imageValue(first)
    if (last) body.end_image = await imageValue(last)
    if (videos.length) body.video = videos[0]
    if (record.duration != null) body.duration = record.duration
    if (record.aspectRatio) body.aspect_ratio = record.aspectRatio
    if (record.resolution) body.resolution = record.resolution
    return { url: endpoint(config, '/create'), method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, body }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const parsed = this.parsePollResponse(result)
    if (parsed.status === 'failed') throw new Error(parsed.error)
    const taskId = String(result?.task_id || '').trim()
    if (parsed.status === 'completed' && parsed.videoUrl) return { isAsync: false, taskId: taskId || undefined, videoUrl: parsed.videoUrl }
    if (taskId) return { isAsync: true, taskId }
    throw new Error('302.AI 未返回视频任务编号')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    if (!taskId || taskId === '.' || taskId === '..') throw new Error('302.AI 视频任务编号无效')
    return { url: endpoint(config, `/fetch/${encodeURIComponent(taskId)}`), method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` }, body: undefined }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = String(result?.status || '').toLowerCase().trim()
    if (['completed', 'success', 'succeeded'].includes(status)) return { status: 'completed', videoUrl: this.extractVideoUrl(result) || undefined }
    if (['failed', 'failure', 'cancelled', 'canceled'].includes(status)) {
      const error = result?.error?.message || result?.error || result?.message || '302.AI 视频生成失败'
      return { status: 'failed', error: typeof error === 'string' ? error : JSON.stringify(error) }
    }
    return { status: ['pending', 'queued'].includes(status) ? 'pending' : 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return typeof result?.video_url === 'string' && /^https?:\/\//i.test(result.video_url) ? result.video_url : null
  }
}
