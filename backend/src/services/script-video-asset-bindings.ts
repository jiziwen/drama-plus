import { scriptVideoCharacterBase } from './script-video-asset-identity.js'
import { normalizeScriptVideoSceneNumbers, scriptVideoAssetSourceScenes, type ScriptVideoAssetBindingRequirement } from './script-video-asset-scenes.js'
import { scriptVideoAssetScopeRanges, scriptVideoShotHeadings } from './script-video-asset-scope.js'
import { annotateScriptVideoAssets, isScriptVideoGenericCharacterRole, isScriptVideoSingleHanName, scriptVideoMaterialEvidenceText, type MentionAsset } from './script-video-mentions.js'
import type { ScriptVideoAsset, ScriptVideoInput } from './script-video-types.js'

type Requirement = ScriptVideoAssetBindingRequirement
type BindingShot = { camera?: string; action?: string; dialogue?: string; visualAssetIds?: string[]; speakerAssetIds?: string[] }
type BindingCard = {
  id: string; title?: string; summary?: string; prompt?: string; scene?: string; opening?: string; characters?: string
  assetIds: string[]; shots: readonly BindingShot[]; openingAssetIds?: string[]; excludedAssetIds?: string[]
  sourceSceneIds?: string[]; assetBindingRequirements?: Requirement[]
  status?: string; videoUrl?: string; manuallyAdded?: true
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

const untrustedSourceLabel = (asset: Asset, label: string) => isScriptVideoSingleHanName(label.trim()) ||
  asset.kind === 'character' && isScriptVideoGenericCharacterRole(label.trim())

function sourceDeclaresCharacter(asset: Asset, label: string, source: string) {
  if (asset.kind !== 'character') return false
  const assetName = normalize(asset.name)
  const displayBase = normalize(scriptVideoCharacterBase({ ...asset, assetIdentity: undefined }))
  const role = normalize(label)
  for (const line of source.matchAll(/^[ \t]*(?:人物|出场人物|角色|出场角色)[：:][ \t]*([^\r\n]+)/gmu)) {
    for (const entry of line[1].split(/[、，,；;]/u)) {
      const name = normalize(entry.trim().replace(/^@/u, ''))
      if (name === role && (name === assetName || name === displayBase)) return true
      if (name === `${role}(${assetName})` || name === `${assetName}(${role})`) return true
    }
  }
  return false
}

function sceneMention(text: string, sceneId: string) {
  const normalized = normalizeScriptVideoSceneNumbers(sceneId)
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const prefix = /^场景\d+$/u.test(normalized) ? '(?:场次|场号)\\s*:?\\s*' : '(?:^|[^\\d])'
  // A shot range and a timestamp can share the same digits as a source scene.
  const sceneText = text.normalize('NFKC')
    .replace(/(?:(?:镜头|镜号|时间)(?:范围|区间|段)?|时长)\s*:?\s*\d+(?::\d+)*(?:\.\d+)?\s*(?:秒|s)?\s*[-‐‑‒–—―~至到]\s*(?:(?:镜头|镜号)\s*)?\d+(?::\d+)*(?:\.\d+)?/giu, ' ')
    .replace(/\d+(?::\d+)*(?:\.\d+)?\s*(?:秒|s)?\s*[-‐‑‒–—―~至到]\s*\d+(?::\d+)*(?:\.\d+)?\s*(?:秒|分钟|小时|s(?![a-z]))/giu, ' ')
    .replace(/\d+(?::\d+)+(?:\.\d+)?\s*[-‐‑‒–—―~至到]\s*\d+(?::\d+)+(?:\.\d+)?/gu, ' ')
  return new RegExp(`${prefix}${escaped}(?![\\d/])`, 'u').test(normalizeScriptVideoSceneNumbers(sceneText))
}

function sceneLabel(scene: Scene) {
  return normalizeScriptVideoSceneNumbers(scene.title)
    .replace(/^(?:(?:场次|场号)\s*:?\s*)?\d+-\d+\s*|^第[零〇一二三四五六七八九十百两\d]+场\s*/u, '')
    .replace(/^[\s:、|-]+/u, '').replace(/^(?:场景|地点)\s*:\s*/u, '').trim()
}

function sceneSections(text: string) {
  return text.split(/\r?\n|[；;](?=[ \t]*(?:场景[一二三四五六七八九十\d０-９]*|地点)\s*[：:])/u)
    .map(section => section.trim())
    .filter(section => section && !/^(?:@[^：:\r\n]+?)?镜头\s*\d+\s*转场\s*[：:]/u.test(section))
}

const locationKey = (name: string) => normalize(name).replace(/[·・]/gu, '')

function matchesLocation(asset: Asset, name: string) {
  const key = locationKey(name)
  return key.length >= 2 && namesOf(asset).some(name => {
    if (locationKey(name) === key) return true
    // An imported image can include a town prefix, e.g. 临安·红尘客栈大堂.
    const parts = name.split(/[·・\-‐‑‒–—―－]/u)
    return key.length >= 4 && parts.slice(1).some((_, index) => locationKey(parts.slice(index + 1).join('')) === key)
  })
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
      if (scene === false || untrustedSourceLabel(asset, evidence.label) &&
        !sourceDeclaresCharacter(asset, evidence.label, scene ? script.slice(scene.start, scene.end) : script)) continue
      record(asset, evidence.label, scene, evidence.quote)
    }
    for (const scene of scenes.length ? scenes : [undefined]) {
      const location = scene && sceneLabel(scene)
      if (location && asset.kind === 'scene' && matchesLocation(asset, location)) record(asset, location, scene)
      const text = normalize(scene ? script.slice(scene.start, scene.end) : script)
      for (const name of namesOf(asset)) if (!untrustedSourceLabel(asset, name) && text.includes(normalize(name))) record(asset, name, scene)
    }
  }
  const requirements = [...groups.values()].map(({ item, exact, byName }) => ({ ...item, candidateIds: [...(exact.size ? exact : byName)] }))
  return { scenes, requirements, evidence }
}

export function scriptVideoCardSceneIds(card: Pick<BindingCard, 'title' | 'summary' | 'scene' | 'sourceSceneIds'>, scenes: Scene[]): string[] {
  const description = [card.title, card.summary, card.scene].filter(Boolean).join('\n')
  const explicit = scenes.filter(scene => sceneMention(card.scene || description, scene.id))
  if (explicit.length) return explicit.map(scene => scene.id)
  const named = scenes.filter(scene => {
    const label = sceneLabel(scene)
    return label.length >= 2 && contains(description, label)
  })
  const declared = scenes.filter(scene => card.sourceSceneIds?.some(id => normalizeScriptVideoSceneNumbers(id) === scene.id))
  return (declared.length ? declared : named.length ? named : scenes.length === 1 ? scenes : []).map(scene => scene.id)
}

function assetIdsInCard(card: BindingCard) {
  return [...new Set([...card.assetIds, ...(card.openingAssetIds ?? []), ...card.shots.flatMap(shot =>
    [...(shot.visualAssetIds ?? []), ...(shot.speakerAssetIds ?? [])])])]
}

function isSourceLocation(requirement: Requirement) {
  if (requirement.kind !== 'scene' || !requirement.sceneId || !requirement.sceneTitle) return false
  const title = sceneLabel({ id: requirement.sceneId, title: requirement.sceneTitle, start: 0, end: 0 })
  return !!title && locationKey(title) === locationKey(requirement.label)
}

function familyCandidates(requirement: Requirement, assets: readonly Asset[]) {
  if (isSourceLocation(requirement)) return assets.filter(asset => asset.kind === 'scene')
  const direct = assets.filter(asset => requirement.candidateIds.includes(asset.id) || requirement.assetId === asset.id)
  const matchingFamily = (asset: Asset) => {
    const name = familyOf(asset)
    return normalize(asset.kind === 'character' && untrustedSourceLabel(asset, name) ? scriptVideoCharacterBase({ ...asset, assetIdentity: undefined }) : name)
  }
  const families = new Set(direct.map(matchingFamily))
  return assets.filter(asset => asset.kind === requirement.kind && (direct.includes(asset) ||
    families.has(matchingFamily(asset)) || namesOf(asset).some(name => !untrustedSourceLabel(asset, name) && normalize(name) === normalize(requirement.label))))
}

function sceneForShot(card: BindingCard, index: number, sceneIds: string[]) {
  if (sceneIds.length === 1) return sceneIds[0]
  if (!sceneIds.length) return
  const sections = sceneSections(card.scene ?? '')
  const matches = sceneIds.filter(sceneId => sections.some(line => {
    if (!sceneMention(line, sceneId)) return false
    return sceneShotRange(line, index)
  }))
  return matches.length === 1 ? matches[0] : undefined
}

const sceneRange = /(?:镜头|镜号)\s*(\d+)(?:\s*[-‐‑‒–—―~至到]\s*(?:镜头)?\s*(\d+))?/u
function declaredSceneRange(section: string) {
  const text = section.normalize('NFKC')
  const fields = text.split('|')
  const rangeField = fields.length > 1 && fields.reverse().find(field => /^\s*(?:@[^：:\r\n]+?)?(?:镜头|镜号)\s*\d/u.test(field))
  return sceneRange.exec(rangeField || text)
}

function sceneShotRange(section: string, index: number): boolean {
  const range = declaredSceneRange(section)
  return !!range && index + 1 >= Number(range[1]) && index + 1 <= Number(range[2] || range[1])
}

const locationHeading = /^(?:场景[一二三四五六七八九十\d０-９]*|地点)\s*[：:]\s*/u

function declaredLocation(section: string) {
  return section.split(/[｜|]/u).map(part => part.trim().replace(locationHeading, '').replace(/^[【[]|[】\]]$/gu, '')).find(part =>
    part && !/^(?:场(?:次|号)\s*:?\s*)?\d+-\d+(?:\/\d+)?$/u.test(normalizeScriptVideoSceneNumbers(part)))
    ?.split(/[（(]/u, 1)[0].trim().replace(/^@/u, '')
}

function authoredScene(prompt: string) {
  const heading = /^[ \t]*场景[ \t]*[：:][ \t]*/mu.exec(prompt)
  if (!heading) return
  const offset = heading.index + heading[0].length
  const text = prompt.slice(offset)
  const field = text.search(/^[ \t]*(?:人物|角色设定|总时长|独立生成|本段事件|→衔接|末镜停在)[ \t]*[：:]/mu)
  const shot = scriptVideoShotHeadings(text)[0]?.start ?? text.length
  const scene = text.slice(0, Math.min(shot, field < 0 ? text.length : field)).trim()
  return scene ? { text: scene, start: offset + text.indexOf(scene) } : undefined
}

function pruneObsoleteSceneBindings<T extends BindingCard>(card: T, assets: readonly Asset[], backgrounds: readonly Asset[]): T {
  const requirements = card.assetBindingRequirements ?? []
  if (!card.scene || !card.shots.length || !requirements.some(item => item.kind === 'scene' && !item.confirmed)) return card
  const sections = sceneSections(card.scene)
  if (!sections.length || sections.length > 1 && sections.some(section => !declaredSceneRange(section))) return card

  const backgroundIds = new Set(backgrounds.map(asset => asset.id))
  const locations = sections.map(section => ({ section, name: declaredLocation(section), ids: new Set<string>() }))
  for (const [index, shot] of card.shots.entries()) {
    const ids = shot.visualAssetIds?.filter(id => backgroundIds.has(id)) ?? []
    const scoped = locations.filter(({ section }) => sections.length === 1 && !declaredSceneRange(section) || sceneShotRange(section, index))
    const asset = ids.length === 1 ? backgrounds.find(asset => asset.id === ids[0]) : undefined
    const location = scoped.length === 1 ? scoped[0] : undefined
    if (!asset?.image || !location?.name || !matchesLocation(asset, location.name)) return card
    location.ids.add(asset.id)
  }
  if (locations.some(location => !location.ids.size)) return card
  const saved = authoredScene(card.prompt ?? '')
  if (saved && sceneSections(saved.text).some(section => {
    const name = declaredLocation(section)
    return name && !locations.some(location => backgrounds.some(asset => location.ids.has(asset.id) && matchesLocation(asset, name)))
  })) return card

  const protectedIds = new Set([...(card.openingAssetIds ?? []), ...locations.flatMap(location => [...location.ids]),
    ...requirements.flatMap(item => item.confirmed && item.assetId ? [item.assetId] : [])])
  const dropped = new Set<string>()
  const hasDeclaredScopes = locations.every(location => card.sourceSceneIds?.some(id => sceneMention(location.section, id)))
  const next = requirements.flatMap(requirement => {
    if (requirement.kind !== 'scene' || requirement.confirmed) return [requirement]
    const matched = requirement.sceneId ? locations.filter(location => sceneMention(location.section, requirement.sceneId!)) : locations
    const scoped = matched.length || hasDeclaredScopes ? matched : locations
    const allowed = new Set(scoped.flatMap(location => [...location.ids]))
    const candidateIds = requirement.candidateIds.filter(id => allowed.has(id))
    if (requirement.assetId && !allowed.has(requirement.assetId) && !protectedIds.has(requirement.assetId)) dropped.add(requirement.assetId)
    if (!candidateIds.length || requirement.assetId && !allowed.has(requirement.assetId)) return []
    if (!requirement.assetId && candidateIds.length === 1) return [{ ...requirement, candidateIds, assetId: candidateIds[0] }]
    return candidateIds.length === requirement.candidateIds.length ? [requirement] : [{ ...requirement, candidateIds }]
  })
  if (!dropped.size && next.length === requirements.length && next.every((item, index) => item === requirements[index])) return card
  for (const text of [card.prompt, card.scene, card.opening, ...card.shots.flatMap(shot => [shot.camera, shot.action])]) {
    if (!dropped.size) break
    if (!text?.includes('@')) continue
    for (const hit of annotateScriptVideoAssets(text, assets, card.assetIds).mentions) {
      if (hit.explicit && !hit.literal) dropped.delete(hit.id)
    }
  }
  return { ...card, assetIds: card.assetIds.filter(id => !dropped.has(id)), assetBindingRequirements: next }
}

/** Fill missing visual references from authored scene sections. Reusing a source
 * scene number alone is insufficient when that scene spans several rooms. */
export function completeScriptVideoSceneReferences<T extends BindingCard>(card: T, input: Pick<ScriptVideoInput, 'script' | 'assets'>): T {
  if (!card.shots.length) return card
  const backgrounds = input.assets.filter(asset => asset.kind === 'scene')
  if (!backgrounds.some(asset => asset.image)) return card
  card = pruneObsoleteSceneBindings(card, input.assets, backgrounds)

  const savedScene = authoredScene(card.prompt ?? '')?.text
  const sceneText = savedScene ?? card.scene ?? ''
  const sections = sceneSections(sceneText)
  const source = scriptVideoAssetSourceScenes(input.script.trim())
  if (!sections.length && card.sourceSceneIds?.length === 1) {
    const scene = source.find(scene => scene.id === normalizeScriptVideoSceneNumbers(card.sourceSceneIds![0]))
    if (scene) sections.push(sceneLabel(scene))
  }
  if (!sections.length || sections.length > 1 && sections.some(section => !declaredSceneRange(section))) return card

  const excluded = new Set(card.excludedAssetIds)
  const backgroundIds = new Set(backgrounds.map(asset => asset.id))
  const bound = card.assetIds.filter(id => backgroundIds.has(id))
  const confirmed = (card.assetBindingRequirements ?? []).filter(requirement => requirement.kind === 'scene' && requirement.confirmed)
  const planned = sections.map(section => {
    let name = declaredLocation(section)
    if (!name || /^(?:同上|承上|同场|(?:沿用|延续)上(?:一)?段(?:场景)?)$/u.test(name)) {
      const identified = source.filter(scene => sceneMention(section, scene.id) || card.sourceSceneIds?.length === 1 &&
        normalizeScriptVideoSceneNumbers(card.sourceSceneIds[0]) === scene.id)
      if (identified.length === 1) name = sceneLabel(identified[0])
    }
    const manual = confirmed.filter(requirement => requirement.assetId && (name && locationKey(requirement.label) === locationKey(name) ||
      sections.length === 1 && requirement.sceneId && (sceneMention(section, requirement.sceneId) ||
        card.sourceSceneIds?.length === 1 && normalizeScriptVideoSceneNumbers(card.sourceSceneIds[0]) === normalizeScriptVideoSceneNumbers(requirement.sceneId))))
    const matches = manual.length ? backgrounds.filter(asset => manual.some(requirement => requirement.assetId === asset.id))
      : name ? backgrounds.filter(asset => matchesLocation(asset, name)) : []
    const asset = matches.length === 1 ? matches[0] : undefined
    return { section, asset: asset?.image && !excluded.has(asset.id) ? asset : undefined }
  })
  const inferredIds = new Set(planned.flatMap(section => section.asset ? [section.asset.id] : []))
  // A manual selection outside the proposed set may be an intentional override.
  // Leave the entire card intact when there is evidence of a specific choice.
  if (bound.some(id => !inferredIds.has(id)) || confirmed.some(item => item.assetId && !inferredIds.has(item.assetId))) return card

  const explicitIds = (text: string) => text.includes('@') ? scopedAssets(text, input.assets, card.assetIds)
    .filter(hit => hit.explicit && backgroundIds.has(hit.id)).map(hit => hit.id) : []
  if (explicitIds(sceneText).some(id => !inferredIds.has(id))) return card

  const added = new Set<string>()
  const annotations = new Map<string, string>()
  let shotsChanged = false
  const promptShots = new Map(promptSections(card.prompt).flatMap(section => section.index === undefined ? [] : [[section.index, section.text] as const]))
  const shots = card.shots.map((shot, index) => {
    const matches = planned.filter(({ section }) => (sections.length === 1 && !declaredSceneRange(section)) || sceneShotRange(section, index))
    if (matches.length !== 1 || !matches[0].asset) return shot
    const { section, asset } = matches[0]
    const { id } = asset
    if (shot.visualAssetIds?.includes(id)) {
      if (!card.assetIds.includes(id)) added.add(id)
      return shot
    }
    const visualIds = [...(shot.visualAssetIds ?? []), ...explicitIds([shot.camera, shot.action, promptShots.get(index)].join('\n')),
      ...(index === 0 ? card.openingAssetIds ?? [] : [])].filter(id => backgroundIds.has(id))
    if (visualIds.some(prior => prior !== id)) return shot
    if (!shot.visualAssetIds) {
      if (!sceneText) return shot
      // Preserve legacy prose inference. Introducing a visual array suppresses
      // existing implicit references in the shot and its scene/handoff fields.
      if (!scopedAssets(section, input.assets, card.assetIds).some(hit => hit.id === id)) annotations.set(section, asset.name)
      if (!card.assetIds.includes(id)) added.add(id)
      return shot
    }
    if (!card.assetIds.includes(id)) added.add(id)
    shotsChanged = true
    return { ...shot, visualAssetIds: [...shot.visualAssetIds, id] }
  })
  if (!added.size && !shotsChanged && !annotations.size) return card
  let updatedScene = sceneText
  for (const [section, name] of annotations) updatedScene = updatedScene.replace(section, () => `${section}｜背景参考 @${name}`)
  const prompt = savedScene && annotations.size ? card.prompt?.replace(savedScene, () => updatedScene) : card.prompt
  const scene = !savedScene && annotations.size ? updatedScene : card.scene
  return { ...card, shots, prompt, scene, assetIds: [...new Set([...card.assetIds, ...added])] }
}

/** Locate clear scene titles that cannot be linked automatically. Existing
 * explicit tokens are handled by the general reference parser. */
export function scriptVideoSceneReferenceProblems(card: BindingCard, assets: readonly Asset[]) {
  const block = authoredScene(card.prompt ?? '')
  if (!block || card.manuallyAdded || card.status === 'ready' || card.videoUrl || !card.shots.length) return []
  const sections = sceneSections(block.text)
  const backgrounds = assets.filter(asset => asset.kind === 'scene')
  const bound = new Set(card.assetIds)
  const excluded = new Set(card.excludedAssetIds)
  const hasRanges = sections.length === 1 || sections.every(section => declaredSceneRange(section))
  let cursor = 0
  return sections.flatMap(section => {
    const sectionStart = block.text.indexOf(section, cursor)
    cursor = sectionStart + section.length
    const name = declaredLocation(section)
    if (!name || name.length < 2 || name.length > 80 || /[，,。；;：:！？!?@]|^(?:未知|待定|未提供|同上|同场|承上|无场景|(?:沿用|延续)上(?:一)?段)/u.test(name)) return []
    const offset = section.indexOf(name)
    if (offset < 0 || section[offset - 1] === '@') return []

    const candidates = backgrounds.filter(asset => matchesLocation(asset, name))
    if (candidates.some(asset => excluded.has(asset.id) || bound.has(asset.id))) return []
    const ranges = card.shots.filter((_, index) => !declaredSceneRange(section) && sections.length === 1 || sceneShotRange(section, index))
    const scoped = ranges.flatMap(shot => shot.visualAssetIds ?? [])
    if (backgrounds.some(asset => scoped.includes(asset.id) || (sections.length === 1 && (bound.has(asset.id) || excluded.has(asset.id))))) return []
    if (hasRanges && ranges.length && candidates.length === 1 && candidates[0].image) return []

    const start = block.start + sectionStart + offset
    return [{ name, start, end: start + name.length, candidateIds: candidates.filter(asset => asset.image).map(asset => asset.id) }]
  })
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
  const shots = scriptVideoShotHeadings(prompt)
  return [
    { text: prompt.slice(0, shots[0]?.start), index: undefined },
    ...shots.map(({ start, index }, position) => ({ text: prompt.slice(start, shots[position + 1]?.start), index })),
  ]
}

function scopedAssets(text: string | undefined, assets: readonly Asset[], boundIds: string[], dialogue = false) {
  return annotateScriptVideoAssets(text ?? '', assets, boundIds, { autoBind: true, dialogue }).mentions
    .filter(hit => !hit.literal && hit.usage !== 'context' && hit.usage !== 'audio')
}

function visibleBindingText(text: string) {
  const mask = (value: string) => value.replace(/[^\r\n]/g, ' ')
  let start = 0
  const visible = scriptVideoAssetScopeRanges(text).map(range => {
    const part = text.slice(start, range.start) + mask(text.slice(range.start, range.end))
    start = range.end
    return part
  })
  visible.push(text.slice(start))
  return visible.join('')
    .replace(/^[ \t]*(?:对白(?:[ \t]*[/／][ \t]*音效)?|台词|画外音|心声)[ \t]*[：:].*$/gmu, mask)
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』/gu, mask)
}

/** A source-scene alias can identify an asset without making it a requirement
 * everywhere in that scene. Only review unresolved uses in the current segment. */
function activeAssetBindingRequirements(card: BindingCard, assets: readonly Asset[], planning = false) {
  const list = card.assetBindingRequirements ?? []
  const pending = (item: Requirement) => !item.confirmed && (planning || !item.assetId)
  if (!list.some(pending) || !card.shots.length) return list

  const sections = new Map(promptSections(scriptVideoMaterialEvidenceText(card.prompt ?? '', card.shots))
    .map(section => [section.index, section.text]))
  const byId = new Map(assets.map(asset => [asset.id, asset]))
  const header = sections.get(undefined) ?? ''
  const opening = header.match(/^[ \t]*(?:←承上|开场画面)[：:][\s\S]*?(?=\n[ \t]*(?:场景|人物|角色设定|总时长|独立生成|本段事件)[：:]|$)/mu)?.[0]
  const visual = [
    { index: 0, ids: card.openingAssetIds ?? [], text: opening ?? card.opening ?? (sections.size === 1 ? header : '') },
    ...card.shots.map((shot, index) => ({ index, ids: [...(shot.visualAssetIds ?? []), ...(shot.speakerAssetIds ?? [])],
      text: sections.get(index) ?? [shot.camera, shot.action].join('\n') })),
  ].map(({ index, ids, text }) => {
    const prose = visibleBindingText(text)
    const named = text.includes('@') ? scopedAssets(text, assets, card.assetIds).filter(hit => hit.explicit) : []
    let from = 0
    const literal = named.map(hit => {
      const prefix = normalize(prose.slice(from, hit.start))
      from = hit.end
      return prefix
    })
    literal.push(normalize(prose.slice(from)))
    return { index, ids: [...ids, ...named.map(hit => hit.id)], text: literal.join('\n') }
  })
  const sceneIds = card.sourceSceneIds?.length ? card.sourceSceneIds : [...new Set(list.flatMap(item => item.sceneId ?? []))]
  const sceneByShot = card.shots.map((_, index) => sceneForShot(card, index, sceneIds))
  return list.flatMap(item => {
    if (!pending(item) || isSourceLocation(item)) return [item]
    const label = normalize(item.label)
    const sameScene = (other?: string) => !item.sceneId || !other || other === item.sceneId
    const local = visual.filter(part => sameScene(sceneByShot[part.index]))
    const candidates = [...new Set(item.candidateIds)].map(id => byId.get(id)).filter((asset): asset is Asset => asset?.kind === item.kind)
    const localIds = new Set(local.flatMap(part => part.ids))
    const inUse = (asset: Asset) => localIds.has(asset.id) || local.some(part => part.text.includes(normalize(asset.name)))
    if (planning && item.kind === 'character' && item.assetId && familyCandidates(item, assets).some(inUse)) return [item]
    const directlyUsed = candidates.filter(inUse)
    if (directlyUsed.length === 1) {
      const id = directlyUsed[0].id
      if (list.some(other => other !== item && other.assetId === id && sameScene(other.sceneId) &&
        (other.confirmed || !planning || candidates.length > 1))) return []
      return [{ ...item, assetId: id, candidateIds: [id] }]
    }

    const identified = candidates.filter(asset => {
      const labels = asset.kind === 'character' ? namesOf(asset).filter(name => !untrustedSourceLabel(asset, name)) :
        [asset.name, asset.originalName, asset.assetIdentity?.split(/[｜|]/u, 1)[0]]
      return labels.some(name => name && normalize(name) === label)
    })
    const otherChoice = list.some(other => other !== item && other.assetId && localIds.has(other.assetId) &&
      sameScene(other.sceneId) && normalize(other.label) === label)
    if (otherChoice || !local.some(part => part.text.includes(label))) return []
    const actualCandidates = directlyUsed.length > 1 ? directlyUsed : identified
    if (actualCandidates.length === 1) return [{ ...item, assetId: actualCandidates[0].id, candidateIds: [actualCandidates[0].id] }]
    return actualCandidates.length > 1 ? [{ ...item, assetId: undefined, candidateIds: actualCandidates.map(asset => asset.id) }] : []
  })
}

export function scriptVideoAssetBindingIssues(card: BindingCard, assets: readonly Asset[]) {
  const list = activeAssetBindingRequirements(card, assets)
  if (!list.length) return []
  const sceneIds = card.sourceSceneIds ?? []
  // All requirements inspect the same shot and prompt references.
  const shotAssetIds: string[][] = []
  let promptAssetIds: { index?: number; ids: string[] }[] | undefined
  const explicitReferences = (text: string | undefined, dialogue = false) => text?.includes('@')
    ? scopedAssets(text, assets, card.assetIds, dialogue).filter(hit => hit.explicit).map(hit => hit.id)
    : []
  const shotReferences = (shot: BindingShot, index: number) => shotAssetIds[index] ??= [
    ...(shot.visualAssetIds ?? []), ...(shot.speakerAssetIds ?? []),
    ...scopedAssets([shot.camera, shot.action].join('\n'), assets, card.assetIds).map(hit => hit.id),
    ...explicitReferences(shot.dialogue, true),
  ]
  return list.flatMap(requirement => {
    const selected = assets.find(asset => asset.id === requirement.assetId && asset.kind === requirement.kind)
    const location = requirement.sceneTitle ? `（${requirement.sceneTitle}）` : ''
    const prefix = `「${requirement.label}」${location}`
    if (!selected || !requirement.candidateIds.includes(selected.id) || !card.assetIds.includes(selected.id) || card.excludedAssetIds?.includes(selected.id)) {
      const options = assets.filter(asset => asset.kind === requirement.kind && requirement.candidateIds.includes(asset.id) && asset.image)
      const type = !requirement.assetId && options.length > 1 ? 'ambiguous' as const : 'missing' as const
      return [{ requirement, type, message: `请选择${prefix}对应的资产。` }]
    }
    if (selected.image === '')
      return [{ requirement, type: 'missing' as const, message: `「${selected.name}」还没有参考图，请生成、上传或选择已有图片的资产。` }]
    const alternatives = new Set(familyCandidates(requirement, assets).filter(asset => asset.id !== selected.id).map(asset => asset.id))
    if (!alternatives.size) return []
    const conflicting = (ids: string[], index?: number) => {
      const scope = bindingScope(card, index)
      if (!scope.includes(requirement)) return false
      return ids.some(id => alternatives.has(id) && !scope.some(item => item.assetId === id)) ||
        (index !== undefined && !!requirement.sceneId && sceneIds.length > 1 && !sceneForShot(card, index, sceneIds) &&
          scope.some(item => item.sceneId !== requirement.sceneId && !!item.assetId && alternatives.has(item.assetId)) &&
          ids.some(id => id === selected.id || alternatives.has(id)))
    }
    const conflict = card.shots.some((shot, index) => conflicting(shotReferences(shot, index), index))
      || conflicting(card.openingAssetIds ?? [], 0)
      || (promptAssetIds ??= promptSections(card.prompt).map(({ text, index }) => ({
        index,
        ids: explicitReferences(text),
      }))).some(({ ids, index }) => conflicting(ids, index))
    return conflict ? [{ requirement, type: 'ambiguous' as const, message: `${prefix}的镜头引用有冲突。请核对场次的镜头范围或重新选择资产。` }] : []
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
  const selected = assets.find(asset => asset.id === assetId && asset.kind === target?.kind)
  if (!target || !selected) return
  const list = card.assetBindingRequirements!.map(item => item === target ? { ...item, assetId, confirmed: true as const,
    candidateIds: [...new Set([...item.candidateIds, assetId])] } : item)
  const bound = applyScriptVideoAssetBindings({ ...card, assetBindingRequirements: list }, assets)
  const sections = new Map(promptSections(bound.prompt).map(section => [section.index, section.text]))
  const withReference = (ids: string[] | undefined) => [...new Set([...(ids ?? []), assetId])]
  const shots = bound.shots.map((shot, index) => {
    if (!bindingScope(bound, index).some(item => item.key === key)) return shot
    const text = sections.get(index) ?? [shot.camera, shot.action, shot.dialogue && `对白：${shot.dialogue}`].filter(Boolean).join('\n')
    const visual = contains(visibleBindingText(text), target.label)
    const speaker = selected.kind === 'character' && scopedAssets(text, [selected], [assetId]).some(hit => hit.usage === 'speaker')
    return { ...shot, ...(visual && { visualAssetIds: withReference(shot.visualAssetIds) }),
      ...(speaker && { speakerAssetIds: withReference(shot.speakerAssetIds) }) }
  })
  return { ...bound, shots }
}

export function planScriptVideoCardBindings<T extends BindingCard>(card: T, input: ScriptVideoInput, approved?: BindingCard): T {
  const { scenes, requirements, evidence } = scriptVideoSourceAssetMap(input)
  const excluded = new Set(card.excludedAssetIds)
  if (!requirements.length) {
    const approvedRequirements = approved?.assetBindingRequirements?.filter(item => item.kind !== 'scene' || !item.assetId || !excluded.has(item.assetId))
    if (!approvedRequirements?.length) return completeScriptVideoSceneReferences(card, input)
    const carried = { ...card, assetBindingRequirements: approvedRequirements }
    const bindings = activeAssetBindingRequirements(carried, input.assets, true)
    return completeScriptVideoSceneReferences(applyScriptVideoAssetBindings({ ...carried, assetBindingRequirements: bindings }, input.assets), input)
  }
  const approvedScenes = approved ? scriptVideoCardSceneIds(approved, scenes) : []
  const proposed = approvedScenes.length ? approvedScenes : scriptVideoCardSceneIds(card, scenes)
  const byId = new Map(input.assets.map(asset => [asset.id, asset]))
  const explicitIds = new Set(assetIdsInCard(card))
  const visualText = [card.scene, card.opening, ...card.shots.flatMap(shot => [shot.camera, shot.action])].filter(Boolean).join('\n')
  const inferred = new Set([
    ...scopedAssets(visualText, input.assets, card.assetIds).map(hit => hit.id),
    ...card.shots.flatMap(shot => scopedAssets(shot.dialogue, input.assets, card.assetIds, true).map(hit => hit.id)),
  ])
  const declaredSections = sceneSections(card.scene ?? '')
  const list = requirements.flatMap(requirement => {
    if (proposed.length && requirement.sceneId && !proposed.includes(requirement.sceneId)) return []
    if (requirement.kind === 'scene' && requirement.candidateIds.some(id => excluded.has(id))) return []
    // A source scene can include several visual locations. A formal card with
    // explicit matching subspaces keeps those locations and their shot ranges.
    if (requirement.kind === 'scene' && requirement.sceneId && declaredSections.some(section => {
      if (!sceneMention(section, requirement.sceneId!)) return false
      const location = declaredLocation(section)
      return location && input.assets.some(asset => asset.kind === 'scene' && !requirement.candidateIds.includes(asset.id) && matchesLocation(asset, location))
    })) return []
    const family = familyCandidates(requirement, input.assets)
    if (!(isSourceLocation(requirement) && proposed.includes(requirement.sceneId!)) &&
        !family.some(asset => inferred.has(asset.id) || explicitIds.has(asset.id)) && !contains(visualText, requirement.label)) return []
    const previous = approved?.assetBindingRequirements?.find(item => item.key === requirement.key && item.confirmed)
    if (previous?.kind === 'scene' && previous.assetId && excluded.has(previous.assetId)) return []
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
  const withSources = proposed.length ? { ...card, sourceSceneIds: proposed } : card
  if (!selected.size) return completeScriptVideoSceneReferences(withSources, input)
  const proposedBindings = { ...withSources, assetBindingRequirements: [...selected.values()] }
  const withBindings = applyScriptVideoAssetBindings({ ...proposedBindings,
    assetBindingRequirements: activeAssetBindingRequirements(proposedBindings, input.assets, true) }, input.assets)
  return completeScriptVideoSceneReferences(withBindings, input)
}
