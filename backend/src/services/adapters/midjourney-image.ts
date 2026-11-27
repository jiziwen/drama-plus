import { parseDataUrl } from '../../utils/storage.js'
import type { AIConfig, ImageGenerationRecord, ImageGenResponse, ImagePollResponse, ImageProviderAdapter, ProviderRequest } from './types.js'
import { joinProviderUrl } from './url.js'

const imagineModel = 'mj_imagine'
const blendModel = 'mj_blend'
type ImageConfig = Pick<AIConfig, 'provider' | 'baseUrl' | 'model'>

export function isMidjourneyImageConfig(config: ImageConfig): boolean {
  const provider = config.provider.toLowerCase()
  if (provider === 'midjourney') return true
  // 已有火灵灵图片配置使用 OpenAI 类型和 /v1 地址。
  if (provider !== 'openai' || (config.model !== imagineModel && config.model !== blendModel)) return false
  try { return new URL(config.baseUrl).hostname === 'api.hllapi.vip' } catch { return false }
}

export function isMidjourneyBlend(config: ImageConfig): boolean {
  return config.model === blendModel && isMidjourneyImageConfig(config)
}

export function isMidjourneyImagine(config: ImageConfig): boolean {
  return config.model === imagineModel && isMidjourneyImageConfig(config)
}

export function midjourneyBaseUrl(baseUrl: string): string {
  const base = new URL(baseUrl.trim())
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/(?:\/(?:v1|mj))+$/, '')
  return base.toString()
}

function midjourneyUrl(baseUrl: string, path: string): string {
  return joinProviderUrl(midjourneyBaseUrl(baseUrl), '/mj', path)
}

function withAspectRatio(prompt: string, size: string | null | undefined): string {
  const dimensions = /^(\d{1,9})[x×:](\d{1,9})$/i.exec(size?.trim() || '')
  if (!dimensions) return prompt
  const width = Number(dimensions[1])
  const height = Number(dimensions[2])
  if (!width || !height) return prompt

  let divisor = width
  let remainder = height
  while (remainder) [divisor, remainder] = [remainder, divisor % remainder]
  const text = prompt.replace(/(^|\s+)--(?:ar|aspect)\s+\d+\s*:\s*\d+(?=\s|$)/gi, '').trim()
  return `${text} --ar ${width / divisor}:${height / divisor}`
}

function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch { return false }
}

export class MidjourneyImageAdapter implements ImageProviderAdapter {
  provider = 'midjourney'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model
    const refs: string[] = record.referenceImages ? JSON.parse(record.referenceImages) : []
    const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
    if (model === blendModel) {
      if (refs.length !== 2 || !refs.every(isImageUrl)) {
        throw new Error('Midjourney 图片融合需要两张公网可访问的参考图')
      }
      return { url: midjourneyUrl(config.baseUrl, '/submit/blend'), method: 'POST', headers, body: { base64Array: refs } }
    }

    if (model !== imagineModel) throw new Error('请选择火灵灵支持的 mj_imagine 或 mj_blend 模型')
    const prompt = record.prompt?.trim()
    if (!prompt) throw new Error('Midjourney 绘图需要填写提示词')
    const base64Array = refs.map(ref => {
      const image = parseDataUrl(ref)
      if (!image?.mimeType.startsWith('image/')) throw new Error('Midjourney 参考图无法读取为图片数据')
      return image.data
    })
    return {
      url: midjourneyUrl(config.baseUrl, '/submit/imagine'),
      method: 'POST',
      headers,
      body: { botType: 'MID_JOURNEY', prompt: withAspectRatio(prompt, record.size), base64Array },
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    if (result?.code === 1 && typeof result.result === 'string' && result.result.trim()) {
      return { isAsync: true, taskId: result.result.trim() }
    }
    throw new Error(result?.description && result.code !== 1
      ? `Midjourney 提交失败：${result.description}`
      : 'Midjourney 未返回有效的绘图任务编号')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: midjourneyUrl(config.baseUrl, `/task/${encodeURIComponent(taskId)}/fetch`),
      method: 'GET',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result?.status === 'FAILURE') {
      return { status: 'failed', error: result.failReason || 'Midjourney 绘图失败' }
    }
    if (result?.status === 'SUCCESS') {
      const imageUrl = this.extractImageUrl(result)
      return imageUrl ? { status: 'completed', imageUrl } : { status: 'failed', error: 'Midjourney 未返回有效的图片地址' }
    }
    return { status: 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return isImageUrl(result?.imageUrl) ? result.imageUrl : null
  }

  extractImageBase64(): null {
    return null
  }
}
