import { aicostVideoModelCapabilities } from './aicost-video-models.js'
import { seedanceModelLimits } from './seedance-models.js'
import { jimengVideoModel } from './jimeng-video-models.js'
import { libtvVideoModel } from './libtv-video-models.js'

/** Limits for a single script-to-video card, as implemented by the project's video adapters. */
export interface ScriptVideoCapabilities {
  minDuration: number
  maxDuration: number
  maxReferences: number | null
  maxAudioReferences: number | null
  maxAudioDuration: number
  maxTotalReferences: number | null
  wholeSeconds: boolean
}

export function isScriptVideoGenerationDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 30
}

interface ComfyVideoSettings {
  workflow?: unknown
  outputNode?: string
  referenceNode?: string
  referencePrefix?: string
  maxReferences?: number
}

export function scriptVideoCapabilities(provider: string, model: string, comfy?: ComfyVideoSettings | null): ScriptVideoCapabilities | null {
  switch (provider.toLowerCase()) {
    case 'aicost':
      return aicostVideoModelCapabilities(model) ?? { minDuration: 1, maxDuration: 30, maxReferences: null, maxAudioReferences: null,
        maxAudioDuration: 0, maxTotalReferences: null, wholeSeconds: true }
    case 'volcengine': {
      const limits = seedanceModelLimits(model)
      if (!limits) return null
      return {
        minDuration: limits.minDuration, maxDuration: limits.maxDuration,
        maxReferences: limits.images, maxAudioReferences: limits.audios, maxAudioDuration: limits.audioDuration,
        maxTotalReferences: limits.images + limits.videos + limits.audios, wholeSeconds: true,
      }
    }
    case 'jimeng':
    case 'libtv': {
      const spec = provider.toLowerCase() === 'jimeng' ? jimengVideoModel(model) : libtvVideoModel(model)
      return spec ? { minDuration: 4, maxDuration: spec.maxDuration, maxReferences: spec.images,
        maxAudioReferences: spec.audios, maxAudioDuration: spec.audioDuration,
        maxTotalReferences: Math.min(spec.maxReferences, spec.images + spec.audios), wholeSeconds: true } : null
    }
    case 'minimax':
      return /^minimax-h3/i.test(model) ? { minDuration: 4, maxDuration: 15, maxReferences: 9, maxAudioReferences: 3, maxAudioDuration: 15, maxTotalReferences: 12, wholeSeconds: true } : null
    case 'aliyun':
      return ['wan3.0-video-prime', 'wan3.0-video'].includes(model)
        ? { minDuration: 2, maxDuration: 30, maxReferences: 10, maxAudioReferences: 5, maxAudioDuration: 15, maxTotalReferences: 20, wholeSeconds: true } : null
    case 'comfyui': {
      // The ComfyUI adapters accept up to 60s. This workflow caps a storyboard card at 30s.
      if (comfy?.workflow) {
        const graph = JSON.stringify(comfy.workflow)
        if (!comfy.outputNode || !graph.includes('{{prompt}}') || !/\{\{(?:frames|duration)\}\}/u.test(graph)) return null
        const maxReferences = comfy.referenceNode && comfy.referencePrefix ? comfy.maxReferences ?? 6 : 0
        return { minDuration: 0, maxDuration: 30, maxReferences, maxAudioReferences: 0, maxAudioDuration: 0, maxTotalReferences: maxReferences, wholeSeconds: false }
      }
      return model === 'wf-minimax-h3' ? { minDuration: 0, maxDuration: 30, maxReferences: 6, maxAudioReferences: 0, maxAudioDuration: 0, maxTotalReferences: 6, wholeSeconds: false } : null
    }
    default: return null
  }
}
