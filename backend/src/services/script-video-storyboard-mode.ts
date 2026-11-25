export const SCRIPT_VIDEO_STORYBOARD_MODES = ['cultivation', 'original'] as const
export type ScriptVideoStoryboardMode = typeof SCRIPT_VIDEO_STORYBOARD_MODES[number]

export const DEFAULT_SCRIPT_VIDEO_STORYBOARD_MODE: ScriptVideoStoryboardMode = 'cultivation'

export function isScriptVideoStoryboardMode(value: unknown): value is ScriptVideoStoryboardMode {
  return SCRIPT_VIDEO_STORYBOARD_MODES.some(mode => mode === value)
}
