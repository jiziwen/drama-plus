/**
 * Gemini 图片生成 Adapter
 * 认证: URL Query 参数 ?key= 或 Header x-goog-api-key
 * 请求: Google REST 风格的 contents[].parts[] 结构
 * 响应: base64 编码在 inlineData.data 中，无 URL
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { parseDataUrl } from '../../utils/storage.js'

const publicImageTypes: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp',
}

function isOfficialHost(baseUrl: string): boolean {
  try { return new URL(baseUrl).hostname === 'generativelanguage.googleapis.com' }
  catch { return false }
}

function publicImageMimeType(value: string): string | undefined {
  if (!value.startsWith('https://')) return
  try {
    const url = new URL(value)
    if (url.username || url.password) return
    const extension = /\.([a-z]+)$/iu.exec(url.pathname)?.[1]
    return extension ? publicImageTypes[extension.toLowerCase()] : undefined
  } catch { return }
}

export class GeminiImageAdapter implements ImageProviderAdapter {
  provider = 'gemini'

  supportsReferenceImageUrls(config: AIConfig, model: string, url?: string): boolean {
    const native = isOfficialHost(config.baseUrl) && /^(?:models\/)?gemini-(?:2\.5-|[3-9](?:\.\d+)?-|nano-banana-)/u.test(model)
    return native && (url === undefined || !!publicImageMimeType(url))
  }

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    // Gemini 模型名格式: "models/gemini-3-pro-image" 或直接 "gemini-3-pro-image"
    const modelName = record.model || config.model || 'gemini-3-pro-image'
    // interactions 端点仅官方 API 可用;中转站(new-api 类)普遍未配置该端点类型,
    // 会报 "endpointType=GEMINI_INTERACTIONS 未启用",此类端点回退到 generateContent 分支
    const isGemini3Image = /gemini-3.*image/.test(modelName)

    // The existing generateContent branch carries reference image parts; interactions below is text-only.
    if (isGemini3Image && isOfficialHost(config.baseUrl) && !record.referenceImages) {
      return {
        url: joinProviderUrl(config.baseUrl, '/v1beta', '/interactions'),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: {
          model: modelName.replace(/^models\//, ''),
          input: record.prompt || 'Generate an image',
          response_format: {
            type: 'image',
            aspect_ratio: this.parseAspectRatio(record.size),
            image_size: this.parseImageSize(record.size),
          },
        },
      }
    }

    const model = modelName.startsWith('models/') ? modelName : `models/${modelName}`

    // Google REST 风格请求体
    const parts: any[] = []
    if (record.referenceImages) {
      const refs: unknown = JSON.parse(record.referenceImages)
      if (!Array.isArray(refs)) throw new Error('参考图片列表无效')
      for (const ref of refs) {
        if (typeof ref !== 'string') throw new Error('参考图片无效')
        if (this.supportsReferenceImageUrls(config, modelName, ref)) {
          parts.push({ file_data: { mime_type: publicImageMimeType(ref), file_uri: ref } })
          continue
        }
        const parsed = parseDataUrl(ref)
        if (!parsed?.mimeType.startsWith('image/')) throw new Error('参考图片无法解析为内嵌图片')
        parts.push({ inline_data: { mime_type: parsed.mimeType, data: parsed.data } })
      }
    }
    parts.push({ text: record.prompt || 'Generate an image' })

    const body = {
      contents: [{
        parts,
      }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        imageConfig: {
          // 解析 size 如 "1920x1080" -> aspectRatio
          aspectRatio: this.parseAspectRatio(record.size),
          imageSize: this.parseImageSize(record.size),
        },
      },
    }

    const url = new URL(joinProviderUrl(config.baseUrl, '/v1beta', `/${model}:generateContent`))
    url.searchParams.set('key', config.apiKey)

    return {
      url: url.toString(),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    const firstCandidate = result?.candidates?.[0]
    const finishReason = firstCandidate?.finishReason || firstCandidate?.finish_reason
    const finishMessage = firstCandidate?.finishMessage || firstCandidate?.finish_message

    if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
      throw new Error(finishMessage || `Gemini generation stopped: ${finishReason}`)
    }

    if (this.extractImageUrl(result)) {
      return { isAsync: false, imageUrl: this.extractImageUrl(result) || undefined }
    }

    if (this.extractImageBase64(result)) {
      return { isAsync: false, imageUrl: undefined }
    }

    if (result.task_id || result.id) {
      return { isAsync: true, taskId: result.task_id || result.id }
    }

    if (result.error) {
      throw new Error(result.error.message || 'Gemini generation failed')
    }
    throw new Error('No image data in Gemini response')
  }

  parsePollResponse(result: any): ImagePollResponse {
    // Gemini 是同步的，通常不会走到这里
    return { status: 'completed' }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    // Gemini 不需要轮询，但实现接口以保持一致
    const url = new URL(joinProviderUrl(config.baseUrl, '/v1beta', `/${taskId}`))
    url.searchParams.set('key', config.apiKey)
    return {
      url: url.toString(),
      method: 'GET',
      headers: {
        'x-goog-api-key': config.apiKey,
      },
      body: undefined,
    }
  }

  extractImageUrl(result: any): string | null {
    return result?.data?.[0]?.url
      || result?.image_url
      || result?.url
      || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result?.data?.[0]?.b64_json
    if (b64) {
      return { data: b64, mimeType: 'image/png' }
    }

    if (result?.output_image?.data) {
      return {
        data: result.output_image.data,
        mimeType: result.output_image.mime_type || result.output_image.mimeType || 'image/png',
      }
    }

    const parts = result.candidates?.[0]?.content?.parts || []
    for (const part of parts) {
      if (part.inlineData || part.inline_data) {
        const inline = part.inlineData || part.inline_data
        return {
          data: inline.data,
          mimeType: inline.mimeType || inline.mime_type || 'image/png',
        }
      }
    }
    return null
  }

  private parseAspectRatio(size?: string | null): string {
    if (!size) return '16:9'
    const [w, h] = size.split('x').map(Number)
    if (!w || !h) return '16:9'
    const gcd = this.gcd(w, h)
    return `${w / gcd}:${h / gcd}`
  }

  private parseImageSize(size?: string | null): string {
    if (!size) return '1K'
    const [w] = size.split('x').map(Number)
    if (!w) return '1K'
    if (w >= 2048) return '4K'
    if (w >= 1024) return '2K'
    if (w >= 512) return '1K'
    return '512'
  }

  private gcd(a: number, b: number): number {
    return b === 0 ? a : this.gcd(b, a % b)
  }
}
