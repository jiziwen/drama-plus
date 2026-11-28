import { AICOST_VIDEO_RESOLUTIONS, aicostVideoModelCapabilities } from './aicost-video-models.js'
import { jimengVideoModel } from './jimeng-video-models.js'
import { libtvVideoModel } from './libtv-video-models.js'
import { seedanceModelLimits } from './seedance-models.js'

export const SCRIPT_VIDEO_DEFAULT_RESOLUTIONS = ['480P', '720P', '1080P', '1K', '2K', '1440P', '4K'] as const
export type ScriptVideoResolution = typeof SCRIPT_VIDEO_DEFAULT_RESOLUTIONS[number]
const resolutions = new Set<string>(SCRIPT_VIDEO_DEFAULT_RESOLUTIONS)

export function normalizeScriptVideoResolution(value: unknown): ScriptVideoResolution | undefined {
  if (typeof value !== 'string') return
  const resolution = value.trim().toUpperCase()
  if (resolutions.has(resolution)) return resolution as ScriptVideoResolution
}

export function scriptVideoModelResolutions(provider?: string | null, model?: string | null): readonly string[] {
  const source = provider?.toLowerCase()
  const name = model ?? ''
  const supported = source === 'aicost' ? aicostVideoModelCapabilities(name)?.resolutions ?? AICOST_VIDEO_RESOLUTIONS
    : source === 'jimeng' || name.startsWith('jimeng-seedance-') ? jimengVideoModel(name)?.resolutions
    : source === 'libtv' ? libtvVideoModel(name)?.resolutions
    : source === 'volcengine' ? seedanceModelLimits(name)?.resolutions
    : !source ? seedanceModelLimits(name)?.resolutions ?? libtvVideoModel(name)?.resolutions
    : undefined
  return supported?.map(resolution => resolution.toUpperCase()) ?? ['480P', '720P', '1080P']
}

export function resolveScriptVideoResolution({ override, projectDefault, legacy, supported }: {
  override?: string
  projectDefault?: string
  legacy?: string
  supported: readonly string[]
}): string {
  const options = supported.map(resolution => resolution.toUpperCase())
  const explicit = normalizeScriptVideoResolution(override)
  if (explicit && options.includes(explicit)) return explicit
  const preferred = normalizeScriptVideoResolution(projectDefault) ?? normalizeScriptVideoResolution(legacy)
  if (preferred && options.includes(preferred)) return preferred
  return options.includes('480P') ? '480P' : options[0] ?? '480P'
}
