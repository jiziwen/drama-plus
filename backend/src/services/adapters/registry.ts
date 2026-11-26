/**
 * Provider Adapter 注册表
 * 根据 provider 名称返回对应的 Adapter 实例
 */
import { OpenAIImageAdapter } from './openai-image'
import { GeminiImageAdapter } from './gemini-image'
import { isMidjourneyImageConfig, MidjourneyImageAdapter } from './midjourney-image.js'
import { VolcEngineImageAdapter } from './volcengine-image'
import { VolcEngineVideoAdapter } from './volcengine-video'
import { MiniMaxVideoAdapter } from './minimax-video'
import { AliyunWanVideoAdapter } from './aliyun-wan-video'
import { AICostVideoAdapter } from './aicost-video'
import { ThreeZeroTwoVideoAdapter } from './302ai-video'
import type { AIConfig, ImageProviderAdapter, VideoProviderAdapter } from './types'

// 图片 Adapter 注册表
export const imageAdapters: Record<string, ImageProviderAdapter> = {
  openai: new OpenAIImageAdapter(),
  '302ai': new OpenAIImageAdapter(),
  gemini: new GeminiImageAdapter(),
  midjourney: new MidjourneyImageAdapter(),
  volcengine: new VolcEngineImageAdapter(),
}

// 视频 Adapter 注册表
export const videoAdapters: Record<string, VideoProviderAdapter> = {
  volcengine: new VolcEngineVideoAdapter(),
  minimax: new MiniMaxVideoAdapter(),
  aliyun: new AliyunWanVideoAdapter(),
  aicost: new AICostVideoAdapter(),
  '302ai': new ThreeZeroTwoVideoAdapter(),
}

/**
 * 获取图片 Adapter
 * @param config 图片服务配置
 * @param model 任务所选模型，可与配置的首选模型不同
 * @returns 对应的 Adapter
 */
export function getImageAdapter(config: Pick<AIConfig, 'provider' | 'baseUrl' | 'model'>, model = config.model): ImageProviderAdapter {
  const provider = isMidjourneyImageConfig({ ...config, model }) ? 'midjourney' : config.provider.toLowerCase()
  const adapter = imageAdapters[provider]
  if (!adapter) throw new Error(`Unsupported image provider: ${provider}`)
  return adapter
}

/**
 * 获取视频 Adapter
 * @param provider 厂商名称
 * @returns 对应的 Adapter
 */
export function getVideoAdapter(provider: string): VideoProviderAdapter {
  const adapter = videoAdapters[provider.toLowerCase()]
  if (!adapter) throw new Error(`Unsupported video provider: ${provider}`)
  return adapter
}
