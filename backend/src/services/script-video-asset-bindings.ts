import { scriptVideoCharacterBase } from './script-video-asset-identity.js'
import { scriptVideoAssetSourceScenes, type ScriptVideoAssetBindingRequirement } from './script-video-asset-scenes.js'
import { annotateScriptVideoAssets, type MentionAsset } from './script-video-mentions.js'
import type { ScriptVideoAsset, ScriptVideoInput } from './script-video-types.js'

type Requirement = ScriptVideoAssetBindingRequirement
type BindingShot = { camera?: string; action?: string; dialogue?: string; visualAssetIds?: string[]; speakerAssetIds?: string[] }
type BindingCard = {
  id: string; title?: string; summary?: string; prompt?: string; scene?: string; opening?: string; characters?: string
  assetIds: string[]; shots: readonly BindingShot[]; openingAssetIds?: string[]; excludedAssetIds?: string[]
  sourceSceneIds?: string[]; assetBindingRequirements?: Requirement[]
}
type Asset = MentionAsset & Pick<ScriptVideoAsset, 'assetIdentity' | 'aliases' | 'image'>
type Scene = ReturnType<typeof scriptVideoAssetSourceScenes>[number]
const kinds = new Set(['character', 'scene', 'prop', 'creature'])
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
const namesOf = (asset: Asset) => [...new Set([asset.name, ...(asset.aliases ?? []), asset.assetIdentity?.split(/[｜|]/u, 1)[0],
  asset.kind === 'character' ? scriptVideoCharacterBase(asset) : asset.originalName])].filter((name): name is string => !!name && name.length >= 2)
const familyOf = (asset: Asset) => asset.assetIdentity?.split(/[｜|]/u, 1)[0] ||
  (asset.kind === 'character' ? scriptVideoCharacterBase(asset) : asset.originalName || asset.name)
const contains = (text: string, label: string) => normalize(text).includes(normalize(label))

function sceneMention(text: string, sceneId: string) {
  const escaped = sceneId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const prefix = /^场景\d+$/u.test(sceneId) ? '(?:场次|场号)\\s*:?\\s*' : '(?:^|[^\\d])'
  return new RegExp(`${prefix}${escaped}(?![\\d/])`, 'u').test(text.normalize('NFKC'))
}

function sceneLabel(scene: Scene) {
  return scene.title.split(' · ').at(-1)!.replace(/^(?:场景|地点)\s*[：:]\s*/u, '')
    .replace(/^(?:场次\s*[：:]\s*)?\d+\s*[-－]\s*\d+\s*|^第[零〇一二三四五六七八九十百两\d]+场\s*/u, '').trim()
}

function evidenceScene(script: string, scenes: Scene[], quote: string, offset: number, recorded?: string): Scene | undefined | false {
  if (script.slice(offset, offset + quote.length) !== quote) {
    offset = script.indexOf(quote)
    if (offset < 0 || script.indexOf(quote, offset + 1) !== -1) return false
  }
  const scene = scenes.find(item => offset >= item.start && offset + quote.length <= item.end)
  if (!scene && recorded) return false
  return scene
}

export function scriptVideoSourceAssetMap(input: Pick<ScriptVideoInput, 'script' | 'episodeNumber' | 'assets'>) {
  const script = input.script.trim()
  const scenes = scriptVideoAssetSourceScenes(script)
  const evidence = new Map<string, Map<string, string>>()
  const groups = new Map<string, { item: Requirement; exact: Set<string>; byName: Set<string> }>()
  function record(asset: ScriptVideoAsset, label: string, scene: Scene | undefined, quote?: string) {
    const key = JSON.stringify([scene?.id ?? '', asset.kind, normalize(label)])
    const group = groups.get(key) ?? {
      item: { key, label, kind: asset.kind as Requirement['kind'], candidateIds: [], episodeNumber: input.episodeNumber,
        ...(scene && { sceneId: scene.id, sceneTitle: scene.title }) },
      exact: new Set<string>(), byName: new Set<string>(),
    }
    if (quote) {
      group.exact.add(asset.id)
      const byAsset = evidence.get(key) ?? new Map<string, string>()
      if (!byAsset.has(asset.id)) byAsset.set(asset.id, quote)
      evidence.set(key, byAsset)
    } else group.byName.add(asset.id)
    groups.set(key, group)
  }
  for (const asset of input.assets.filter(asset => kinds.has(asset.kind))) {
    for (const evidence of asset.occurrences ?? []) {
      if (evidence.episodeNumber && input.episodeNumber && evidence.episodeNumber !== input.episodeNumber) continue
      const scene = evidenceScene(script, scenes, evidence.quote, evidence.offset, evidence.sceneId)
      if (scene !== false) record(asset, evidence.label, scene, evidence.quote)
    }
    for (const scene of scenes.length ? scenes : [undefined]) {
      const text = normalize(scene ? script.slice(scene.start, scene.end) : script)
      for (const name of namesOf(asset)) if (text.includes(normalize(name))) record(asset, name, scene)
    }
  }
  const requirements = [...groups.values()].map(({ item, exact, byName }) => ({ ...item, candidateIds: [...(exact.size ? exact : byName)] }))
  return { scenes, requirements, evidence }
}

export function scriptVideoCardSceneIds(card: Pick<BindingCard, 'title' | 'summary' | 'scene' | 'sourceSceneIds'>, scenes: Scene[]): string[] {
  const description = [card.title, card.summary, card.scene].filter(Boolean).join('\n')
  const explicit = scenes.filter(scene => sceneMention(description, scene.id))
  if (explicit.length) return explicit.map(scene => scene.id)
  const named = scenes.filter(scene => {
    const label = sceneLabel(scene)
    return label.length >= 2 && contains(description, label)
  })
  if (named.length === 1) return [named[0].id]
  const declared = scenes.filter(scene => card.sourceSceneIds?.includes(scene.id))
  return (declared.length ? declared : named.length ? named : scenes.length === 1 ? scenes : []).map(scene => scene.id)
}

function assetIdsInCard(card: BindingCard) {
  return [...new Set([...card.assetIds, ...(card.openingAssetIds ?? []), ...card.shots.flatMap(shot =>
    [...(shot.visualAssetIds ?? []), ...(shot.speakerAssetIds ?? [])])])]
}

function isSourceLocation(requirement: Requirement) {
  if (requirement.kind !== 'scene' || !requirement.sceneId || !requirement.sceneTitle) return false
  const title = sceneLabel({ id: requirement.sceneId, title: requirement.sceneTitle, start: 0, end: 0 })
  return !!title && contains(title, requirement.label)
}

function familyCandidates(requirement: Requirement, assets: readonly Asset[]) {
  if (isSourceLocation(requirement)) return assets.filter(asset => asset.kind === 'scene')
  const direct = assets.filter(asset => requirement.candidateIds.includes(asset.id) || requirement.assetId === asset.id)
  const families = new Set(direct.map(asset => normalize(familyOf(asset))))
  return assets.filter(asset => asset.kind === requirement.kind && (direct.includes(asset) ||
    families.has(normalize(familyOf(asset))) || namesOf(asset).some(name => normalize(name) === normalize(requirement.label))))
}

function sceneForShot(card: BindingCard, index: number, sceneIds: string[]) {
  if (sceneIds.length === 1) return sceneIds[0]
  if (!sceneIds.length) return
  const sections = (card.scene ?? '').split(/\r?\n|[；;]/u)
  const matches = sceneIds.filter(sceneId => sections.some(line => {
    if (!sceneMention(line, sceneId)) return false
    const range = /(?:镜头|镜号)\s*(\d+)(?:\s*[-–—~～至到]\s*(?:镜头)?\s*(\d+))?/u.exec(line)
    return range && index + 1 >= Number(range[1]) && index + 1 <= Number(range[2] || range[1])
  }))
  return matches.length === 1 ? matches[0] : undefined
}

function bindingScope(card: BindingCard, index?: number) {
  const requirements = card.assetBindingRequirements ?? []
  const sceneIds = card.sourceSceneIds?.length ? card.sourceSceneIds : [...new Set(requirements.flatMap(item => item.sceneId ?? []))]
  const scene = index === undefined ? sceneIds.length === 1 ? sceneIds[0] : undefined : sceneForShot(card, index, sceneIds)
  return scene ? requirements.filter(item => !item.sceneId || item.sceneId === scene) : requirements
}

function alternativeMap(requirements: Requirement[], assets: readonly Asset[]) {
  const alternatives = new Map<string, Set<string>>()
  for (const requirement of requirements) {
    for (const asset of familyCandidates(requirement, assets)) {
      const targetIds = alternatives.get(asset.id) ?? new Set<string>()
      if (requirement.assetId) targetIds.add(requirement.assetId)
      else for (const id of requirement.candidateIds) targetIds.add(id)
      alternatives.set(asset.id, targetIds)
    }
  }
  return alternatives
}

function promptSections(prompt = '') {
  return prompt.split(/(?=^镜头\s*\d+)/mu).map(text => {
    const number = /^镜头\s*(\d+)/u.exec(text)?.[1]
    return { text, index: number ? Number(number) - 1 : undefined }
  })
}

function scopedAssets(text: string | undefined, assets: readonly Asset[], boundIds: string[], dialogue = false) {
  return annotateScriptVideoAssets(text ?? '', assets, boundIds, { autoBind: true, dialogue }).mentions
    .filter(hit => !hit.literal && hit.usage !== 'context' && hit.usage !== 'audio')
}

export function scriptVideoAssetBindingIssues(card: BindingCard, assets: readonly Asset[]) {
  const list = card.assetBindingRequirements ?? []
  if (!list.length) return []
  const sceneIds = card.sourceSceneIds ?? []
  return list.flatMap(requirement => {
    const selected = assets.find(asset => asset.id === requirement.assetId && asset.kind === requirement.kind)
    const location = requirement.sceneTitle ? `（${requirement.sceneTitle}）` : ''
    const prefix = `「${requirement.label}」${location}`
    if (!selected || !requirement.candidateIds.includes(selected.id) || !card.assetIds.includes(selected.id) || card.excludedAssetIds?.includes(selected.id))
      return [{ requirement, message: `请选择${prefix}对应的资产。` }]
    if (selected.image === '')
      return [{ requirement, message: `「${selected.name}」还没有参考图，请生成、上传或选择已有图片的资产。` }]
    const alternatives = new Set(familyCandidates(requirement, assets).filter(asset => asset.id !== selected.id).map(asset => asset.id))
    const conflicting = (ids: string[], index?: number) => {
      const scope = bindingScope(card, index)
      if (!scope.includes(requirement)) return false
      return ids.some(id => alternatives.has(id) && !scope.some(item => item.assetId === id)) ||
        (index !== undefined && !!requirement.sceneId && sceneIds.length > 1 && !sceneForShot(card, index, sceneIds) &&
          scope.some(item => item.sceneId !== requirement.sceneId && !!item.assetId && alternatives.has(item.assetId)) &&
          ids.some(id => id === selected.id || alternatives.has(id)))
    }
    const conflict = card.shots.some((shot, index) => conflicting([
      ...(shot.visualAssetIds ?? []), ...(shot.speakerAssetIds ?? []),
      ...scopedAssets([shot.camera, shot.action].join('\n'), assets, card.assetIds).map(hit => hit.id),
      ...scopedAssets(shot.dialogue, assets, card.assetIds, true).filter(hit => hit.explicit).map(hit => hit.id),
    ], index)) || conflicting(card.openingAssetIds ?? [], 0)
      || promptSections(card.prompt).some(({ text, index }) => conflicting(scopedAssets(text, assets, card.assetIds)
        .filter(hit => hit.explicit).map(hit => hit.id), index))
    return conflict ? [{ requirement, message: `${prefix}的镜头引用有冲突。请核对场次的镜头范围或重新选择资产。` }] : []
  })
}

export function applyScriptVideoAssetBindings<T extends BindingCard>(card: T, assets: readonly Asset[]): T {
  const list = card.assetBindingRequirements ?? []
  if (!list.some(item => item.assetId)) return card
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const unique = (map: Map<string, Set<string>>, id: string) => {
    const targets = map.get(id)
    return targets?.size === 1 ? [...targets][0] : id
  }
  const replaceIds = (ids: string[] | undefined, map: Map<string, Set<string>>) => ids && [...new Set(ids.map(id => unique(map, id)))]
  function rewrite(text: string | undefined, map: Map<string, Set<string>>, dialogue = false) {
    if (!text) return text
    let result = '', offset = 0
    for (const hit of scopedAssets(text, assets, card.assetIds, dialogue)) {
      const replacement = unique(map, hit.id)
      const asset = byId.get(replacement)
      if (!asset || replacement === hit.id || (dialogue && (!hit.explicit || hit.usage !== 'speaker'))) continue
      result += text.slice(offset, hit.start) + (hit.explicit ? '@' : '') + asset.name
      offset = hit.end
    }
    return result + text.slice(offset)
  }
  const combined = alternativeMap(list, assets)
  const scoped = (index: number) => alternativeMap(bindingScope(card, index), assets)
  const shots = card.shots.map((shot, index) => {
    const map = scoped(index)
    return { ...shot, camera: rewrite(shot.camera, map), action: rewrite(shot.action, map), dialogue: rewrite(shot.dialogue, map, true),
      visualAssetIds: replaceIds(shot.visualAssetIds, map), speakerAssetIds: replaceIds(shot.speakerAssetIds, map) }
  })
  const names = card.prompt && promptSections(card.prompt).map(({ text, index }) =>
    rewrite(text, index === undefined ? combined : scoped(index))).join('')
  const selected = list.flatMap(item => item.assetId ?? [])
  return { ...card, shots, prompt: names, scene: rewrite(card.scene, combined), opening: rewrite(card.opening, scoped(0)),
    characters: rewrite(card.characters, combined),
    openingAssetIds: replaceIds(card.openingAssetIds, scoped(0)), assetIds: [...new Set([...card.assetIds.map(id => unique(combined, id)), ...selected])],
    ...(card.excludedAssetIds && { excludedAssetIds: card.excludedAssetIds.filter(id => !selected.includes(id)) }) }
}

export function resolveScriptVideoAssetBinding<T extends BindingCard>(card: T, key: string, assetId: string, assets: readonly Asset[]): T | undefined {
  const target = card.assetBindingRequirements?.find(item => item.key === key)
  if (!target || !assets.some(asset => asset.id === assetId && asset.kind === target.kind)) return
  const list = card.assetBindingRequirements!.map(item => item === target ? { ...item, assetId, confirmed: true as const,
    candidateIds: [...new Set([...item.candidateIds, assetId])] } : item)
  return applyScriptVideoAssetBindings({ ...card, assetBindingRequirements: list }, assets)
}

export function planScriptVideoCardBindings<T extends BindingCard>(card: T, input: ScriptVideoInput, approved?: BindingCard): T {
  const { scenes, requirements, evidence } = scriptVideoSourceAssetMap(input)
  if (!requirements.length) return approved?.assetBindingRequirements?.length
    ? applyScriptVideoAssetBindings({ ...card, assetBindingRequirements: approved.assetBindingRequirements }, input.assets) : card
  const approvedScenes = approved ? scriptVideoCardSceneIds(approved, scenes) : []
  const proposed = approvedScenes.length ? approvedScenes : scriptVideoCardSceneIds(card, scenes)
  const byId = new Map(input.assets.map(asset => [asset.id, asset]))
  const explicitIds = new Set(assetIdsInCard(card))
  const visualText = [card.scene, card.opening, ...card.shots.flatMap(shot => [shot.camera, shot.action])].filter(Boolean).join('\n')
  const inferred = new Set([
    ...scopedAssets(visualText, input.assets, card.assetIds).map(hit => hit.id),
    ...card.shots.flatMap(shot => scopedAssets(shot.dialogue, input.assets, card.assetIds, true).map(hit => hit.id)),
  ])
  const list = requirements.flatMap(requirement => {
    if (proposed.length && requirement.sceneId && !proposed.includes(requirement.sceneId)) return []
    const family = familyCandidates(requirement, input.assets)
    if (!(isSourceLocation(requirement) && proposed.includes(requirement.sceneId!)) &&
        !family.some(asset => inferred.has(asset.id) || explicitIds.has(asset.id)) && !contains(visualText, requirement.label)) return []
    const previous = approved?.assetBindingRequirements?.find(item => item.key === requirement.key && item.confirmed)
    if (previous?.assetId && byId.has(previous.assetId)) return [{ ...requirement, assetId: previous.assetId, confirmed: true as const,
      candidateIds: [...new Set([...requirement.candidateIds, previous.assetId])] }]
    const candidates = requirement.candidateIds
    const exact = candidates.filter(id => {
      const asset = byId.get(id)
      const source = scenes.find(scene => scene.id === requirement.sceneId)
      const text = evidence.get(requirement.key)?.get(id) ?? (source ? input.script.trim().slice(source.start, source.end) : input.script)
      const variant = asset?.assetIdentity?.split(/[｜|]/u).at(1)?.trim()
      return asset && contains(visualText, asset.name) && (contains(text, asset.name) ||
        (variant && variant.length >= 2 && contains(text, variant)))
    })
    const assetId = candidates.length === 1 ? candidates[0] : exact.length === 1 ? exact[0] : undefined
    return [{ ...requirement, ...(assetId && { assetId }) }]
  })
  const selected = new Map<string, Requirement>()
  for (const item of list) {
    const key = JSON.stringify([item.sceneId, item.kind, [...item.candidateIds].sort()])
    const previous = selected.get(key)
    if (!previous || item.confirmed || (!previous.assetId && item.assetId)) selected.set(key, item)
  }
  if (!selected.size) return proposed.length ? { ...card, sourceSceneIds: proposed } : card
  return applyScriptVideoAssetBindings({ ...card, ...(proposed.length && { sourceSceneIds: proposed }), assetBindingRequirements: [...selected.values()] }, input.assets)
}
