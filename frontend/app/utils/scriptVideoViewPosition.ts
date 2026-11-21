export type ScriptVideoStage = 'materials' | 'outline' | 'production'
export type ScriptVideoEditorTab = 'shots' | 'prompt' | 'revise' | 'continuity' | 'preview' | 'versions'

type ScrollOffset = { top: number; left: number }
export type ScriptVideoViewPosition = {
  projectId: string
  episodeId?: string
  stage?: ScriptVideoStage
  cardId?: string
  tab?: ScriptVideoEditorTab
  outputMode?: 'internal' | 'external'
  scroll?: Record<string, ScrollOffset>
}

const key = 'script-video-view-position'
const stages = ['materials', 'outline', 'production'] as const
const tabs = ['shots', 'prompt', 'revise', 'continuity', 'preview', 'versions'] as const

export function readScriptVideoViewPosition(): ScriptVideoViewPosition | undefined {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) || 'null')
    if (!value || typeof value.projectId !== 'string' || !value.projectId) return
    const position: ScriptVideoViewPosition = { projectId: value.projectId }
    if (typeof value.episodeId === 'string' && value.episodeId) {
      position.episodeId = value.episodeId
      if (stages.includes(value.stage)) position.stage = value.stage
      if (tabs.includes(value.tab)) position.tab = value.tab
      if (typeof value.cardId === 'string') position.cardId = value.cardId
      if (value.outputMode === 'internal' || value.outputMode === 'external') position.outputMode = value.outputMode
      if (value.scroll && typeof value.scroll === 'object') position.scroll = value.scroll
    }
    return position
  } catch { /* Browsers may block session storage. The workspace still opens normally. */ }
}

export function writeScriptVideoViewPosition(position: ScriptVideoViewPosition) {
  try { window.sessionStorage.setItem(key, JSON.stringify(position)) } catch { /* Navigation still works. */ }
}

export function restoreScriptVideoStage(
  stage: ScriptVideoStage | undefined,
  episode: { confirmed: boolean; outlineConfirmed: boolean; cardCount: number; hasStoryboard: boolean },
): ScriptVideoStage | undefined {
  if (!stage || stage === 'materials') return stage
  if (!episode.confirmed || !episode.cardCount) return 'materials'
  if (stage === 'production' && (!episode.outlineConfirmed || !episode.hasStoryboard)) return 'outline'
  return stage
}

const scrollTargets = {
  script: '.vp-script-textarea',
  outline: '.vp-outline-list',
  editor: '.sv-body',
  prompt: 'textarea.sv-prompt-input',
  segments: '.vp-card-track',
}

// The workspace uses independently scrolling panels rather than window scroll.
export function captureScriptVideoScroll(root: HTMLElement) {
  const scroll: Record<string, ScrollOffset> = {}
  for (const [key, selector] of Object.entries(scrollTargets)) {
    const panel = root.querySelector<HTMLElement>(selector)
    if (panel && (panel.scrollTop > 0 || panel.scrollLeft > 0)) scroll[key] = { top: panel.scrollTop, left: panel.scrollLeft }
  }
  return scroll
}

export function restoreScriptVideoScroll(root: HTMLElement, scroll: ScriptVideoViewPosition['scroll']) {
  for (const [key, selector] of Object.entries(scrollTargets)) {
    const offset = scroll?.[key]
    if (!offset || !Number.isFinite(offset.top) || !Number.isFinite(offset.left)) continue
    const panel = root.querySelector<HTMLElement>(selector)
    if (panel) {
      panel.scrollTop = Math.max(0, offset.top)
      panel.scrollLeft = Math.max(0, offset.left)
    }
  }
}
