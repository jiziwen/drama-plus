const mediaLabels = { image: '图片', video: '视频', audio: '音频' }

/** Slots follow canvas attachment order, starting at one across all media types. */
export function formatJimengReferenceLabel(kind: keyof typeof mediaLabels, slot: number) {
  return mediaLabels[kind] + slot
}

/** Script-video submits images, then audio. Its stored prompt uses type-local indices. */
export function formatJimengScriptPrompt(prompt: string, imageCount: number, audioCount: number) {
  return prompt.replace(/@(?:音频|声音)[\t ]*(\d+)/gu, (tag, rawIndex) => {
    const index = Number(rawIndex)
    return index > 0 && index <= audioCount ? '@' + formatJimengReferenceLabel('audio', imageCount + index) : tag
  })
}
