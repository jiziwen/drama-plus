export type ScriptVideoVersion = {
  url: string
  modelLabel?: string
  duration?: number
}

type CardMedia = {
  id: string
  status: string
  videoUrl?: string
  videoVersions?: readonly ScriptVideoVersion[]
}

type VersionTask = {
  cardId: string
  status: string
  videoUrl?: string
  modelLabel?: string
  duration?: number
}

function videoUrl(value: unknown) {
  return typeof value === 'string' ? value.trim() : undefined
}

export function latestScriptVideoTaskUrls(tasks: readonly VersionTask[] = []) {
  const urls = new Map<string, string>()
  for (const task of tasks) {
    const url = videoUrl(task.videoUrl)
    if (task.status === 'completed' && url) urls.set(task.cardId, url)
  }
  return urls
}

/** Finished task rows describe past renders. The card can also contain an
 * older file without a matching task, so preserve both sources. */
export function listScriptVideoVersions(card: CardMedia, tasks: readonly VersionTask[] = []) {
  const versions = new Map<string, ScriptVideoVersion>()
  for (const version of card.videoVersions || []) versions.set(version.url, version)
  const storedUrl = videoUrl(card.videoUrl)
  if (storedUrl && !versions.has(storedUrl)) versions.set(storedUrl, { url: storedUrl })
  for (const task of tasks) {
    const url = videoUrl(task.videoUrl)
    if (task.cardId !== card.id || task.status !== 'completed' || !url) continue
    const modelLabel = task.modelLabel
    const duration = task.duration
    // Task rows preserve submission order, including renders finished before
    // the first version archive was saved.
    const previous = versions.get(url)
    versions.delete(url)
    versions.set(url, { ...previous, url, ...(modelLabel && { modelLabel }), ...(duration && { duration }) })
  }
  return [...versions.values()]
}

export function officialScriptVideoUrl(card: { status?: string; videoUrl?: string; videoVersions?: readonly ScriptVideoVersion[] }) {
  const url = videoUrl(card.videoUrl)
  if (url && (card.status === 'ready' || card.videoVersions?.some(version => version.url === url))) return url
}

export function selectScriptVideoPlayback(
  card: Pick<CardMedia, 'status' | 'videoUrl' | 'videoVersions'>,
  completedTaskVideoUrl?: string,
) {
  const storedUrl = videoUrl(card.videoUrl)
  if (card.status === 'ready' && storedUrl) return { kind: 'current' as const, url: storedUrl }
  // After the first saved version, keep playing the selected video across
  // edits instead of switching to a newer but unselected task result.
  const archivedUrl = card.videoVersions?.some(version => version.url === storedUrl) ? storedUrl : undefined
  const url = archivedUrl || videoUrl(completedTaskVideoUrl) || storedUrl || card.videoVersions?.at(-1)?.url
  if (url) return { kind: 'previous' as const, url }
}
