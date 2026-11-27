import { z } from 'zod'

const knownAgeStages = ['child', 'teen', 'adult', 'older_adult'] as const
const knownAgeStage = z.enum(knownAgeStages)
export const scriptVideoVoiceAgeStageSchema = z.enum([...knownAgeStages, 'unknown'])
export type ScriptVideoVoiceAgeStage = z.infer<typeof scriptVideoVoiceAgeStageSchema>
const character = z.string().trim().min(1).max(180)
const evidence = z.object({
  title: z.string().min(1).max(400),
  episodeNumber: z.number().int().positive().optional(),
  quote: z.string().min(1).max(120),
  offset: z.number().int().nonnegative().optional(),
})
const ageEvidence = evidence.extend({ stage: knownAgeStage })
const clueFields = {
  facet: z.enum(['register', 'timbre', 'pace', 'articulation', 'accent', 'delivery', 'volume']),
  value: z.string().trim().min(1).max(32),
  source: z.enum(['explicit', 'habit']),
}
const clue = z.object({ ...clueFields, evidence: z.array(evidence).min(1).max(8) })
const voiceDesignPart = z.string().trim().min(1).max(40).regex(/^[^｜|\r\n]+$/u).optional().catch(undefined)
const voiceDesign = z.object({
  ageFeel: voiceDesignPart,
  timbre: voiceDesignPart,
  delivery: voiceDesignPart,
  volume: voiceDesignPart,
  pace: voiceDesignPart,
  accent: voiceDesignPart,
})
const voiceDisguise = z.enum(['male_as_female', 'female_as_male'])
type VoiceDisguise = z.infer<typeof voiceDisguise>
export const scriptVideoVoiceDisguiseLabels: Record<VoiceDisguise, string> = { male_as_female: '男扮女装', female_as_male: '女扮男装' }

export const scriptVideoVoiceProfileDraftSchema = z.object({
  key: z.string().min(1).max(400),
  character,
  ageStage: scriptVideoVoiceAgeStageSchema,
  ageConflict: z.array(knownAgeStage).min(2).max(knownAgeStages.length).optional(),
  ageEvidence: z.array(ageEvidence).max(16).optional(),
  clues: z.array(clue).max(12),
  conflicts: z.array(clue).max(48),
  observations: z.array(clue).max(48).optional(),
  design: voiceDesign.optional(),
  disguise: voiceDisguise.optional(),
})

export type ScriptVideoVoiceProfileDraft = z.infer<typeof scriptVideoVoiceProfileDraftSchema>
type KnownAgeStage = z.infer<typeof knownAgeStage>
type Evidence = z.infer<typeof evidence>
type AgeEvidence = z.infer<typeof ageEvidence>
type Clue = z.infer<typeof clue>
type VoiceObservation = {
  character?: string
  age?: AgeEvidence
  clues: Clue[]
  design?: z.infer<typeof voiceDesign>
  disguise?: VoiceDisguise
}
type VoiceAppearance<T> = {
  item: T
  identity?: string
  names: readonly string[]
  existing?: ScriptVideoVoiceProfileDraft
  existingLocked?: boolean
  observations: readonly VoiceObservation[]
}

const modelVoice = z.object({
  character: character.optional().catch(undefined),
  age: z.object({ stage: knownAgeStage, quote: evidence.shape.quote.trim().min(1) }).optional().catch(undefined),
  clues: z.array(z.unknown()).optional().catch(undefined),
  design: voiceDesign.optional().catch(undefined),
  disguise: voiceDisguise.optional().catch(undefined),
})
const modelClue = z.object({ ...clueFields, quote: evidence.shape.quote.trim().min(1) })
const explicitHabit = /一向|向来|总是|始终|惯常|说话习惯|平时|常年|素来|习惯于/u
const transientDelivery = /情急之下|一时激动|气急败坏|压住怒火|咬牙切齿|泣不成声|哽咽着|哭喊|怒吼|惊呼|吓得|压低声音|提高嗓门|捏着嗓子/u
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
const clueValueKey = (value: string) => normalize(value).replace(/^[\p{P}]+|[\p{P}]+$/gu, '')
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const subject = (identity?: string) => identity?.split(/[｜|]/u, 1)[0]?.trim() || undefined

export const scriptVideoVoiceProfileKey = (character: string, ageStage: ScriptVideoVoiceAgeStage, disguise?: VoiceDisguise) =>
  disguise ? `${normalize(character)}:${ageStage}:${disguise}` : `${normalize(character)}:${ageStage}`

export function scriptVideoVoiceDisguiseFromLabel(label?: string) {
  return voiceDisguise.options.find(disguise => label?.includes(scriptVideoVoiceDisguiseLabels[disguise]))
}

const ageFeelByStage: Record<ScriptVideoVoiceAgeStage, string> = {
  child: '儿童年龄感', teen: '青少年年龄感', adult: '成年年龄感', older_adult: '老年年龄感', unknown: '年龄感贴合角色',
}

export function formatScriptVideoVoiceDescription(draft: ScriptVideoVoiceProfileDraft) {
  const { design, clues, ageStage, ageConflict, disguise } = draft
  const supported = (...facets: Clue['facet'][]) =>
    [...new Set(facets.flatMap(facet => clues.filter(item => item.facet === facet).map(item => item.value)))].join('，')
  const disguiseVoice = disguise === 'male_as_female' ? '女声伪装，音色自然'
    : disguise === 'female_as_male' ? '男声伪装，音色自然' : '自然声线，音色清晰'
  return [
    ageConflict?.length ? '年龄感待确认' : design?.ageFeel || ageFeelByStage[ageStage],
    supported('timbre', 'register') || design?.timbre || disguiseVoice,
    supported('delivery', 'articulation') || design?.delivery || '自然说话，咬字清楚',
    supported('volume') || design?.volume || '中等音量',
    supported('pace') || design?.pace || '正常语速',
    supported('accent') || design?.accent || '中文普通话',
  ].map(part => part.replace(/[｜|\r\n]+/gu, '，')).join('｜')
}

export function readScriptVideoVoiceObservation(
  value: unknown,
  chunk: { text: string; offset: number; source: { title: string; episodeNumber?: number } },
): VoiceObservation | undefined {
  const result = modelVoice.safeParse(value)
  if (!result.success) return
  const { character, age, design, disguise } = result.data
  const locate = (quote: string): Evidence | undefined => {
    const index = chunk.text.indexOf(quote)
    if (index === -1) return
    return { title: chunk.source.title, episodeNumber: chunk.source.episodeNumber, quote, offset: chunk.offset + index }
  }
  const ageQuote = age && locate(age.quote)
  const clues = (result.data.clues ?? []).slice(0, 12).flatMap(value => {
    const parsed = modelClue.safeParse(value)
    if (!parsed.success) return []
    const { quote, ...details } = parsed.data
    if (transientDelivery.test(quote) && !explicitHabit.test(quote)) return []
    const excerpt = locate(quote)
    return excerpt && clueValueKey(details.value) ? [{ ...details, evidence: [excerpt] }] : []
  })
  return { character: subject(character), age: age && ageQuote ? { ...ageQuote, stage: age.stage } : undefined, clues,
    ...(design && { design }), ...(disguise && { disguise }) }
}

function compareEvidence(left: Evidence, right: Evidence) {
  return (left.episodeNumber ?? Infinity) - (right.episodeNumber ?? Infinity)
    || compare(left.title, right.title) || (left.offset ?? Infinity) - (right.offset ?? Infinity)
    || right.quote.length - left.quote.length || compare(left.quote, right.quote)
}

function mergeEvidence<T extends Evidence>(values: readonly T[], limit: number): T[] {
  const merged: T[] = []
  for (const current of [...values].sort(compareEvidence)) {
    if (merged.some(prior => prior.title === current.title && prior.episodeNumber === current.episodeNumber && (
      prior.offset !== undefined && current.offset !== undefined
        ? prior.offset < current.offset + current.quote.length && current.offset < prior.offset + prior.quote.length
        : prior.quote === current.quote
    ))) continue
    merged.push(current)
    if (merged.length === limit) break
  }
  return merged
}

function mergeClues(values: readonly Clue[]) {
  const byFacet = new Map<Clue['facet'], Map<string, Clue[]>>()
  for (const clue of values) {
    const key = clueValueKey(clue.value)
    if (!key) continue
    const facet = byFacet.get(clue.facet) ?? new Map<string, Clue[]>()
    const group = facet.get(key) ?? []
    group.push(clue)
    facet.set(key, group)
    byFacet.set(clue.facet, facet)
  }
  const clues: Clue[] = []
  const conflicts: Clue[] = []
  const observations: Clue[] = []
  for (const [facet, values] of [...byFacet].sort(([left], [right]) => compare(left, right))) {
    const candidates = [...values].sort(([left], [right]) => compare(left, right)).map(([, group]): Clue => {
      const explicit = group.filter(clue => clue.source === 'explicit')
      const supported = explicit.length ? explicit : group
      const value = supported.map(clue => clue.value).sort(compare)[0]
      return { facet, value, source: explicit.length ? 'explicit' : 'habit', evidence: mergeEvidence(supported.flatMap(clue => clue.evidence), 8) }
    })
    const explicit = candidates.filter(clue => clue.source === 'explicit')
    const strongest = explicit.length ? explicit : candidates.filter(clue => clue.evidence.length > 1)
    if (strongest.length === 1) clues.push(strongest[0])
    if (strongest.length > 1) conflicts.push(...strongest)
    observations.push(...candidates.filter(clue => !strongest.includes(clue)))
  }
  return { clues, conflicts: conflicts.slice(0, 48), ...(observations.length && { observations: observations.slice(0, 48) }) }
}

export function mergeScriptVideoVoiceDrafts(drafts: readonly ScriptVideoVoiceProfileDraft[]): ScriptVideoVoiceProfileDraft {
  const [first] = drafts
  if (!first) throw new Error('缺少角色声音资料。')
  if (drafts.some(draft => draft.key !== first.key || draft.ageStage !== first.ageStage || draft.disguise !== first.disguise)) {
    throw new Error('不能合并不同人物、年龄阶段或易装造型的声音资料。')
  }
  const ageConflict = knownAgeStages.filter(stage => drafts.some(draft => draft.ageConflict?.includes(stage)))
  const allAgeEvidence = drafts.flatMap(draft => draft.ageEvidence ?? [])
  const ageEvidence = knownAgeStages.flatMap(stage => mergeEvidence(allAgeEvidence.filter(item => item.stage === stage), 4))
  const design = ageConflict.length > 1 ? undefined : bestVoiceDesign(drafts)
  return {
    key: first.key, character: first.character, ageStage: first.ageStage,
    ...(ageConflict.length > 1 && { ageConflict }),
    ...(ageEvidence.length && { ageEvidence }),
    ...(design && { design }),
    ...(first.disguise && { disguise: first.disguise }),
    ...mergeClues(drafts.flatMap(draft => [...draft.clues, ...draft.conflicts, ...draft.observations ?? []])),
  }
}

function bestVoiceDesign(items: readonly { design?: z.infer<typeof voiceDesign> }[]) {
  let best: z.infer<typeof voiceDesign> | undefined
  let bestLength = 0
  for (const { design } of items) {
    const length = design ? Object.values(design).filter(Boolean).length : 0
    if (length <= bestLength) continue
    best = design
    bestLength = length
  }
  return best
}

export function reconcileScriptVideoVoiceProfiles<T>(appearances: readonly VoiceAppearance<T>[]): Map<T, ScriptVideoVoiceProfileDraft> {
  const appearancesByVisualSubject = new Map<string, VoiceAppearance<T>[]>()
  const canonicalByVisualSubject = new Map<string, string>()
  for (const appearance of appearances) {
    const visualSubject = subject(appearance.identity)
    if (!visualSubject) continue
    const key = normalize(visualSubject)
    const group = appearancesByVisualSubject.get(key) ?? []
    group.push(appearance)
    appearancesByVisualSubject.set(key, group)
  }
  const statedCharacter = (appearance: VoiceAppearance<T>) =>
    appearance.observations.find(observation => observation.character)?.character
  for (const [key, group] of appearancesByVisualSubject) {
    const existing = group.find(item => item.existing)?.existing?.character
    const stated = group.flatMap(item => statedCharacter(item) ?? [])
    const oneSubject = new Set(stated.map(normalize)).size === 1
    const canonical = existing ?? stated.find(label => normalize(label) === key) ?? (oneSubject ? stated[0] : undefined)
      ?? subject(group[0].identity)
    if (canonical) canonicalByVisualSubject.set(key, canonical)
  }
  const identities = appearances.flatMap(appearance => {
    const visualSubject = subject(appearance.identity)
    const explicit = appearance.existing?.character || statedCharacter(appearance)
    const character = appearance.existing?.character ?? (visualSubject && canonicalByVisualSubject.get(normalize(visualSubject))) ?? explicit
    const disguise = appearance.existing?.disguise ?? scriptVideoVoiceDisguiseFromLabel(appearance.identity)
      ?? scriptVideoVoiceDisguiseFromLabel(appearance.names[0])
      ?? appearance.observations.find(observation => observation.disguise)?.disguise
    return character ? [{ appearance, character, explicit: Boolean(explicit), disguise }] : []
  })
  const subjects = new Set(identities.map(({ character, explicit }) => explicit ? normalize(character) : undefined).filter(Boolean))
  const aliases = new Map<string, Set<string>>()
  for (const { appearance, character, explicit } of identities) {
    if (!explicit) continue
    const key = normalize(character)
    for (const label of [...appearance.names, subject(appearance.identity)]) {
      if (!label) continue
      const alias = normalize(label)
      if (subjects.has(alias)) continue
      const owners = aliases.get(alias) ?? new Set<string>()
      owners.add(key)
      aliases.set(alias, owners)
    }
  }

  const families = new Map<string, typeof identities>()
  for (const identity of identities) {
    const base = normalize(identity.character)
    const owners = aliases.get(base)
    const owner = owners?.size === 1 ? [...owners][0] : base
    const key = JSON.stringify([owner, identity.disguise])
    const family = families.get(key) ?? []
    family.push(identity)
    families.set(key, family)
  }

  const result = new Map<T, ScriptVideoVoiceProfileDraft>()
  for (const family of families.values()) {
    const { disguise } = family[0]
    const character = family.find(({ appearance }) => appearance.existing)?.appearance.existing?.character
      ?? family.find(({ explicit }) => explicit)?.character ?? family[0].character
    const lockedUnknown = ({ existing, existingLocked }: VoiceAppearance<T>) =>
      existingLocked && existing?.ageStage === 'unknown' && !existing.ageConflict?.length
    const hasLockedUnknown = family.some(({ appearance }) => lockedUnknown(appearance))
    const agesByAppearance = family.map(({ appearance }) => {
      const { existing, observations } = appearance
      return knownAgeStages.filter(stage => existing?.ageStage === stage || existing?.ageConflict?.includes(stage)
        || observations.some(observation => observation.age?.stage === stage))
    })
    const familyAges = knownAgeStages.filter(stage => agesByAppearance.some(ages => ages.includes(stage)))
    const byProfile = new Map<string, { items: T[]; drafts: ScriptVideoVoiceProfileDraft[] }>()
    for (const [index, { appearance }] of family.entries()) {
      const ages = agesByAppearance[index]
      const inferFamilyAge = !lockedUnknown(appearance) && (!hasLockedUnknown || familyAges.length > 1)
      const availableAges = ages.length || !inferFamilyAge ? ages : familyAges
      const stage = availableAges.length === 1 ? availableAges[0] : 'unknown'
      const key = family.find(({ appearance: { existing } }) => existing && existing.disguise === disguise &&
        existing.ageStage === stage && !existing.ageConflict?.length)
        ?.appearance.existing?.key
        ?? scriptVideoVoiceProfileKey(character, stage, disguise)
      const group = byProfile.get(key) ?? { items: [], drafts: [] }
      const ageEvidence = appearance.observations.flatMap(observation => observation.age ? [observation.age] : [])
      if (availableAges.length > 1) {
        const draft: ScriptVideoVoiceProfileDraft = {
          key, character, ageStage: 'unknown', ageConflict: availableAges, ageEvidence, clues: [], conflicts: [],
          ...(disguise && { disguise }),
        }
        const existing = appearance.existing
        if (existing?.ageConflict?.length && existing.key === key) draft.ageEvidence = [...existing.ageEvidence ?? [], ...ageEvidence]
        result.set(appearance.item, mergeScriptVideoVoiceDrafts([draft]))
        continue
      }
      group.items.push(appearance.item)
      if (appearance.existing?.key === key) group.drafts.push(appearance.existing)
      const design = bestVoiceDesign(appearance.observations)
      group.drafts.push({
        key, character, ageStage: stage, ageEvidence,
        clues: appearance.observations.flatMap(observation => observation.clues), conflicts: [],
        ...(design && { design }),
        ...(disguise && { disguise }),
      })
      byProfile.set(key, group)
    }
    for (const { items, drafts } of byProfile.values()) {
      const profile = mergeScriptVideoVoiceDrafts(drafts)
      for (const item of items) result.set(item, profile)
    }
  }
  return result
}
