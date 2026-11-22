export const SCRIPT_VIDEO_EPISODE_PROGRESS_OPTIONS = ['制作中-大纲', '制作中-视频制作', '已完成'] as const

export type ScriptVideoEpisodeProgress = typeof SCRIPT_VIDEO_EPISODE_PROGRESS_OPTIONS[number]

export function isScriptVideoEpisodeProgress(value: unknown): value is ScriptVideoEpisodeProgress {
  return SCRIPT_VIDEO_EPISODE_PROGRESS_OPTIONS.some(progress => progress === value)
}

type EpisodeStoryboard = {
  cards: readonly {
    shots?: readonly unknown[]
    prompt?: string
    status: string
    videoUrl?: string
    manuallyAdded?: boolean
  }[]
  production?: unknown
}

export function hasScriptVideoStoryboard({ cards, production }: EpisodeStoryboard) {
  return Boolean(cards.length && (production || cards.every(card => card.manuallyAdded || card.shots?.length && card.prompt?.trim())))
}

export function scriptVideoEpisodeProgress(
  episode: EpisodeStoryboard & {
    confirmed: boolean
    outlineConfirmed: boolean
    progressOverride?: ScriptVideoEpisodeProgress | null
  },
): ScriptVideoEpisodeProgress | undefined {
  if (isScriptVideoEpisodeProgress(episode.progressOverride)) return episode.progressOverride
  const { cards } = episode
  if (!episode.confirmed || !cards.length) return
  if (!episode.outlineConfirmed || !hasScriptVideoStoryboard(episode)) return '制作中-大纲'
  return cards.every(card => card.status === 'ready' && card.videoUrl?.trim()) ? '已完成' : '制作中-视频制作'
}
