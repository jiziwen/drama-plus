import {
  scriptVideoCharacterBase,
  scriptVideoCharacterName,
} from './script-video-asset-identity.js'
import {
  resolveScriptVideoMentions,
  type ScriptVideoCard,
  type ScriptVideoInput,
} from './script-video-types.js'

type AssetScope = Pick<ScriptVideoCard, 'title' | 'summary' | 'assetIds'> & {
  assetBindingRequirements?: ReadonlyArray<{ assetId?: string; candidateIds: string[] }>
}

const normalize = (text: string) => text.normalize('NFKC').replaceAll('\\', '/').toLowerCase()

/** The project keeps the complete index for validation. Only send candidates supported
 * by the source, outline or an explicit binding to the writing model. */
export function selectScriptVideoEpisodeAssets(
  input: ScriptVideoInput,
  cards: readonly AssetScope[] = [],
  extraText = '',
) {
  const source = [
    input.script,
    input.systemPrompt,
    input.characterAppearanceNotes,
    extraText,
    ...cards.map((c) => c.title + '\n' + c.summary),
  ]
    .filter(Boolean)
    .join('\n')
  const text = normalize(source)
  const selected = new Set(cards.flatMap((c) => c.assetIds))
  for (const card of cards) for (const requirement of card.assetBindingRequirements ?? []) {
    for (const id of requirement.assetId ? [requirement.assetId] : requirement.candidateIds) selected.add(id)
  }
  for (const mention of resolveScriptVideoMentions(source, input.assets).mentions)
    selected.add(mention.id)
  const boundRoles = new Set(
    input.assets
      .filter((a) => selected.has(a.id) && a.kind === 'character')
      .map(scriptVideoCharacterBase),
  )
  const mentioned = (name: string) => Boolean(name) && text.includes(normalize(name))

  return input.assets.filter((asset) => {
    if (asset.kind === 'audio') return false
    if (selected.has(asset.id)) return true
    if (asset.occurrences?.some(item => (!item.episodeNumber || !input.episodeNumber || item.episodeNumber === input.episodeNumber) &&
      input.script.includes(item.quote))) return true
    const namedByAlias = Array.isArray(asset.aliases) && asset.aliases.some(alias => typeof alias === 'string' && alias.length >= 2 && mentioned(alias))
    if (asset.kind === 'character') {
      const entity = scriptVideoCharacterName(asset)
      const base = scriptVideoCharacterBase(asset)
      // 群体.png and 便装.png in different character folders share a filename.
      // Match their owner or qualified name, never the unqualified filename.
      if (entity !== base && mentioned(entity)) return true
      if (boundRoles.has(base)) return false
      const owner = base.replace(/\/群体(?:[-_（(【\[].*)?$/u, '')
      return namedByAlias || (owner !== '群体' && mentioned(owner))
    }
    if (namedByAlias || mentioned(asset.name)) return true
    const filename = asset.originalName || asset.name.split('/').at(-1) || ''
    if (mentioned(filename)) return true
    // Scene packs often qualify the site's name, e.g. 京城皇宫-后宫偏殿院落.
    const location = filename.split(/[-_]/u).at(-1) || ''
    return asset.kind === 'scene' && location.length >= 2 && mentioned(location)
  })
}
