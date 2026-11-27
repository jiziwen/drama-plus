import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCRIPT_VIDEO_STYLE_PRESETS, isScriptVideoStylePreset, type ScriptVideoStylePreset } from './script-video-style.js'

const relativeSource = 'skills/script-to-video/references/项目风格前缀原文.txt'
const bundledSource = fileURLToPath(new URL('../../workspace/' + relativeSource, import.meta.url))
let cached: { file: string; stamp: string; revision: string; presets: readonly ScriptVideoStylePreset[] } | undefined

export function parseScriptVideoStylePresets(source: string): ScriptVideoStylePreset[] {
  const headings = [...source.matchAll(/^(冷色调|暖色调)[ \t]*\r?$/gmu)]
  if (headings.length !== 2 || headings[0]![1] !== '冷色调' || headings[1]![1] !== '暖色调' || headings[0]!.index !== 0)
    throw new Error('项目风格原文须依次包含冷色调、暖色调两个分区')
  const split = headings[1]!.index!
  const presets: ScriptVideoStylePreset[] = [
    { id: 'cool', name: '冷色调', prefix: source.slice(0, split) },
    { id: 'warm', name: '暖色调', prefix: source.slice(split) },
  ]
  if (!presets.every(isScriptVideoStylePreset)) throw new Error('项目风格原文的分区内容无效或过长')
  return presets
}

function currentSource() {
  const candidates = [
    process.env.SCRIPT_VIDEO_STYLE_SOURCE,
    process.env.WORKSPACE_PATH && path.join(process.env.WORKSPACE_PATH, relativeSource),
    bundledSource,
  ].filter((file): file is string => !!file)
  const file = candidates.find(candidate => existsSync(candidate))
  const info = file && statSync(file)
  const stamp = info ? `${info.mtimeMs}:${info.ctimeMs}:${info.size}` : 'bundled'
  if (cached?.file === (file || '') && cached.stamp === stamp) return cached
  const source = file ? readFileSync(file, 'utf8') : undefined
  const presets = source === undefined ? SCRIPT_VIDEO_STYLE_PRESETS.map(preset => ({ ...preset })) : parseScriptVideoStylePresets(source)
  cached = { file: file || '', stamp, presets, revision: createHash('sha256').update(JSON.stringify(presets)).digest('hex') }
  return cached
}

export function getCurrentScriptVideoStylePresets(): ScriptVideoStylePreset[] {
  return currentSource().presets.map(preset => ({ ...preset }))
}

export function getCurrentScriptVideoStylePreset(id: string): ScriptVideoStylePreset | undefined {
  return getCurrentScriptVideoStylePresets().find(preset => preset.id === id)
}

export function getCurrentScriptVideoStyleRevision(): string {
  return currentSource().revision
}

/** Built-in IDs follow their source. An explicitly custom style stays authored. */
export function resolveBuiltinStyleSnapshot(preset: unknown): ScriptVideoStylePreset | undefined {
  if (!isScriptVideoStylePreset(preset) || (preset.id !== 'cool' && preset.id !== 'warm')) return undefined
  const latest = getCurrentScriptVideoStylePreset(preset.id)
  return latest?.name === preset.name ? latest : undefined
}
