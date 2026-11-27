import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ScriptVideoVoiceAudio, ScriptVideoVoiceDescription } from './script-video-types.js'
import {
  formatScriptVideoVoiceDescription,
  mergeScriptVideoVoiceDrafts,
  scriptVideoVoiceProfileDraftSchema,
  scriptVideoVoiceProfileKey,
  type ScriptVideoVoiceAgeStage,
  type ScriptVideoVoiceProfileDraft,
} from './script-video-voice-profile.js'

export const SCRIPT_VOICE_DESCRIPTION_SOURCE = '剧本提取'

export const scriptVideoVoiceProfileSchema = scriptVideoVoiceProfileDraftSchema.extend({
  id: z.uuid(),
  audioConflict: z.literal(true).optional(),
  generatedOutputId: z.uuid().optional(),
})
export type ScriptVideoVoiceProfile = z.infer<typeof scriptVideoVoiceProfileSchema>

type VoiceAsset = {
  id: string
  kind: string
  voiceAudio?: ScriptVideoVoiceAudio
  voiceDescription?: ScriptVideoVoiceDescription
  voiceProfile?: ScriptVideoVoiceProfile
  confirmedVoiceAge?: Exclude<ScriptVideoVoiceAgeStage, 'unknown'>
}
export type ScriptVideoVoiceAssignment = {
  draft: ScriptVideoVoiceProfileDraft
  observedAge?: VoiceAsset['confirmedVoiceAge']
}

export function scriptVideoVoiceMembers<T extends VoiceAsset>(assets: T[], asset: T): T[] {
  const profile = asset.voiceProfile
  return profile && !profile.ageConflict?.length
    ? assets.filter(item => item.kind === 'character' && item.voiceProfile?.id === profile.id && !item.voiceProfile?.ageConflict?.length)
    : [asset]
}

const preservedDescription = (asset: VoiceAsset) => asset.voiceDescription &&
  (asset.voiceAudio || asset.voiceProfile?.generatedOutputId || asset.voiceDescription.sourceLabel !== SCRIPT_VOICE_DESCRIPTION_SOURCE)

function updateVoiceGroup<T extends VoiceAsset>(group: T[], draft: ScriptVideoVoiceProfileDraft, id: string) {
  const audioByUrl = new Map(group.flatMap(asset => asset.voiceAudio ? [[asset.voiceAudio.url, asset.voiceAudio] as const] : []))
  const audioConflict = audioByUrl.size > 1
  const audio = audioByUrl.size === 1 ? audioByUrl.values().next().value : undefined
  const generatedOutputId = group.find(asset => asset.voiceProfile?.generatedOutputId)?.voiceProfile?.generatedOutputId
  const existingDescriptions = new Map(group.flatMap(asset => preservedDescription(asset) && asset.voiceDescription
    ? [[asset.voiceDescription.text, asset.voiceDescription] as const] : []))
  const sharedDescription = existingDescriptions.size === 1 ? existingDescriptions.values().next().value : undefined
  const extracted = { text: formatScriptVideoVoiceDescription(draft), sourceLabel: SCRIPT_VOICE_DESCRIPTION_SOURCE }
  const profile: ScriptVideoVoiceProfile = { ...draft, id, ...(audioConflict && { audioConflict: true }),
    ...(generatedOutputId && { generatedOutputId }) }
  return group.map(asset => {
    const next = { ...asset, voiceProfile: profile }
    next.voiceDescription = preservedDescription(asset) ? asset.voiceDescription : sharedDescription ?? extracted
    if (audio) next.voiceAudio = audio
    return next
  })
}

function sameCharacter(left: ScriptVideoVoiceProfileDraft, right: ScriptVideoVoiceProfileDraft) {
  return scriptVideoVoiceProfileKey(left.character, 'unknown') === scriptVideoVoiceProfileKey(right.character, 'unknown')
}

function assignment(asset: VoiceAsset, proposal: ScriptVideoVoiceProfileDraft) {
  const existing = asset.voiceProfile
  if (!existing) return proposal
  const locked = asset.confirmedVoiceAge || existing.generatedOutputId || asset.voiceAudio || preservedDescription(asset)
  if (existing.key === proposal.key) {
    const ambiguous = Boolean(proposal.ageConflict?.length)
    if (Boolean(existing.ageConflict?.length) !== ambiguous && locked) return existing
    return proposal
  }
  if (!sameCharacter(existing, proposal) || existing.disguise !== proposal.disguise || locked) return existing
  if (proposal.ageConflict?.length) return proposal
  if (proposal.ageStage === 'unknown') return existing
  if (existing.ageStage === 'unknown') return proposal
  return {
    ...proposal,
    key: scriptVideoVoiceProfileKey(proposal.character, 'unknown', proposal.disguise),
    ageStage: 'unknown' as const,
    ageConflict: [...new Set([existing.ageStage, proposal.ageStage])].sort(),
    ageEvidence: [...(existing.ageEvidence ?? []), ...(proposal.ageEvidence ?? [])],
    clues: [], conflicts: [], observations: [],
  }
}

/** Merge observations after all script parts finish, keeping assigned profile IDs stable. */
export function mergeScriptVideoProjectVoices<T extends VoiceAsset>(assets: T[], proposals: ReadonlyMap<string, ScriptVideoVoiceAssignment>): T[] {
  if (!proposals.size) return assets
  const linked = new Map<string, { id: string; drafts: ScriptVideoVoiceProfileDraft[]; members: T[] }>()
  const previousIds = new Map<string, string>()
  for (const asset of assets) {
    const profile = asset.voiceProfile
    if (profile && !profile.ageConflict?.length && !previousIds.has(profile.key)) previousIds.set(profile.key, profile.id)
  }
  // Direct age evidence for an existing appearance can name its previously unnamed stage.
  // Keep the existing ID and audio for the whole group, provided no other profile already owns that stage.
  const newAges = new Map<string, Map<string, ScriptVideoVoiceProfileDraft>>()
  for (const asset of assets) {
    const prior = asset.voiceProfile
    const proposed = proposals.get(asset.id)
    if (!prior || prior.ageStage !== 'unknown' || prior.ageConflict?.length || !proposed?.observedAge ||
        proposed.observedAge !== proposed.draft.ageStage || prior.disguise !== proposed.draft.disguise ||
        !sameCharacter(prior, proposed.draft)) continue
    const candidates = newAges.get(prior.key) ?? new Map<string, ScriptVideoVoiceProfileDraft>()
    candidates.set(proposed.draft.key, proposed.draft)
    newAges.set(prior.key, candidates)
  }
  const promoted = new Map<string, ScriptVideoVoiceProfileDraft>()
  for (const [oldKey, candidates] of newAges) {
    if (candidates.size !== 1) continue
    const [draft] = candidates.values()
    const oldId = previousIds.get(oldKey)
    if (!oldId || previousIds.has(draft.key)) continue
    promoted.set(oldKey, draft)
    previousIds.set(draft.key, oldId)
  }
  for (const original of assets) {
    const previousProfile = original.voiceProfile
    const proposed = proposals.get(original.id)?.draft
    const separatedDisguise = previousProfile && !previousProfile.disguise && proposed?.disguise && sameCharacter(previousProfile, proposed)
    const promotion = previousProfile && !previousProfile.ageConflict?.length ? promoted.get(previousProfile.key) : undefined
    let asset = previousProfile && promotion
      ? { ...original, voiceProfile: { ...previousProfile, key: promotion.key, ageStage: promotion.ageStage } }
      : original
    if (separatedDisguise) {
      asset = { ...asset }
      delete asset.voiceProfile
      if (asset.voiceDescription?.sourceLabel === SCRIPT_VOICE_DESCRIPTION_SOURCE) delete asset.voiceDescription
    }
    const previous = asset.voiceProfile
    if (asset.kind !== 'character' || (!proposed && !previous)) continue
    const proposedPromotion = proposed && !proposed.ageConflict?.length ? promoted.get(proposed.key) : undefined
    const candidate = proposed && proposedPromotion
      ? { ...proposed, key: proposedPromotion.key, ageStage: proposedPromotion.ageStage }
      : proposed
    const draft = candidate ? assignment(asset, candidate) : previous!
    const ambiguous = Boolean(draft.ageConflict?.length)
    const key = ambiguous ? `asset:${asset.id}` : `profile:${draft.key}`
    const priorId = ambiguous ? (previous?.ageConflict?.length ? previous.id : undefined) : previousIds.get(draft.key)
    const group = linked.get(key) ?? { id: priorId ?? randomUUID(), drafts: [], members: [] }
    group.members.push(asset)
    if (previous?.key === draft.key && Boolean(previous.ageConflict?.length) === ambiguous) group.drafts.push(previous)
    if (draft !== previous || !group.drafts.includes(draft)) group.drafts.push(draft)
    linked.set(key, group)
  }
  const updated = new Map<string, T>()
  for (const { id, drafts, members } of linked.values()) {
    const draft = mergeScriptVideoVoiceDrafts(drafts)
    for (const asset of updateVoiceGroup(members, draft, id)) updated.set(asset.id, asset)
  }
  return assets.map(asset => updated.get(asset.id) ?? asset)
}

export function confirmScriptVideoVoiceAge<T extends VoiceAsset>(assets: T[], asset: T, ageStage: NonNullable<VoiceAsset['confirmedVoiceAge']>): T[] {
  const profile = asset.voiceProfile!
  const { ageConflict: _ageConflict, design: _design, ...draft } = profile
  const next = { ...asset, confirmedVoiceAge: ageStage }
  delete next.voiceProfile
  // Clues on a mixed-age appearance cannot safely be assigned to one stage.
  const resolved = {
    ...draft, key: scriptVideoVoiceProfileKey(profile.character, ageStage, profile.disguise), ageStage,
    ageEvidence: draft.ageEvidence?.filter(evidence => evidence.stage === ageStage),
    clues: [], conflicts: [], observations: [],
  }
  return mergeScriptVideoProjectVoices(assets.map(item => item.id === asset.id ? next : item), new Map([[asset.id, { draft: resolved }]]))
}

export function setScriptVideoProfileAudio<T extends VoiceAsset>(assets: T[], asset: T, audio: ScriptVideoVoiceAudio | null): T[] {
  const group = scriptVideoVoiceMembers(assets, asset)
  const distinctAudio = new Set(group.flatMap(item => item.voiceAudio ? [item.voiceAudio.url] : []))
  const changed = group.map(item => {
    if (distinctAudio.size > 1 && item.id !== asset.id) return item
    const next = { ...item }
    if (audio) next.voiceAudio = audio
    else delete next.voiceAudio
    return next
  })
  const { id, audioConflict: _audioConflict, generatedOutputId: _generatedOutputId, ...draft } = asset.voiceProfile!
  const updated = new Map(updateVoiceGroup(changed, draft, id).map(item => [item.id, item]))
  return assets.map(item => updated.get(item.id) ?? item)
}
