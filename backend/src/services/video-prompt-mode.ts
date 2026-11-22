export type ScriptVideoPromptMode = 'reference-guide' | 'inline'

export const DEFAULT_VIDEO_PROMPT_MODE: ScriptVideoPromptMode = 'reference-guide'

export function isVideoPromptMode(value: unknown): value is ScriptVideoPromptMode {
  return value === 'reference-guide' || value === 'inline'
}
