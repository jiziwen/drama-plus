import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  getScriptVideoOutlineDurationIssues,
  ScriptVideoAIError,
  type ScriptVideoCard,
} from './script-video-types.js'

export const dialogueBoundary = z.object({
  line: z.number().int().nonnegative(),
  endCue: z.string().trim().min(1).optional(),
})

export const episodeTimingPlan = z.object({
  durations: z.array(z.number().positive().max(30)).min(1),
  reason: z.string().trim().min(1),
  dialogueThrough: z.array(dialogueBoundary).optional(),
})

export type EpisodeTimingPlan = z.infer<typeof episodeTimingPlan>

// Stable across interrupted requests; also avoids collisions when an already
// retimed episode is used as the starting point of a new generation.
export function extraSegmentPrefix(original: ScriptVideoCard[]) {
  const key = createHash('sha256').update(JSON.stringify(original.map(card => card.id))).digest('hex')
  let prefix = 'timing-' + key.slice(0, 12) + '-'
  while (original.some(card => card.id.startsWith(prefix))) prefix += 'x'
  return prefix
}

export function applyEpisodeTiming(
  raw: unknown,
  original: ScriptVideoCard[],
  lockedDurations: number[],
) {
  const parsed = episodeTimingPlan.safeParse(raw)
  if (!parsed.success)
    throw new ScriptVideoAIError('TIMING_PLAN_INVALID', '请用 timingPlan 提交全部片段的秒数和调整依据。')
  const plan = parsed.data
  const issues = getScriptVideoOutlineDurationIssues(plan.durations.map(duration => ({ duration })))
  if (issues.length)
    throw new ScriptVideoAIError('TIMING_PLAN_INVALID', issues[0].message, issues)
  if (lockedDurations.some((duration, index) => plan.durations[index] !== duration))
    throw new ScriptVideoAIError('TIMING_PLAN_INVALID', '续写时请保留已完成前段的时长，只重排后续内容。')
  if (plan.dialogueThrough && plan.dialogueThrough.length !== plan.durations.length)
    throw new ScriptVideoAIError('TIMING_PLAN_INVALID', '每个片段都须有一个 dialogueThrough。')
  const sameTiming = original.length === plan.durations.length &&
    original.every((card, index) => card.duration === plan.durations[index])
  const assetIds = [...new Set(original.flatMap(card => card.assetIds))]
  const idPrefix = extraSegmentPrefix(original)
  const outline = plan.durations.map((duration, index): ScriptVideoCard => ({
    id: original[index]?.id ?? idPrefix + (index + 1),
    title: original[index]?.title ?? '第' + (index + 1) + '段',
    summary: original[index]?.summary ?? '',
    combat: original[index]?.combat ?? false,
    dialogueThrough: plan.dialogueThrough?.[index] ?? (sameTiming ? original[index]?.dialogueThrough : undefined),
    assetIds,
    duration,
    shots: [],
    prompt: '',
    version: original[index]?.version ?? 1,
    status: 'draft',
  }))
  return { plan, outline }
}
