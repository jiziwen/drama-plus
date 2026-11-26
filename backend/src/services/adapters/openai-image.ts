/**
 * OpenAI 图片生成 Adapter
 * 文生图端点: /v1/images/generations (注意 /v1 前缀)
 * 参考生图端点: /v1/images/edits （公网图片 URL 或 multipart 文件上传）
 * 响应格式: { data: [{ url: "..." }] } 或 { data: [{ b64_json: "..." }] }
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

export class OpenAIImageAdapter implements ImageProviderAdapter {
  provider = 'openai'

  supportsReferenceImageUrls(config: AIConfig, model: string, url?: string): boolean {
    try {
      const host = new URL(config.baseUrl).hostname
      if (host === 'api.openai.com') {
        if (!/^gpt-image-\d|^chatgpt-image-latest$/u.test(model)) return false
      } else if ((host !== 'aicost.me' && host !== 'www.aicost.me') || model !== 'gpt-image-mj') {
        return false
      }
      if (!url) return true
      const source = new URL(url)
      return ['https:', 'http:'].includes(source.protocol) && !source.username && !source.password
    } catch {
      return false
    }
  }

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    const model = record.model || config.model || 'gpt-image-2'
    if (config.provider.toLowerCase() === '302ai' && !/^gpt-image-(?:2|1(?:\.5|-mini)?)(?:$|-\d{4}-\d{2}-\d{2}$)/i.test(model)) {
      throw new Error('302.AI 图片服务目前支持 GPT Image 系列模型')
    }
    const isGptImage = model.startsWith('gpt-image-')
    const isGptImage2 = /^gpt-image-2(?:-\d{4}-\d{2}-\d{2}|\.(?:5|6)-(?:sunburst|flare)(?:-\d{4}-\d{2}-\d{2})?)?$/i.test(model)
    const size = isGptImage2
      ? this.normalizeGptImage2Size(record.size)
      : isGptImage
      ? this.normalizeGptImageSize(record.size)
      : record.size || '1024x1024'

    // 有参考图走 edits，无参考图走纯文生图 generations。
    const refs = this.parseReferenceImages(record.referenceImages)
    if (refs.length) {
      if (config.provider.toLowerCase() === '302ai' && refs.length > 1) {
        throw new Error('302.AI GPT Image 编辑目前支持一张参考图')
      }
      return this.buildEditsRequest(config, model, record.prompt, size, refs)
    }

    const body: any = {
      model,
      prompt: record.prompt,
      size,
      n: 1,
    }

    if (!isGptImage) {
      body.response_format = 'url'
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/images/generations'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  private parseReferenceImages(raw?: string | null): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
    } catch {
      return []
    }
  }

  private buildEditsRequest(
    config: AIConfig,
    model: string,
    prompt: string | null | undefined,
    size: string,
    refs: string[],
  ): ProviderRequest {
    const url = joinProviderUrl(config.baseUrl, '/v1', '/images/edits')
    const headers = { 'Authorization': `Bearer ${config.apiKey}` }
    if (refs.some(ref => this.supportsReferenceImageUrls(config, model, ref))) {
      if (!refs.every(ref => this.supportsReferenceImageUrls(config, model, ref) || parseDataUrl(ref)?.mimeType.startsWith('image/'))) {
        throw new Error('参考图片必须是可访问的 HTTP(S) URL 或图片 data URL')
      }
      return {
        url,
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: { model, prompt: prompt || '', size, n: 1, images: refs.map(image_url => ({ image_url })) },
      }
    }

    // fetch 生成 multipart 边界，兼容需要文件上传的网关和本地素材。
    const form = new FormData()
    form.append('model', model)
    form.append('prompt', prompt || '')
    form.append('size', size)
    form.append('n', '1')

    for (const [index, ref] of refs.entries()) {
      const parsed = parseDataUrl(ref)
      if (!parsed?.mimeType.startsWith('image/')) throw new Error('参考图片无法解析为可上传的文件')
      const buffer = Buffer.from(parsed.data, 'base64')
      const ext = parsed.mimeType === 'image/png' ? 'png' : parsed.mimeType === 'image/webp' ? 'webp' : 'jpg'
      form.append(config.provider.toLowerCase() === '302ai' ? 'image' : 'image[]', new Blob([buffer], { type: parsed.mimeType }), `reference-${index + 1}.${ext}`)
    }

    return {
      url,
      method: 'POST',
      headers,
      body: form,
    }
  }

  private normalizeGptImageSize(size?: string | null): string {
    const allowed = ['1024x1024', '1536x1024', '1024x1536', 'auto']
    if (!size) return '1024x1024'

    const normalized = size.toLowerCase()
    if (allowed.includes(normalized)) return normalized

    const [width, height] = normalized.split('x').map(Number)
    if (!width || !height) return 'auto'
    if (width === height) return '1024x1024'
    return width > height ? '1536x1024' : '1024x1536'
  }

  private normalizeGptImage2Size(size?: string | null): string {
    if (!size) return '1024x1024'
    const normalized = size.toLowerCase()
    if (normalized === 'auto') return 'auto'

    const [rawWidth, rawHeight] = normalized.split('x').map(Number)
    if (!rawWidth || !rawHeight) return 'auto'

    const width = this.roundToMultiple(Math.min(4096, Math.max(256, rawWidth)), 16)
    const height = this.roundToMultiple(Math.min(4096, Math.max(256, rawHeight)), 16)
    return `${width}x${height}`
  }

  private roundToMultiple(value: number, multiple: number): number {
    return Math.max(multiple, Math.round(value / multiple) * multiple)
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // OpenAI DALL-E 3 目前是同步返回，但规范上也有异步 task 模式
    if (result.task_id || result.id) {
      return { isAsync: true, taskId: result.task_id || result.id }
    }
    const imageUrl = result.data?.[0]?.url || result.url
    if (imageUrl) {
      return { isAsync: false, imageUrl }
    }
    // b64_json 模式
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      // 对于 base64，返回特殊标记，实际处理在 extractImageBase64
      return { isAsync: false, imageUrl: undefined }
    }
    throw new Error('No image URL in response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    return {
      url: joinProviderUrl(config.baseUrl, '/v1', `/images/task/${taskId}`),
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): ImagePollResponse {
    if (result.status === 'completed') {
      return {
        status: 'completed',
        imageUrl: result.image_url || result.data?.[0]?.url || null,
      }
    }
    if (result.status === 'failed') {
      return { status: 'failed', error: result.error?.message || 'Generation failed' }
    }
    return { status: result.status || 'processing' }
  }

  extractImageUrl(result: any): string | null {
    return result.data?.[0]?.url || result.image_url || null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    const b64 = result.data?.[0]?.b64_json
    if (b64) {
      return { data: b64, mimeType: 'image/png' }
    }
    return null
  }
}
