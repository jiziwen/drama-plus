import type { ScriptVideoLightingRange } from './script-video-delivery.js'
import { buildScriptVideoLightingPlan, type ScriptVideoLightingSceneRange } from './script-video-lighting-plan.js'
import type { ScriptVideoJob, ScriptVideoProject } from './script-video-store.js'
import { officialScriptVideoUrl, type ScriptVideoVersion } from './script-video-versions.js'
import { compareVideoLightingFrames, extractVideoLightingFrame } from '../utils/video-lighting-frame.js'

type LightingSource = {
  cardId: string
  taskId?: number
  videoUrl: string
  start: number
  end: number
  stableStart: number
}
type PlannedRange = {
  range: ScriptVideoLightingRange
  sceneKey: string
  source?: LightingSource
  previous?: LightingSource
  sampleStart: number
  sampleEnd: number
  pendingCardId?: string
}
export type RenderLightingRange = ScriptVideoLightingRange & {
  sceneKey: string
  source?: LightingSource
}
export type LightingCheck = { shot: number; start: number; end: number; reference: string }
type SelectedRender = { taskId?: number; cardVersion?: number; videoUrl: string; videoDuration?: number }

type VideoCard = { id: string; status?: string; videoUrl?: string; videoVersions?: readonly ScriptVideoVersion[]; version: number }

export function isActiveScriptVideoRender(job: ScriptVideoJob, card: VideoCard) {
  return job.action === 'video' && job.cardId === card.id && job.cardVersion === card.version &&
    (job.status === 'queued' || job.status === 'running')
}

export function selectedScriptVideoRenders(episode: ScriptVideoProject['episodes'][number], jobs: readonly ScriptVideoJob[]) {
  const ready = new Map<string, SelectedRender>()
  for (const card of episode.cards as VideoCard[]) {
    const videoUrl = officialScriptVideoUrl(card)
    if (videoUrl) ready.set(card.id, { videoUrl,
      videoDuration: card.videoVersions?.find(version => version.url === videoUrl)?.duration })
  }
  const completedJobs = new Map(jobs.filter(job => job.episodeId === episode.id && job.action === 'video' &&
    job.status === 'completed' && job.taskId).map(job => [job.id, job]))
  for (const task of episode.tasks || []) {
    const job = completedJobs.get(task.id)
    const selected = ready.get(task.cardId)
    if (job && job.cardId === task.cardId && job.taskId === task.taskId && task.status === 'completed' &&
        selected && selected.videoUrl === task.videoUrl) {
      // The selected URL can be a deliberately promoted historical render.
      ready.set(task.cardId, { taskId: task.taskId, videoUrl: task.videoUrl,
        cardVersion: job.cardVersion, videoDuration: job.videoDuration ?? selected.videoDuration })
    }
  }
  return ready
}

function shotEnd(card: { shots: { duration: number }[] }, index: number) {
  return card.shots.slice(0, index).reduce((sum, shot) => sum + shot.duration, 0)
}

/** Take a read-only snapshot of server-owned renders inside the project lock.
 * The selected ready URL also identifies an explicitly restored older result. */
export function planScriptVideoLighting(
  project: ScriptVideoProject, episodeId: string, jobs: ScriptVideoJob[], queuedCards: ReadonlySet<string> = new Set(),
) {
  const episode = project.episodes.find(item => item.id === episodeId)
  const result: Record<string, PlannedRange[]> = Object.create(null)
  if (!episode) return result
  const ranges = buildScriptVideoLightingPlan(episode.cards, episode.confirmedScript || episode.script, project.assets)
  const ready = selectedScriptVideoRenders(episode, jobs)
  const cardsById = new Map<string, VideoCard>(episode.cards.map((card: VideoCard) => [card.id, card]))
  const pending = new Set(queuedCards)
  for (const job of jobs) {
    if (job.episodeId !== episodeId || !job.cardId) continue
    const card = cardsById.get(job.cardId)
    if (card && isActiveScriptVideoRender(job, card)) pending.add(card.id)
  }
  const sources = new Map<string, { source?: LightingSource; pendingCardId?: string }>()
  let boundary: { sceneKey: string; source: LightingSource } | undefined
  for (const card of episode.cards) {
    const task = ready.get(card.id)
    const scenes = ranges[card.id] || []
    result[card.id] = scenes.map((scene: ScriptVideoLightingSceneRange) => {
      const sampleShot = scene.transitionIn ? scene.firstShot + 1 : scene.firstShot
      return {
        range: { startShot: scene.firstShot, endShot: scene.lastShot, sceneName: scene.sceneName,
          lighting: scene.lighting, ...(scene.transitionIn && { transitionIn: true }) },
        sceneKey: scene.sceneKey,
        ...sources.get(scene.sceneKey),
        previous: scene.firstShot === 1 && boundary?.sceneKey === scene.sceneKey ? boundary.source : undefined,
        sampleStart: scene.stableStartSeconds,
        sampleEnd: Math.min(scene.stableEndSeconds, scene.stableStartSeconds + 2, shotEnd(card, sampleShot)),
      }
    })
    boundary = undefined
    if (pending.has(card.id)) {
      for (const scene of scenes) {
        if (scene.stableEndSeconds > scene.stableStartSeconds) sources.set(scene.sceneKey, { pendingCardId: card.id })
      }
      continue
    }
    if (!task) continue
    const durationScale = task.videoDuration === undefined ? 1 : task.videoDuration / shotEnd(card, card.shots.length)
    for (const scene of scenes) {
      if (scene.stableEndSeconds <= scene.stableStartSeconds) continue
      const end = scene.stableEndSeconds
      const last = card.shots.findIndex((_: unknown, i: number) => shotEnd(card, i + 1) >= end - 0.001)
      const start = Math.max(scene.stableStartSeconds, end - 2.5 / durationScale, shotEnd(card, Math.max(0, last)))
      const source: LightingSource = { cardId: card.id, taskId: task.taskId, videoUrl: task.videoUrl,
        start: start * durationScale, end: end * durationScale, stableStart: scene.stableStartSeconds * durationScale }
      sources.set(scene.sceneKey, { source })
      if (scene.lastShot === card.shots.length) boundary = { sceneKey: scene.sceneKey, source }
    }
  }
  return result
}

export async function prepareScriptVideoLighting(
  plans: readonly PlannedRange[], extract = extractVideoLightingFrame,
) {
  const ranges: RenderLightingRange[] = []
  const checks: LightingCheck[] = []
  const frames = new Map<string, Promise<string | null>>()
  function frame(source: LightingSource) {
    const key = JSON.stringify(source)
    let value = frames.get(key)
    if (!value) {
      value = (async () => {
        const image = await extract(source.videoUrl, source.start, source.end)
        if (image || source.stableStart >= source.start) return image
        return extract(source.videoUrl, source.stableStart, source.end)
      })().catch(() => null)
      frames.set(key, value)
    }
    return value
  }
  for (const { range, sceneKey, source, previous, sampleStart, sampleEnd } of plans) {
    const imageUrl = source && await frame(source)
    ranges.push({ ...range, sceneKey, ...(imageUrl && { source, imageUrl }) })
    if (previous && sampleEnd > sampleStart) {
      const reference = await frame(previous)
      if (reference) checks.push({ shot: range.startShot, start: sampleStart, end: sampleEnd, reference })
    }
  }
  return { ranges, checks }
}

export async function reviewScriptVideoLighting(
  videoUrl: string, checks: readonly LightingCheck[],
  extract = extractVideoLightingFrame, compare = compareVideoLightingFrames,
) {
  const shots: number[] = []
  for (const check of checks) {
    const frame = await extract(videoUrl, check.start, check.end)
    if (frame && await compare(check.reference, frame) === 'review') shots.push(check.shot)
  }
  return shots
}
