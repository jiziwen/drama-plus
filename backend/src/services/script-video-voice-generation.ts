import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { schema } from '../db/index.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { extractVideoAudio } from '../utils/video-audio.js'
import { JIMENG_SEEDANCE_20_MINI_MODEL } from './jimeng-video-models.js'
import { LIBTV_SEEDANCE_20_MINI_MODEL } from './libtv-video-models.js'
import { scriptVideoVoiceMembers } from './script-video-project-voices.js'
import { getDefaultScriptVideoStore, ScriptVideoStoreError, type ScriptVideoStore } from './script-video-store.js'
import type { ScriptVideoVoiceDescription } from './script-video-types.js'
import type { ScriptVideoVoiceAgeStage } from './script-video-voice-profile.js'

export type ScriptVideoVoiceRequest = {
  projectId: string
  assetId: string
  profileId?: string
  memberAssetIds?: string[]
  description?: ScriptVideoVoiceDescription
  outputId: string
  name: string
  expectedUrl: string | null
}

export function isScriptVideoVoiceModel(provider: string, model: string) {
  return (provider === 'jimeng' && model === JIMENG_SEEDANCE_20_MINI_MODEL) ||
    (provider === 'libtv' && model === LIBTV_SEEDANCE_20_MINI_MODEL)
}

type VoiceTaskOwner = Pick<ScriptVideoVoiceRequest, 'projectId' | 'assetId' | 'profileId' | 'memberAssetIds'>

export function scriptVideoVoiceParam(key: 'projectId' | 'assetId' | 'profileId') {
  const params = schema.sysTask.params
  return sql<string>`CASE WHEN json_valid(${params}) THEN json_extract(${params}, ${`$.scriptVideoVoice.${key}`}) END`
}

export function scriptVideoVoiceTaskScope(request: VoiceTaskOwner, memberAssetIds = request.memberAssetIds ?? []) {
  const assetId = scriptVideoVoiceParam('assetId')
  const profileId = scriptVideoVoiceParam('profileId')
  const params = schema.sysTask.params
  const sameOwner = request.profileId
    ? or(eq(profileId, request.profileId),
      and(isNull(profileId), inArray(assetId, [...new Set([request.assetId, ...memberAssetIds])])))
    : or(eq(assetId, request.assetId), sql`EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(${params}) THEN ${params} END, '$.scriptVideoVoice.memberAssetIds')
      WHERE typeof(key) = 'integer' AND value = ${request.assetId}
    )`)
  return and(eq(schema.sysTask.type, 'video'), eq(scriptVideoVoiceParam('projectId'), request.projectId), sameOwner)
}

export function sameScriptVideoVoiceOwner(first: VoiceTaskOwner, second: VoiceTaskOwner) {
  if (first.projectId !== second.projectId) return false
  if (first.profileId && second.profileId) return first.profileId === second.profileId
  return first.assetId === second.assetId ||
    (first.memberAssetIds?.includes(second.assetId) ?? false) ||
    (second.memberAssetIds?.includes(first.assetId) ?? false)
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

const voiceAgeLabels = { child: '儿童', teen: '青少年', adult: '成年', older_adult: '老年' }

export function scriptVideoVoicePrompt(description: string, dialogue: string, ageStage?: ScriptVideoVoiceAgeStage) {
  const ageLabel = ageStage && ageStage !== 'unknown' ? voiceAgeLabels[ageStage] : undefined
  return [
    '固定镜头，全程只拍浅灰色的吸音墙和桌上的一支无标识麦克风。画面中无人，无字幕。',
    '只录一位说话者的画外人声。',
    ...(ageLabel ? [`说话者年龄阶段：${ageLabel}。`] : []),
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
      const matchesExpectedVoice = (asset: typeof assets[number]) => {
        const currentUrl = asset.voiceAudio?.url ?? null
        const priorOutputId = asset.voiceProfile?.generatedOutputId
        return (!priorOutputId || priorOutputId === request.outputId)
          && (currentUrl === audio.url || currentUrl === request.expectedUrl)
      }
      const origin = assets.find(asset => asset.kind === 'character' && asset.id === request.assetId)
      let linked = request.profileId
        ? assets.filter(asset => asset.kind === 'character' && asset.voiceProfile?.id === request.profileId)
        : origin ? scriptVideoVoiceMembers(assets, origin) : []
      const linkedVoiceMatches = linked.every(matchesExpectedVoice)
      const originProfile = origin?.voiceProfile
      const profileId = request.profileId ?? (linkedVoiceMatches && !originProfile?.ageConflict?.length ? originProfile?.id : undefined)
      // A legacy task can acquire related appearances during extraction. Keep
      // delivery local if that group cannot accept the recording.
      if (!request.profileId && origin && !linkedVoiceMatches) linked = [origin]
      if (!linked.length) throw new ScriptVideoStoreError('角色已移除，无法保存生成的声音', 404)
      if (!linked.every(matchesExpectedVoice))
        throw new ScriptVideoStoreError('生成期间角色声音已更改，已保留当前声音', 409)
      const attached = new Set(linked.map(asset => asset.id))
      return {
        assets: assets.map(asset => {
          if (!attached.has(asset.id)) return asset
          const profile = asset.voiceProfile
          const markProfile = profile && profile.id === profileId && profile.generatedOutputId !== request.outputId
          const attachAudio = asset.voiceAudio?.url !== audio.url
          if (!markProfile && !attachAudio) return asset
          return {
            ...asset,
            ...(markProfile && { voiceProfile: { ...profile, generatedOutputId: request.outputId } }),
            ...(attachAudio && { voiceAudio: audio }),
            ...(attachAudio && request.profileId && request.description && { voiceDescription: request.description }),
          }
        }),
        result: undefined,
      }
    })
  } catch (error) {
    if (wroteOutput) await rm(output, { force: true }).catch(() => {})
    throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}
