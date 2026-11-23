export type ScriptVideoFrameChoice = { mode: 'off' } | {
  mode: 'manual'
  videoUrl: string
  seconds: number
  sourceCardId?: string
  sourceEpisodeId?: string
}

export type ScriptVideoReferenceSettings = {
  tail?: ScriptVideoFrameChoice
  /** One entry per light range, keyed by its one-based starting shot. */
  lighting?: Record<string, ScriptVideoFrameChoice>
}

export type ScriptVideoReferenceFrameRow = {
  kind: 'tail' | 'lighting'
  startShot?: number
  endShot?: number
  sceneName?: string
  mode: 'auto' | ScriptVideoFrameChoice['mode']
  state: 'ready' | 'pending' | 'missing' | 'off'
  imageUrl?: string
  videoUrl?: string
  seconds?: number
  sourceLabel?: string
  sourceCardId?: string
  sourceEpisodeId?: string
}

export type ScriptVideoReferenceFrameSource = { cardId: string; videoUrl: string; sourceLabel: string; sourceEpisodeId?: string }

export type ScriptVideoReferenceFrames = {
  tail?: ScriptVideoReferenceFrameRow
  lighting: ScriptVideoReferenceFrameRow[]
  previousEpisodeSources?: ScriptVideoReferenceFrameSource[]
  projectSources?: ScriptVideoReferenceFrameSource[]
  previousPlayableSource?: ScriptVideoReferenceFrameSource
  candidate?: { imageUrl: string; videoUrl: string; seconds: number; sourceCardId?: string; sourceEpisodeId?: string }
}

const object = (input: unknown): input is Record<string, unknown> =>
  !!input && typeof input === 'object' && !Array.isArray(input)

export function validScriptVideoFrameTime(seconds: unknown): seconds is number {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400
}

export function scriptVideoReferenceSourceUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 1024 ||
      !/^\/?static\/videos\/[^?#%\\\p{Cc}]+\.(?:mp4|webm|mov|m4v)$/iu.test(value) ||
      value.replace(/^\//u, '').split('/').some(part => !part || part === '.' || part === '..')) return undefined
  return '/' + value.replace(/^\//u, '')
}

export function scriptVideoReferenceSettings(input: unknown): ScriptVideoReferenceSettings | undefined {
  if (input === undefined) return undefined
  const invalid = () => { throw new Error('分镜参考帧设置无效') }
  if (!object(input) || Object.keys(input).some(key => key !== 'tail' && key !== 'lighting')) return invalid()

  const choice = (value: unknown): ScriptVideoFrameChoice => {
    if (!object(value)) return invalid()
    if (value.mode === 'off' && Object.keys(value).length === 1) return { mode: 'off' }
    if (value.mode === 'manual' && Object.keys(value).every(key => ['mode', 'videoUrl', 'seconds', 'sourceCardId', 'sourceEpisodeId'].includes(key)) &&
        validScriptVideoFrameTime(value.seconds)) {
      const videoUrl = scriptVideoReferenceSourceUrl(value.videoUrl)
      const { sourceCardId, sourceEpisodeId } = value
      if (videoUrl && (sourceCardId === undefined || validScriptVideoReferenceCardId(sourceCardId)) &&
          (sourceEpisodeId === undefined || !!sourceCardId && validScriptVideoReferenceCardId(sourceEpisodeId)))
        return { mode: 'manual', videoUrl, seconds: Number(value.seconds.toFixed(3)), ...(sourceCardId && { sourceCardId }),
          ...(sourceEpisodeId && { sourceEpisodeId }) }
    }
    return invalid()
  }

  const tail = input.tail === undefined ? undefined : choice(input.tail)
  const lighting: Record<string, ScriptVideoFrameChoice> = {}
  if (input.lighting !== undefined) {
    if (!object(input.lighting) || Object.keys(input.lighting).length > 500) return invalid()
    for (const [shot, value] of Object.entries(input.lighting)) {
      if (!/^[1-9]\d{0,3}$/u.test(shot)) return invalid()
      lighting[shot] = choice(value)
    }
  }
  if (!tail && !Object.keys(lighting).length) return undefined
  return { ...(tail && { tail }), ...(Object.keys(lighting).length && { lighting }) }
}

export function validScriptVideoReferenceCardId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(id)
}

export function updateScriptVideoReferenceChoice(
  settings: ScriptVideoReferenceSettings | undefined,
  reference: Pick<ScriptVideoReferenceFrameRow, 'kind' | 'startShot'>,
  choice: ScriptVideoFrameChoice | undefined,
): ScriptVideoReferenceSettings | undefined {
  const next = { ...settings }
  if (reference.kind === 'tail') {
    if (choice) next.tail = choice
    else delete next.tail
  } else if (reference.startShot !== undefined) {
    const lighting = { ...settings?.lighting }
    if (choice) lighting[reference.startShot] = choice
    else delete lighting[reference.startShot]
    if (Object.keys(lighting).length) next.lighting = lighting
    else delete next.lighting
  }
  return next.tail || next.lighting ? next : undefined
}
