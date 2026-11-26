import { z } from 'zod'
import {
  formalFields,
  formalContext,
  productionFields,
  shotFields,
  type ScriptVideoCard,
  type ScriptVideoIssue,
  ScriptVideoAIError,
} from './script-video-types.js'

export const repairOutput = z
  .object({
    production: productionFields.optional(),
    patches: z.array(
      z
        .object({
          id: z.string().min(1),
          fields: formalContext
            .extend({
              title: z.string().trim().min(1),
              summary: z.string().trim().min(1),
              assetIds: z.array(z.string().min(1)),
              combat: z.boolean(),
            })
            .partial()
            .strict()
            .optional(),
          shots: z
            .array(shotFields.partial().extend({ index: z.number().int().positive() }).strict())
            .optional(),
          replacement: formalFields.optional(),
        })
        .strict(),
    ),
  })
  .strict()
export type EpisodeCandidate = {
  cards: unknown[]
  production?: unknown
  placement?: { cardId: string; message: string; received?: unknown }[]
}
export type EpisodeIssue = ScriptVideoIssue & { cardId?: string }
export const objectData = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export function applyEpisodePatch(
  candidate: EpisodeCandidate,
  outline: ScriptVideoCard[],
  issues: EpisodeIssue[],
  patch: z.infer<typeof repairOutput>,
): EpisodeCandidate {
  const reject = (message: string): never => {
    throw new ScriptVideoAIError('REPAIR_SCOPE', message)
  }
  const cards = [...candidate.cards]
  const allowed = new Set(issues.flatMap((issue) => (issue.cardId ? [issue.cardId] : [])))
  const seen = new Set<string>()
  for (const item of patch.patches) {
    if (!allowed.has(item.id) || seen.has(item.id))
      reject('修复指定了未报告或重复的片段：' + item.id)
    seen.add(item.id)
    const index = outline.findIndex((card) => card.id === item.id)
    const draft = objectData(cards[index])
    if (item.replacement) {
      if (
        formalFields.safeParse(draft).success ||
        item.replacement.id !== item.id ||
        item.shots ||
        item.fields
      )
        reject('仅缺失或字段结构损坏的片段可按原 ID 完整补交。')
      cards[index] = item.replacement
      continue
    }
    const shots: unknown[] = Array.isArray(draft.shots) ? [...draft.shots] : []
    const editedShots = new Set<number>()
    for (const { index: number, ...changes } of item.shots ?? []) {
      if (number > shots.length || editedShots.has(number)) reject('镜号不在本片段内或重复。')
      editedShots.add(number)
      const previous = objectData(shots[number - 1])
      const edited = { ...previous, ...changes }
      if (changes.visualAssetIds === undefined &&
          (changes.camera !== undefined && changes.camera !== previous.camera ||
            changes.action !== undefined && changes.action !== previous.action))
        delete edited.visualAssetIds
      if (changes.speakerAssetIds === undefined && changes.dialogue !== undefined && changes.dialogue !== previous.dialogue)
        delete edited.speakerAssetIds
      shots[number - 1] = edited
    }
    const edited = { ...draft, ...item.fields, id: item.id, shots }
    if (item.fields?.openingAssetIds === undefined && item.fields?.opening !== undefined && item.fields.opening !== draft.opening)
      delete edited.openingAssetIds
    cards[index] = edited
  }
  const placement = candidate.placement?.filter((issue) => !seen.has(issue.cardId))
  const production = issues.some((issue) => !issue.cardId)
    ? patch.production ?? candidate.production
    : candidate.production
  return { production, cards, placement }
}

// Prefer source paragraphs that actually contain the cited speech or outline anchors.
// A repair budget also bounds the fallback window when a malformed draft has no anchors.
export function episodeRepairSource(script: string, focus: string, fraction: number): string {
  const lines = script.split(/\r?\n/u)
  const quotations = [...focus.matchAll(/[“「『"]([^”」』"\n]{2,})[”」』"]/gu)].map((m) => m[1])
  const tokens = new Set(
    focus
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.flatMap((word) =>
        word.length < 5
          ? [word]
          : Array.from({ length: word.length - 3 }, (_, i) => word.slice(i, i + 4)),
      ) ?? [],
  )
  const ranked = lines
    .map((line, index) => {
      let score = quotations.some((quote) => line.includes(quote)) ? 100 : 0
      for (const token of tokens) if (line.includes(token)) score++
      return { index, score }
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
  const selected = new Set<number>()
  const anchors = ranked.length
    ? ranked.slice(0, 8).map((hit) => hit.index)
    : [Math.floor((lines.length - 1) * fraction)]
  for (const n of anchors)
    for (const delta of [-1, 0, 1]) if (lines[n + delta]?.trim()) selected.add(n + delta)
  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .join('\n')
    .slice(0, 6500)
}
