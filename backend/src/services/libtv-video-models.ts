/** Model keys and limits returned by LibTV CLI 1.2.0's model schema. */
export const LIBTV_VIDEO_RATIOS: readonly string[] = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']
export const LIBTV_SEEDANCE_20_MINI_MODEL = 'star-video2-mini'

const seedance25 = {
  minDuration: 4,
  maxDuration: 30,
  audioDuration: 30,
  images: 30,
  videos: 10,
  audios: 10,
  maxReferences: 50,
}

const models = [
  { id: LIBTV_SEEDANCE_20_MINI_MODEL, name: 'Seedance 2.0 Mini', minDuration: 4, maxDuration: 15,
    audioDuration: 15, images: 9, videos: 3, audios: 3, maxReferences: 15,
    resolutions: ['480p', '720p'], defaultResolution: '720p' },
  { ...seedance25, id: 'star-video2.5-flash', name: 'Seedance 2.5 Flash', resolutions: ['480p', '720p'], defaultResolution: '720p',
    images: 10, videos: 5, audios: 5, maxReferences: 20 },
  { ...seedance25, id: 'star-video2.5-draft', name: 'Seedance 2.5（样片模式）', resolutions: ['480p'], defaultResolution: '480p' },
  { ...seedance25, id: 'star-video2.5', name: 'Seedance 2.5', resolutions: ['480p', '720p', '1080p', '4k'], defaultResolution: '720p' },
]

export const libtvVideoModels = models.map(model => model.id)

export function libtvVideoModel(id: string) {
  return models.find(model => model.id === id)
}
