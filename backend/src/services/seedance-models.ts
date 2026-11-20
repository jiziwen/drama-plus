/** Ark reference-generation limits. Agent Plan uses the dotted 2.0 model IDs. */
export function isSeedance25Model(model?: string | null): boolean {
  return /^doubao-seedance-2-5(?:-flash)?(?:-\d{6})?$/.test(model || '')
}

export function seedanceModelLimits(model: string) {
  if (isSeedance25Model(model)) {
    const flash = model.includes('-flash')
    return {
      version: '2.5', minDuration: 4, maxDuration: 30,
      images: flash ? 10 : 30, videos: flash ? 5 : 10, audios: flash ? 5 : 10,
      audioDuration: 30, resolutions: flash ? ['480p', '720p'] : ['480p', '720p', '1080p', '4k'],
    }
  }
  if (model.startsWith('doubao-seedance-2-0') || ['doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini'].includes(model)) {
    return {
      version: '2.0', minDuration: 4, maxDuration: 15,
      images: 9, videos: 3, audios: 3, audioDuration: 15, resolutions: ['480p', '720p'],
    }
  }
  return null
}
