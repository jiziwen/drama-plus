import type { ScriptVideoProject } from './script-video-store.js'
import { scriptVideoReferenceSourceUrl } from './script-video-reference-settings.js'
import { listScriptVideoVersions } from './script-video-versions.js'

type ReferenceEpisode = { id: string; cards: readonly { id: string }[] }

/** The wider list is available only when explicitly picking for a new episode. */
export function previousScriptVideoEpisode<Episode extends ReferenceEpisode>(
  project: { episodes: readonly Episode[] }, episodeId: string, cardId: string,
): Episode | undefined {
  const index = project.episodes.findIndex(episode => episode.id === episodeId)
  if (project.episodes[index]?.cards[0]?.id === cardId) return project.episodes[index - 1]
}

/** Automatic references use the adjacent segment, including an episode boundary. */
export function previousScriptVideoCard<Episode extends ReferenceEpisode>(
  project: { episodes: readonly Episode[] }, episodeId: string, cardId: string,
): { episode: Episode; card: Episode['cards'][number]; index: number; episodeIndex: number } | undefined {
  const episodeIndex = project.episodes.findIndex(episode => episode.id === episodeId)
  const episode = project.episodes[episodeIndex]
  const index = episode?.cards?.findIndex(card => card.id === cardId) ?? -1
  if (index < 0) return
  const sourceEpisodeIndex = index > 0 ? episodeIndex : episodeIndex - 1
  const sourceEpisode = project.episodes[sourceEpisodeIndex]
  const sourceIndex = index > 0 ? index - 1 : (sourceEpisode?.cards?.length ?? 0) - 1
  const card = sourceEpisode?.cards?.[sourceIndex]
  if (card) return { episode: sourceEpisode, card, index: sourceIndex, episodeIndex: sourceEpisodeIndex }
}

/** Explicit manual references can use any saved take in this project; implicit references remain adjacent. */
export function previousScriptVideoRender(project: Pick<ScriptVideoProject, 'episodes'>, episodeId: string, cardId: string, videoUrl: string, sourceCardId?: string, sourceEpisodeId?: string) {
  const url = scriptVideoReferenceSourceUrl(videoUrl)
  if (!url) return
  if (sourceEpisodeId !== undefined && sourceCardId === undefined) return
  if (!project.episodes.some(episode => episode.id === episodeId && episode.cards.some((card: { id: string }) => card.id === cardId))) return
  const predecessor = sourceCardId === undefined ? previousScriptVideoCard(project, episodeId, cardId) : undefined
  const explicit = sourceCardId === undefined ? undefined : project.episodes
    .filter(episode => sourceEpisodeId === undefined || episode.id === sourceEpisodeId)
    .map(episode => ({ episode, card: episode.cards.find((item: { id: string }) => item.id === sourceCardId) }))
    .find(source => source.card && listScriptVideoVersions(source.card, source.episode.tasks)
      .some(version => scriptVideoReferenceSourceUrl(version.url) === url))
  const episode = predecessor?.episode ?? explicit?.episode
  const previous = predecessor?.card ?? explicit?.card
  if (!episode || !previous || !listScriptVideoVersions(previous, episode.tasks).some(version => scriptVideoReferenceSourceUrl(version.url) === url)) return
  const task = episode.tasks?.find((item: { cardId: string; videoUrl?: string; status: string }) =>
    item.cardId === previous.id && item.status === 'completed' && scriptVideoReferenceSourceUrl(item.videoUrl) === url)
  return { cardId: previous.id as string, taskId: task?.taskId as number | undefined, videoUrl: url,
    ...(sourceCardId !== undefined && { sourceEpisodeId: episode.id as string }) }
}
