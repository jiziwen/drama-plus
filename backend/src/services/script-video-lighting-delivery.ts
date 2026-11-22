import type { ScriptVideoReferenceSettings } from './script-video-reference-settings.js'

export interface ScriptVideoLightingRange {
  /** One-based storyboard shot numbers, inclusive. */
  startShot: number
  endShot: number
  sceneName: string
  lighting?: string
  imageUrl?: string
  transitionIn?: boolean
}

export function manualScriptVideoLightingRanges(ranges: readonly ScriptVideoLightingRange[] | undefined, settings?: ScriptVideoReferenceSettings) {
  return (ranges ?? []).filter((range): range is ScriptVideoLightingRange & { imageUrl: string } =>
    !!range.imageUrl && settings?.lighting?.[range.startShot]?.mode === 'manual')
}

export interface ScriptVideoReferenceLimits {
  maxReferences: number | null
  maxTotalReferences: number | null
}

export function bindScriptVideoLighting(
  ranges: readonly ScriptVideoLightingRange[], shotCount: number, images: readonly { image: string }[], voiceCount: number,
  opening: { imageUrl: string; imageIndex?: number } | undefined, limits: ScriptVideoReferenceLimits | undefined,
  imageTag: (index: number) => string, settings?: ScriptVideoReferenceSettings,
) {
  const referenceByUrl = new Map(images.map(({ image }, i) => [image, imageTag(i + 1)]))
  if (opening) referenceByUrl.set(opening.imageUrl, opening.imageIndex ? imageTag(opening.imageIndex) : '本次提交的首帧')
  const hasDedicatedFirstFrame = !!opening && !opening.imageIndex
  const used = images.length + Number(!!opening?.imageIndex)
  const remaining = Math.min(limits?.maxReferences ?? Infinity, (limits?.maxTotalReferences ?? Infinity) - voiceCount) - used
  const reserved = new Set(manualScriptVideoLightingRanges(ranges, settings).map(range => range.imageUrl).filter(url => !referenceByUrl.has(url)))
  const lightingImages: string[] = [], lightingRanges: ScriptVideoLightingRange[] = [], instructions: string[] = []
  for (const range of ranges) {
    const wholeClip = shotCount === 0 && range.startShot === 1 && range.endShot === 1 && settings?.lighting?.[1]?.mode === 'manual'
    if (!Number.isInteger(range.startShot) || !Number.isInteger(range.endShot) || range.startShot < 1 ||
        range.endShot < range.startShot || (!wholeClip && range.endShot > shotCount) || !range.sceneName.trim()) continue
    const { imageUrl, ...description } = range
    let tag = imageUrl && referenceByUrl.get(imageUrl)
    const manual = imageUrl && reserved.delete(imageUrl)
    if (imageUrl && !tag && !hasDedicatedFirstFrame && lightingImages.length + (manual ? 0 : reserved.size) < remaining) {
      lightingImages.push(imageUrl)
      tag = imageTag(used + lightingImages.length)
      referenceByUrl.set(imageUrl, tag)
    }
    if (!tag && !range.lighting?.trim()) continue
    lightingRanges.push(tag ? range : description)
    const span = wholeClip ? '全段' : range.startShot === range.endShot ? `镜头${range.startShot}` : `镜头${range.startShot}至${range.endShot}`
    const atCut = range.transitionIn ? `，从镜头${range.startShot}切入该场的画面起` : ''
    const source = tag ? `用${tag}参考同场人物受光、阴影、曝光与色调。机位、构图、人物和动作按本镜分镜。` : ''
    instructions.push(`${span}「${range.sceneName}」${atCut}：${[range.lighting?.trim(), source].filter(Boolean).join(' ')}`)
  }
  const prompt = instructions.length
    ? ['分镜光线与影调（各条仅用于标明的镜头，场景素材图用于建筑和空间布局）：', ...instructions].join('\n')
    : ''
  return { lightingImages, lightingRanges, prompt }
}

// Match only standalone global grading directives. A dark costume, a patch of
// sun on the ground, a quoted line or an intentional local light stays intact.
const gradeAxes = [
  { a: /低调(?:戏剧光人像|布光|影调)?|曝光偏低|低曝光|暗部压黑|暗色系|整体偏暗/u, b: /高调(?:布光|影调)|曝光(?:充足)?偏高|高曝光|明亮通透|明亮高质感影调/u,
    aDirective: /^(?:低调(?:戏剧光人像|布光|影调)?|曝光偏低|低曝光|暗色系|整体偏暗|暗部压黑(?:但保留细节)?)$/u,
    bDirective: /^(?:(?:整体画面)?明亮通透|明亮|清爽明亮|高调(?:布光|影调)|高曝光|曝光(?:充足)?偏高(?:但高光不死白)?)$/u },
  { a: /低饱和/u, b: /高饱和/u,
    aDirective: /^(?:蓝灰|自然)?低饱和(?:调色|度|自然)?$/u,
    bDirective: /^(?:自然高饱和|高饱和(?:自然|度|调色)?)$/u },
  { a: /冷色调|蓝灰低饱和/u, b: /暖色调/u,
    aDirective: /^(?:色调倾向)?冷色调$/u, bDirective: /^(?:色调倾向)?暖色调$/u },
  { a: /柔光|柔和(?:的)?(?:间接|散射|漫射)光|漫射光|散射光/u, b: /高反差硬光|硬光质感|硬光照明/u,
    aDirective: /^(?:柔光(?:照明)?|(?:柔和)?(?:散射|漫射)光)$/u, bDirective: /^(?:高反差硬光|硬光质感|硬光照明)$/u },
] as const

function hasGradeCue(text: string, cue: RegExp) {
  return [...text.matchAll(new RegExp(cue.source, 'gu'))].some(match =>
    !/(?:禁止|避免|不要|不得|不用)(?:使用|出现|采用)?\s*$/u.test(text.slice(Math.max(0, match.index - 10), match.index)))
}

/** Reconcile the submitted style prefix only. The editable preset and the
 * original shot directions/dialogue never pass through this filter. */
export function sceneGradedStyle(style: string, ranges: readonly ScriptVideoLightingRange[]): string {
  if (!ranges.length || !style) return style
  const scene = ranges.map(range => range.lighting ?? '').join('\n')
  const grade = /^影调[：:]([^\r\n]*)/mu.exec(style)?.[1] ?? ''
  const remove: RegExp[] = []
  for (const axis of gradeAxes) {
    const sceneA = hasGradeCue(scene, axis.a), sceneB = hasGradeCue(scene, axis.b)
    const styleA = hasGradeCue(style, axis.a), styleB = hasGradeCue(style, axis.b)
    if (sceneA || sceneB) {
      if (sceneA && styleB) remove.push(axis.bDirective)
      if (sceneB && styleA) remove.push(axis.aDirective)
    } else if (styleA && styleB) {
      // A dedicated grading directive takes precedence over general adjectives.
      const gradeA = hasGradeCue(grade, axis.a), gradeB = hasGradeCue(grade, axis.b)
      if (gradeA || !gradeB) remove.push(axis.bDirective)
      if (gradeB || !gradeA) remove.push(axis.aDirective)
    }
  }
  if (!remove.length) return style
  return style.replace(/([^。；\r\n]+)([。；]?)/gu, (whole, sentence: string, ending: string) => {
    const parts = sentence.split(/([，,、])/u)
    let result = '', changed = false
    for (let i = 0; i < parts.length; i += 2) {
      const label = /^(.*?[：:]\s*)/u.exec(parts[i])?.[1] ?? ''
      const directive = parts[i].slice(label.length).trim()
      if (remove.some(pattern => pattern.test(directive))) {
        changed = true
        result += label
      } else {
        if (result && i && !/[：:]\s*$/u.test(result)) result += parts[i - 1]
        result += parts[i]
      }
    }
    if (!changed) return whole
    return !result.trim() || /^[^：:]*[：:]\s*$/u.test(result) ? '' : result + ending
  })
}
