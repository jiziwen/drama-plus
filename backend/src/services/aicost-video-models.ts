// The gateway keeps model IDs exact on the wire. Capability detection is only for local controls.
const standardRatios = ['16:9', '9:16', '1:1', '4:3', '3:4']
export const AICOST_VIDEO_RATIOS = [...standardRatios, '21:9', 'adaptive', '2:3', '3:2']
export const AICOST_VIDEO_RESOLUTIONS = ['480p', '720p', '1080p', '1k', '2k', '1440p', '4k']

export function isAicostMiniMaxH3Model(model: string) {
  return /^(?:minimax-h3|hailuo-03)(?:[-.]|$)/iu.test(model)
}

export function isAicostSeedance25Model(model: string) {
  return /^seedance2\.5(?:-|$)/iu.test(model)
}

export function isAicostSeedance20Model(model: string) {
  return /^seedance2\.0(?:-|$)/iu.test(model)
}

interface AicostVideoModelCapabilities {
  minDuration: number
  maxDuration: number
  maxReferences: number | null
  maxVideoReferences: number | null
  maxAudioReferences: number | null
  maxTotalReferences: number | null
  maxAudioDuration: number
  wholeSeconds: true
  ratios: string[]
  resolutions: string[]
  version?: '2.0' | '2.5'
}

/** Public gateway bounds. Individual channels can impose tighter limits than the family. */
export function aicostVideoModelCapabilities(model: string): AicostVideoModelCapabilities | null {
  const fixedResolution = model.toLowerCase().split('-').find(part => AICOST_VIDEO_RESOLUTIONS.includes(part))
  const defaults = { wholeSeconds: true as const, maxAudioDuration: 0 }
  if (isAicostSeedance25Model(model)) {
    return { ...defaults, version: '2.5', minDuration: 1, maxDuration: 30, maxReferences: 30,
      maxVideoReferences: 10, maxAudioReferences: 10, maxTotalReferences: 50,
      ratios: [...standardRatios, '21:9', 'adaptive'], resolutions: fixedResolution ? [fixedResolution] : ['720p', '1080p', '1k', '2k'] }
  }
  if (isAicostSeedance20Model(model)) {
    const picturesOnly = /^seedance2\.0-(?:mini|fast|standard)(?:-(?:480p|720p|1080p))?$/iu.test(model)
    // AICost publishes duration and media counts per model. Leave unspecified counts to the gateway.
    return { ...defaults, version: '2.0', minDuration: 1, maxDuration: 30, maxReferences: null,
      maxVideoReferences: picturesOnly ? 0 : null, maxAudioReferences: picturesOnly ? 0 : null, maxTotalReferences: null,
      ratios: standardRatios, resolutions: fixedResolution ? [fixedResolution] : ['480p', '720p', '1080p'] }
  }
  if (isAicostMiniMaxH3Model(model)) {
    return { ...defaults, minDuration: 5, maxDuration: 15, maxReferences: 5,
      maxVideoReferences: 0, maxAudioReferences: 3, maxTotalReferences: 8,
      ratios: [...standardRatios, '21:9'], resolutions: ['1440p'] }
  }
  const wan = /^wan3\.0-(?:(?:480p|720p|1080p)-([34])|(dh|dj)-(?:480p|720p|1080p))$/iu.exec(model)
  if (wan && fixedResolution) {
    const maxVideoReferences = wan[2]?.toLowerCase() === 'dj' ? 0 : 5
    return { ...defaults, minDuration: wan[1] ? 5 : 4, maxDuration: 30, maxReferences: 10,
      maxVideoReferences, maxAudioReferences: 5, maxTotalReferences: 15 + maxVideoReferences,
      ratios: standardRatios, resolutions: [fixedResolution] }
  }
  return null
}
