// Specifications for the storyboard models in the official Canvas CLI catalog.
const seedance25 = {
  maxDuration: 30, images: 30, videos: 10, audios: 10, maxReferences: 50,
  audioDuration: 30, promptLimit: 15000,
}

export const JIMENG_SEEDANCE_20_MINI_MODEL = 'jimeng-seedance-2.0-mini'

export const jimengVideoModelSpecs = {
  [JIMENG_SEEDANCE_20_MINI_MODEL]: {
    canonicalModel: 'seedance_2.0_mini', resolutions: ['720p'], maxDuration: 15,
    images: 9, videos: 3, audios: 3, maxReferences: 12, audioDuration: 15, promptLimit: 4000,
  },
  'jimeng-seedance-2.5': {
    ...seedance25, canonicalModel: 'seedance_2.5', resolutions: ['480p', '720p', '1080p', '4k'],
  },
  'jimeng-seedance-2.5-draft': {
    ...seedance25, canonicalModel: 'seedance_2.5_draft', resolutions: ['480p'],
  },
  'jimeng-seedance-2.5-flash': {
    ...seedance25, canonicalModel: 'seedance_2.5_flash', resolutions: ['480p', '720p'],
    images: 10, videos: 5, audios: 5, maxReferences: 20,
  },
}

export const jimengVideoModels = Object.keys(jimengVideoModelSpecs)

export function jimengVideoModel(model: string) {
  return Object.hasOwn(jimengVideoModelSpecs, model)
    ? jimengVideoModelSpecs[model as keyof typeof jimengVideoModelSpecs]
    : undefined
}
