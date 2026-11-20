import type { ScriptVideoLightingRange } from './script-video-delivery.js'
import { buildScriptVideoLightingPlan, type ScriptVideoLightingSceneRange } from './script-video-lighting-plan.js'
import type { ScriptVideoJob, ScriptVideoProject } from './script-video-store.js'
import { compareVideoLightingFrames, extractVideoLightingFrame } from '../utils/video-lighting-frame.js'

type LightingSource = {
  cardId: string
  taskId: number
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
  pendingPrevious?: boolean
}
export type RenderLightingRange = ScriptVideoLightingRange & {
  sceneKey: string
  source?: LightingSource
}
export type LightingCheck = { shot: number; start: number; end: number; reference: string }
type AcceptedTask = { id: string; taskId: number; videoUrl: string; videoDuration?: number; lightingRanges?: RenderLightingRange[] }

function shotEnd(card: { shots: { duration: number }[] }, index: number) {
  return card.shots.slice(0, index).reduce((sum, shot) => sum + shot.duration, 0)
}

/** Take a read-only snapshot of server-owned renders inside the project lock.
 * The selected ready URL also identifies an explicitly restored older result. */
export function planScriptVideoLighting(project: ScriptVideoProject, episodeId: string, jobs: ScriptVideoJob[]) {
  const episode = project.episodes.find(item => item.id === episodeId)
  const result: Record<string, PlannedRange[]> = Object.create(null)
  if (!episode) return result
  const ranges = buildScriptVideoLightingPlan(episode.cards, episode.confirmedScript || episode.script, project.assets)
  const completedJobs = new Map(jobs.filter(job => job.episodeId === episodeId && job.action === 'video' &&
    job.status === 'completed' && !job.staleResult && job.taskId).map(job => [job.id, job]))
  const selectedVideos = new Map(episode.cards.filter((card: any) => card.status === 'ready' && card.videoUrl)
    .map((card: any) => [card.id, card.videoUrl]))
  const ready = new Map<string, AcceptedTask>()
  for (const task of episode.tasks || []) {
    const job = completedJobs.get(task.id)
    if (job && job.cardId === task.cardId && job.taskId === task.taskId && task.status === 'completed' &&
        !task.staleResult && task.videoUrl && selectedVideos.get(task.cardId) === task.videoUrl) {
      ready.set(task.cardId, { ...task, videoDuration: job.videoDuration })
    }
  }
  const baselines = new Map<string, LightingSource>()
  const pending = new Set(jobs.filter(job => job.action === 'video' && job.episodeId === episodeId &&
    (job.status === 'queued' || job.status === 'running')).map(job => job.cardId))
  let boundary: { sceneKey: string; source: LightingSource } | undefined
  let pendingScene: string | undefined
  for (const card of episode.cards) {
    const task = ready.get(card.id)
    const scenes = ranges[card.id] || []
    result[card.id] = scenes.map((scene: ScriptVideoLightingSceneRange) => {
      const sampleShot = scene.transitionIn ? scene.firstShot + 1 : scene.firstShot
      return {
        range: { startShot: scene.firstShot, endShot: scene.lastShot, sceneName: scene.sceneName,
          lighting: scene.lighting, ...(scene.transitionIn && { transitionIn: true }) },
        sceneKey: scene.sceneKey,
        source: baselines.get(scene.sceneKey),
        previous: scene.firstShot === 1 && boundary?.sceneKey === scene.sceneKey ? boundary.source : undefined,
        pendingPrevious: scene.firstShot === 1 && pendingScene === scene.sceneKey && !baselines.has(scene.sceneKey),
        sampleStart: scene.stableStartSeconds,
        sampleEnd: Math.min(scene.stableEndSeconds, scene.stableStartSeconds + 2, shotEnd(card, sampleShot)),
      }
    })
    boundary = undefined
    pendingScene = pending.has(card.id) && scenes.at(-1)?.lastShot === card.shots?.length ? scenes.at(-1)?.sceneKey : undefined
    if (!task) continue
    const durationScale = task.videoDuration === undefined ? 1 : task.videoDuration / shotEnd(card, card.shots.length)
    for (const scene of scenes) {
      if (scene.stableEndSeconds <= scene.stableStartSeconds) continue
      const end = scene.stableEndSeconds
      const last = card.shots.findIndex((_: unknown, i: number) => shotEnd(card, i + 1) >= end - 0.001)
      const start = Math.max(scene.stableStartSeconds, end - 2.5 / durationScale, shotEnd(card, Math.max(0, last)))
      const source: LightingSource = { cardId: card.id, taskId: task.taskId, videoUrl: task.videoUrl,
        start: start * durationScale, end: end * durationScale, stableStart: scene.stableStartSeconds * durationScale }
      // A render made with this feature records the original baseline. A legacy
      // render starts from its own final stable shot, allowing adoption mid-scene.
      const inherited = task.lightingRanges?.find(r => r.sceneKey === scene.sceneKey && r.imageUrl)?.source
      const active = inherited && ready.get(inherited.cardId)
      const validInherited = inherited && active && active.taskId === inherited.taskId && active.videoUrl === inherited.videoUrl
      const baseline = validInherited ? inherited : task.lightingRanges ? baselines.get(scene.sceneKey) ?? source : source
      baselines.set(scene.sceneKey, baseline)
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
