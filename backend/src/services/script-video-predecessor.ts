/** Only adjacent segments can supply a reference, including an episode boundary. */
export function previousScriptVideoCard<Episode extends { id: string; cards: readonly { id: string }[] }>(
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
