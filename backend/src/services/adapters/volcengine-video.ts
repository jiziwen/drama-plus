/** 火山方舟 Seedance 首帧与多模态参考生成。 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'

import { seedanceModelLimits } from '../seedance-models.js'

const DEFAULT_MODEL = 'doubao-seedance-2-0-mini-260615'

function parseUrlArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string' && u.trim()) : []
  } catch {
    return []
  }
}

export class VolcEngineVideoAdapter implements VideoProviderAdapter {
  provider = 'volcengine'

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    const model = record.model || config.model || DEFAULT_MODEL
    const limits = seedanceModelLimits(model)
    if (!limits) throw new Error(`仅支持 Seedance 2.0 和 2.5 系列模型，当前: ${model}`)

    const prompt = (record.prompt || '').trim()
    const refImages = parseUrlArray(record.referenceImageUrls)
    const refVideos = parseUrlArray(record.referenceVideoUrls)
    const refAudios = parseUrlArray(record.referenceAudioUrls)
    const firstFrame = record.firstFrameUrl?.trim()
    const lastFrame = record.lastFrameUrl?.trim()
    const hasReferences = refImages.length || refVideos.length || refAudios.length

    if (lastFrame && !firstFrame) throw new Error('请同时提供首帧和尾帧')
    if (firstFrame && hasReferences) throw new Error('首帧模式与多模态参考模式不可同时使用')
    if (refImages.length > limits.images || refVideos.length > limits.videos || refAudios.length > limits.audios) {
      throw new Error(`参考素材超限：图片≤${limits.images}、视频≤${limits.videos}、音频≤${limits.audios}`)
    }
    if (limits.version === '2.0' && refAudios.length > 0 && refImages.length + refVideos.length === 0) {
      throw new Error('参考音频需要至少 1 个参考图片或视频')
    }
    if (!prompt && !firstFrame && !hasReferences) {
      throw new Error('多模态参考模式需要至少一个参考素材或 prompt')
    }

    const content: any[] = []
    if (prompt) content.push({ type: 'text', text: prompt })
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    for (const url of refImages) {
      content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
    }
    for (const url of refVideos) {
      content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
    }
    for (const url of refAudios) {
      content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
    }

    const resolution = record.resolution?.toLowerCase() || '720p'
    if (limits.version === '2.5' && !limits.resolutions.includes(resolution)) {
      throw new Error(`所选模型支持 ${limits.resolutions.join('、')}，请调整分辨率`)
    }
    const body: any = {
      model,
      content,
      generate_audio: record.generateAudio !== 0 && record.generateAudio !== false,
      ratio: firstFrame && limits.version === '2.5' ? 'adaptive' : record.aspectRatio || 'adaptive',
      duration: record.duration === -1 && limits.version === '2.5' ? -1 : this.normalizeDuration(record.duration, limits.maxDuration),
      resolution: limits.resolutions.includes(resolution) ? resolution : '720p',
      watermark: false,
    }

    if (limits.version === '2.5') {
      if (hasReferences) body.omni_reference_task_type = 'reference'
      if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024) {
        throw new Error('参考素材编码后的请求超过火山方舟 64 MB 上限，请减少素材大小或使用公网素材地址')
      }
    }
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', '/contents/generations/tasks'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    if (result.id) {
      return { isAsync: true, taskId: result.id }
    }
    // 同步返回
    const videoUrl = result.video_url || result.content?.video_url || result.data?.video_url
    if (videoUrl) {
      return { isAsync: false, videoUrl }
    }
    throw new Error('No task_id or video_url in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/api/v3', `/contents/generations/tasks/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    const status = result.status
    if (status === 'succeeded') {
      const videoUrl = result.video_url || result.content?.video_url || result.data?.video_url
      return {
        status: 'completed',
        videoUrl,
      }
    }
    if (status === 'failed') {
      // 上游 error 可能是对象 { code, message }（如 OutputVideoSensitiveContentDetected），规范成字符串
      const err = result.error
      const msg = typeof err === 'string' ? err : (err?.message || JSON.stringify(err) || 'Video generation failed')
      const code = err && typeof err === 'object' && err.code ? `[${err.code}] ` : ''
      return { status: 'failed', error: `${code}${msg}` }
    }
    return { status: status || 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    return result.video_url || result.content?.video_url || result.data?.video_url || null
  }

  private normalizeDuration(duration: number | undefined | null, maxDuration: number): number {
    const parsed = Math.round(Number(duration || 5))
    if (!Number.isFinite(parsed)) return 5
    return Math.min(maxDuration, Math.max(4, parsed))
  }
}
