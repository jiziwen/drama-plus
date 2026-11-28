import { z } from 'zod'

export const scriptVideoAssetOccurrenceSchema = z.object({
  label: z.string().trim().min(1).max(180),
  quote: z.string().trim().min(1).max(160),
  sourceTitle: z.string().trim().min(1).max(400),
  episodeNumber: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative(),
  sceneId: z.string().trim().min(1).max(80).optional(),
  sceneTitle: z.string().trim().min(1).max(240).optional(),
})
export type ScriptVideoAssetOccurrence = z.infer<typeof scriptVideoAssetOccurrenceSchema>

export const scriptVideoAssetBindingRequirementSchema = z.object({
  key: z.string().min(1).max(400),
  label: z.string().trim().min(1).max(180),
  kind: z.enum(['character', 'scene', 'prop', 'creature']),
  episodeNumber: z.number().int().positive().optional(),
  sceneId: z.string().min(1).max(80).optional(),
  sceneTitle: z.string().min(1).max(240).optional(),
  candidateIds: z.array(z.string().min(1)).min(1),
  assetId: z.string().min(1).optional(),
  confirmed: z.literal(true).optional(),
})
export type ScriptVideoAssetBindingRequirement = z.infer<typeof scriptVideoAssetBindingRequirementSchema>

type SourceScene = { id: string; title: string; start: number; end: number }
const numbered = /^(?:(?:场次|场号)\s*:?\s*)?([1-9]\d*)\s*[-‐‑‒–—―]\s*(\d{1,3})(?=$|[^\d])\s*(.*)$/u
const written = /^(?:场次[：:]\s*)?第\s*([零〇一二三四五六七八九十百两\d]+)\s*场(?:\s*[:：.、-])?\s*(.*)$/u
const unnumbered = /^(?:场景|地点)\s*:\s*(.+)$/u

export function normalizeScriptVideoSceneNumbers(text: string): string {
  return text.normalize('NFKC').replace(/(?<![\d/])([1-9]\d*)\s*[-‐‑‒–—―]\s*(\d{1,3})(?:\s*\/\s*(\d+))?(?![\d/])/gu,
    (_, episode, scene, repeat) => `${episode}-${String(Number(scene)).padStart(2, '0')}${repeat ? `/${Number(repeat)}` : ''}`)
}

/** Slice the original script using its own scene headings and character offsets. */
export function scriptVideoAssetSourceScenes(script: string): SourceScene[] {
  const headings: SourceScene[] = [], locations: SourceScene[] = []
  const occurrences = new Map<string, number>()
  let pendingLocation: SourceScene | undefined
  for (const line of script.matchAll(/^[^\r\n]+/gmu)) {
    const display = line[0].trim().replace(/^#{1,6}\s+|\*{1,2}/gu, '').trim()
    const text = display.normalize('NFKC')
    const number = numbered.exec(text), ordinal = written.exec(text), location = unnumbered.exec(text)
    if (number || ordinal) {
      const key = number ? `${Number(number[1])}-${String(Number(number[2])).padStart(2, '0')}` : `第${ordinal![1]}场`
      const count = (occurrences.get(key) ?? 0) + 1
      occurrences.set(key, count)
      const scene = { id: count === 1 ? key : key + '/' + count, title: display.slice(0, 240), start: line.index, end: script.length }
      headings.push(scene)
      pendingLocation = (number?.[3] ?? ordinal?.[2])?.trim() ? undefined : scene
    } else if (location) {
      locations.push({ id: `场景${locations.length + 1}`, title: display.slice(0, 240), start: line.index, end: script.length })
      if (pendingLocation) {
        pendingLocation.title = location[1].trim().slice(0, 240)
        pendingLocation = undefined
      }
    }
  }
  const scenes = headings.length ? headings : locations
  return scenes.map((scene, index) => ({ ...scene, end: scenes[index + 1]?.start ?? script.length }))
}
