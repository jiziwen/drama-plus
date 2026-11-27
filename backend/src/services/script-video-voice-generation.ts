import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { extractVideoAudio } from '../utils/video-audio.js'
import { JIMENG_SEEDANCE_20_MINI_MODEL } from './jimeng-video-models.js'
import { LIBTV_SEEDANCE_20_MINI_MODEL } from './libtv-video-models.js'
import { getDefaultScriptVideoStore, ScriptVideoStoreError, type ScriptVideoStore } from './script-video-store.js'

export type ScriptVideoVoiceRequest = {
  projectId: string
  assetId: string
  outputId: string
  name: string
  expectedUrl: string | null
}

export function isScriptVideoVoiceModel(provider: string, model: string) {
  return (provider === 'jimeng' && model === JIMENG_SEEDANCE_20_MINI_MODEL) ||
    (provider === 'libtv' && model === LIBTV_SEEDANCE_20_MINI_MODEL)
}

export function scriptVideoVoiceParam(key: 'projectId' | 'assetId') {
  const params = schema.sysTask.params
  return sql<string>`CASE WHEN json_valid(${params}) THEN json_extract(${params}, ${`$.scriptVideoVoice.${key}`}) END`
}

export function scriptVideoVoiceTaskScope(request: ScriptVideoVoiceRequest) {
  return and(eq(schema.sysTask.type, 'video'), eq(scriptVideoVoiceParam('projectId'), request.projectId),
    eq(scriptVideoVoiceParam('assetId'), request.assetId))
}

export function scriptVideoVoiceRequest(params: string | null): ScriptVideoVoiceRequest | undefined {
  if (!params) return
  try { return JSON.parse(params)?.scriptVideoVoice } catch { return undefined }
}

export function generatedVoiceAudio(request: ScriptVideoVoiceRequest) {
  return { url: `/static/uploads/${request.outputId}.mp3`, name: request.name, mimeType: 'audio/mpeg' as const }
}

export function generatedVoiceVideoUrl(localPath: string | null) {
  if (localPath && /^static\/videos\/(?:task-\d+\.(?:mp4|webm)|jimeng-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.mp4)$/i.test(localPath))
    return `/${localPath}`
}

export function scriptVideoVoicePrompt(description: string, dialogue: string) {
  return [
    '固定镜头，全程只拍浅灰色的吸音墙和桌上的一支无标识麦克风。画面中无人，无字幕。',
    '只录一位说话者的画外人声。',
    `声音特征：${description}`,
    `开场即自然读出这句台词，只读一遍：「${dialogue}」`,
    '人声清晰，音量稳定，无音乐、环境声和混响。',
  ].join('\n')
}

export async function saveGeneratedCharacterVoice(
  request: ScriptVideoVoiceRequest, videoPath: string, store: ScriptVideoStore = getDefaultScriptVideoStore(),
) {
  if (!generatedVoiceVideoUrl(videoPath) ||
      !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(request.outputId))
    throw new Error('角色声音任务的源文件无效')
  const audio = generatedVoiceAudio(request)
  const dir = path.join(STORAGE_ROOT, 'uploads')
  const output = path.join(dir, `${request.outputId}.mp3`)
  const temporary = path.join(dir, `${randomUUID()}.part`)
  let wroteOutput = false
  try {
    // Reuse the same output after interruption between storage and database writes.
    const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    if (existing && (!existing.isFile() || !existing.size)) throw new Error('已生成的角色声音文件无效')
    if (!existing) {
      await mkdir(dir, { recursive: true })
      await extractVideoAudio(path.join(STORAGE_ROOT, videoPath.slice('static/'.length)), temporary)
      await rename(temporary, output)
      wroteOutput = true
    }
    await store.mutateAssets(request.projectId, assets => {
      const index = assets.findIndex(asset => asset.id === request.assetId && asset.kind === 'character')
      const asset = assets[index]
      if (!asset) throw new ScriptVideoStoreError('角色已移除，无法保存生成的声音', 404)
      const currentUrl = asset.voiceAudio?.url ?? null
      if (currentUrl === audio.url) return { result: undefined }
      if (currentUrl !== request.expectedUrl)
        throw new ScriptVideoStoreError('生成期间角色声音已更改，已保留当前声音', 409)
      const next = assets.slice()
      next[index] = { ...asset, voiceAudio: audio }
      return { assets: next, result: undefined }
    })
  } catch (error) {
    if (wroteOutput) await rm(output, { force: true }).catch(() => {})
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
