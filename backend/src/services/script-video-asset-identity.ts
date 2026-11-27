type CharacterAsset = { name: string; originalName?: string; sourcePath?: string; assetIdentity?: string }

const category = /^(?:角色|人物|characters?)$/iu
const costumeSeparator = /[-_（(【\[]/u
const identitySeparator = /[｜|]/u
const crowd = /^群体(?:$|[-_（(【\[])/u
const imageExtension = /\.(?:avif|bmp|gif|heic|jpe?g|png|webp)$/iu
const chibi = /Q版|小剧场/iu

/** Derive semantic names without modifying the display name used in @ mentions.
 * A file named 群体.png identifies its cast through the parent directory. */
export function scriptVideoCharacterName(asset: CharacterAsset): string {
  const displayed = asset.name.replaceAll('\\', '/').split('/').filter(Boolean)
  const source = asset.sourcePath?.replaceAll('\\', '/').split('/').filter(Boolean) || []
  const displayedLeaf = displayed.at(-1) || asset.name
  const original = asset.originalName || source.at(-1)?.replace(imageExtension, '')
  // Drop the importer's numeric collision suffix only when it isn't part of
  // the original filename. An explicitly renamed display name stays usable.
  const plain = displayedLeaf.replace(/-\d+$/u, '')
  const disambiguated = original ? plain === original : displayed.length > 1
  const file = disambiguated ? plain : displayedLeaf
  const folders = (source.length ? source : displayed).slice(0, -1)
  let categoryIndex = folders.length - 1
  while (categoryIndex >= 0 && !category.test(folders[categoryIndex])) categoryIndex--
  const entityFolder = categoryIndex >= 0 ? folders[categoryIndex + 1] : undefined
  if (crowd.test(file)) {
    const parent = source.at(-2) || displayed.at(-2)
    if (parent && !category.test(parent)) return parent + '/' + file
  }
  if (
    entityFolder &&
    file !== entityFolder &&
    !file.startsWith(entityFolder + '_') &&
    !file.startsWith(entityFolder + '-')
  ) {
    return entityFolder + '/' + file
  }
  return file
}

function characterNameBase(fullName: string): string {
  const start = fullName.lastIndexOf('/') + 1
  const leaf = fullName.slice(start)
  if (start && !crowd.test(leaf)) return fullName.slice(0, start - 1)
  const suffix = leaf.search(costumeSeparator)
  // A literal numeric filename (e.g. 侍卫-2.png) need not describe a costume.
  // Imported disambiguation numbers have already been removed by the name helper.
  if (suffix < 0 || /^-\d+$/u.test(leaf.slice(suffix))) return fullName
  return (fullName.slice(0, start) + leaf.slice(0, suffix)).trim()
}

export function scriptVideoCharacterBase(asset: CharacterAsset): string {
  return asset.assetIdentity?.split(identitySeparator, 1)[0].trim() || characterNameBase(scriptVideoCharacterName(asset))
}

export function isScriptVideoChibiAppearance(asset: CharacterAsset): boolean {
  const version = asset.assetIdentity?.split(identitySeparator).slice(1).join(' ')
  if (version && chibi.test(version.normalize('NFKC'))) return true
  const forms = asset.originalName && asset.originalName !== asset.name
    ? [asset, { ...asset, name: asset.originalName }]
    : [asset]
  return forms.some(form => {
    const name = scriptVideoCharacterName(form)
    return chibi.test(name.slice(characterNameBase(name).length).normalize('NFKC'))
  })
}
