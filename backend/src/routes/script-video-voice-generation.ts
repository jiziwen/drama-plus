import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, max } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { checkFfmpegSuite } from '../utils/ffmpeg.js'
import { created, success } from '../utils/response.js'
import { generateVideo } from '../services/generation.js'
import { getJimengVideoModels, withJimengAccount } from '../services/jimeng-cli.js'
import { JIMENG_SEEDANCE_20_MINI_MODEL } from '../services/jimeng-video-models.js'
import { libtvHasSeedance20Mini, withLibTVAccount } from '../services/libtv-cli.js'
import { LIBTV_SEEDANCE_20_MINI_MODEL } from '../services/libtv-video-models.js'
import { scriptVideoVoiceMembers, type ScriptVideoVoiceProfile } from '../services/script-video-project-voices.js'
import { ScriptVideoStoreError, type ScriptVideoStore } from '../services/script-video-store.js'
import { scriptVideoVoiceAgeStageSchema } from '../services/script-video-voice-profile.js'
import { generatedVoiceAudio, generatedVoiceVideoUrl, isScriptVideoVoiceModel, scriptVideoVoiceParam, scriptVideoVoicePrompt, scriptVideoVoiceRequest } from '../services/script-video-voice-generation.js'
import { safeTaskError } from '../services/video-download.js'
import { resolveVideoCliAccountId } from '../services/video-cli-accounts.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess } from '../utils/private-access.js'

const voiceDuration = 5
const voiceGenerationSchema = z.object({
  configId: z.number().int().positive(),
  model: z.enum([JIMENG_SEEDANCE_20_MINI_MODEL, LIBTV_SEEDANCE_20_MINI_MODEL]),
  description: z.string().trim().min(1).max(500),
  dialogue: z.string().trim().min(1).max(80),
  confirmVoiceConflict: z.boolean().optional(),
})
const voiceAgeSchema = z.object({ ageStage: scriptVideoVoiceAgeStageSchema.exclude(['unknown']) })

const configs = schema.aiServiceConfigs
const enabledVideoCli = and(eq(configs.serviceType, 'video'), eq(configs.isActive, true), inArray(configs.provider, ['jimeng', 'libtv']))
const configFields = { id: configs.id, provider: configs.provider, name: configs.name, accountId: configs.videoCliAccountId }
type VoiceConfig = Pick<typeof configs.$inferSelect, 'id' | 'provider' | 'name'> & { accountId: string | null }

function requireVoiceGenerationAccess(c: Context) {
  if (!hasLoopbackAccess(c) && !hasPrivateGatewayAccess(c))
    throw new ScriptVideoStoreError('角色声音生成需通过本机或已配置的 HTTPS 私有网关使用', 403, 'FORBIDDEN')
}

async function voiceGenerationOption(config: VoiceConfig) {
  const jimeng = config.provider === 'jimeng'
  const provider = jimeng ? 'jimeng' : 'libtv'
  const providerName = jimeng ? '即梦积分' : 'LibTV'
  const resolution = jimeng ? '720p' : '480p'
  const accountId = resolveVideoCliAccountId(provider, config.accountId ?? undefined)
  const model = jimeng ? JIMENG_SEEDANCE_20_MINI_MODEL : LIBTV_SEEDANCE_20_MINI_MODEL
  const available = jimeng
    ? await withJimengAccount(accountId, async () => (await getJimengVideoModels()).some(item => item.id === model))
    : await withLibTVAccount(accountId, () => libtvHasSeedance20Mini(voiceDuration, resolution))
  if (!available) return
  return { configId: config.id, model, label: config.name && config.name !== providerName ? `${providerName} · ${config.name}` : providerName, accountId, resolution }
}

export function registerScriptVideoVoiceGenerationRoutes(
  routes: Hono, store: ScriptVideoStore, respondError: (c: Context, error: unknown) => Response,
) {
  async function voiceTarget(projectId: string, assetId: string, confirmVoiceConflict: boolean | undefined) {
    const project = await store.summary(projectId)
    const asset = project.assets.find(item => item.id === assetId && item.kind === 'character')
    if (!asset) throw new ScriptVideoStoreError('角色资产不存在', 404, 'NOT_FOUND')
    const profile: ScriptVideoVoiceProfile | undefined = asset.voiceProfile
    if (profile?.ageConflict?.length) throw new ScriptVideoStoreError('请先确认此造型对应的年龄阶段', 409, 'VOICE_AGE_CONFLICT')
    const members = scriptVideoVoiceMembers(project.assets, asset)
    if (profile?.audioConflict) throw new ScriptVideoStoreError('同年龄角色已有多份参考音频，请先统一音频', 409, 'VOICE_AUDIO_CONFLICT')
    if (profile && members.some(member => member.voiceAudio))
      throw new ScriptVideoStoreError('此角色在该年龄阶段已有声音，可直接复用', 409, 'VOICE_ALREADY_SET')
    if (profile?.generatedOutputId)
      throw new ScriptVideoStoreError('此角色在该年龄阶段已生成过声音，可上传参考音频', 409, 'VOICE_ALREADY_GENERATED')
    if (profile?.conflicts?.length && !confirmVoiceConflict)
      throw new ScriptVideoStoreError('请阅读各集的声音线索并确认使用的声音描述', 409, 'VOICE_DESCRIPTION_CONFLICT')
    return { asset, profile, members }
  }

  routes.patch('/projects/:id/assets/:assetId/voice-age', async c => {
    try {
      const parsed = voiceAgeSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) throw new ScriptVideoStoreError('请选择此角色造型的年龄阶段')
      return success(c, await store.confirmCharacterVoiceAge(c.req.param('id'), c.req.param('assetId'), parsed.data.ageStage))
    } catch (error) { return respondError(c, error) }
  })

  routes.get('/projects/:id/assets/voice-generation-models', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      requireVoiceGenerationAccess(c)
      await store.summary(c.req.param('id'))
      const rows = db.select(configFields).from(configs).where(enabledVideoCli)
        .orderBy(desc(eq(configs.provider, 'jimeng')), desc(configs.priority), configs.id).all()
      const checks = await Promise.allSettled(rows.map(voiceGenerationOption))
      const options = checks.flatMap(check => {
        if (check.status !== 'fulfilled' || !check.value) return []
        const { configId, model, label, resolution } = check.value
        return [{ configId, model, label, resolution }]
      })
      const message = !rows.length ? '请在模型设置中启用即梦积分或 LibTV 视频服务。' :
        checks.some(check => check.status === 'rejected') ? '部分账号的模型目录暂时无法读取，请在模型设置中检查授权后刷新。' :
          options.length ? undefined : '当前账号的模型目录未提供 Seedance 2.0 Mini。'
      return success(c, { options, message })
    } catch (error) { return respondError(c, error) }
  })

  routes.post('/projects/:id/assets/:assetId/voice-generation', async c => {
    try {
      requireVoiceGenerationAccess(c)
      const parsed = voiceGenerationSchema.safeParse(await c.req.json().catch(() => null))
      if (!parsed.success)
        throw new ScriptVideoStoreError('请选择 Seedance 2.0 Mini，并填写声音描述（最多 500 字）和试音台词（最多 80 字）')
      const projectId = c.req.param('id')
      const assetId = c.req.param('assetId')
      const { configId, model, description, dialogue, confirmVoiceConflict } = parsed.data
      await voiceTarget(projectId, assetId, confirmVoiceConflict)
      const config = db.select(configFields).from(configs).where(and(eq(configs.id, configId), enabledVideoCli)).get()
      if (!config || !isScriptVideoVoiceModel(config.provider ?? '', model))
        throw new ScriptVideoStoreError('请选择已启用的即梦积分或 LibTV Seedance 2.0 Mini 服务')
      if (!(await checkFfmpegSuite()).ffmpeg)
        throw new ScriptVideoStoreError('服务端 FFmpeg 不可用，无法提取角色声音', 503, 'FFMPEG_UNAVAILABLE')
      const option = await voiceGenerationOption(config).catch(error => {
        throw new ScriptVideoStoreError(safeTaskError(error), 502, 'VOICE_MODEL_LOOKUP_FAILED')
      })
      if (!option) throw new ScriptVideoStoreError('所选账号当前未提供 Seedance 2.0 Mini')
      const { asset, profile, members } = await voiceTarget(projectId, assetId, confirmVoiceConflict)
      const savedDescription = asset.voiceDescription?.text === description && !confirmVoiceConflict
        ? asset.voiceDescription : { text: description, sourceLabel: '手动编辑' }
      if (!profile) await store.saveCharacterVoiceDescription(projectId, assetId, { text: description, sourceLabel: '手动编辑' })
      const id = await generateVideo({
        configId, model, prompt: scriptVideoVoicePrompt(description, dialogue, profile?.ageStage), referenceMode: 'text',
        duration: voiceDuration, aspectRatio: '16:9', resolution: option.resolution, generateAudio: true,
        videoCliAccountId: option.accountId, allowJimeng: config.provider === 'jimeng', allowLibTV: config.provider === 'libtv',
        scriptVideoVoice: {
          projectId, assetId, outputId: randomUUID(),
          name: `${Array.from(asset.name).slice(0, 100).join('')}试音.mp3`,
          expectedUrl: asset.voiceAudio?.url ?? null,
          ...(profile && { profileId: profile.id, memberAssetIds: members.map(member => member.id), description: savedDescription }),
        },
      }).catch(error => {
        if (error instanceof ScriptVideoStoreError) throw error
        throw new ScriptVideoStoreError(safeTaskError(error))
      })
      return created(c, { id, assetId, status: 'processing' })
    } catch (error) { return respondError(c, error) }
  })

  routes.get('/projects/:id/assets/voice-generations', async c => {
    try {
      c.header('Cache-Control', 'no-store')
      const project = await store.summary(c.req.param('id'))
      const task = schema.sysTask
      const assetIds = new Set<string>()
      const memberIds = new Map<string, string[]>()
      for (const asset of project.assets) {
        if (asset.kind !== 'character') continue
        assetIds.add(asset.id)
        if (!asset.voiceProfile?.id || asset.voiceProfile.ageConflict?.length) continue
        const members = memberIds.get(asset.voiceProfile.id) ?? []
        members.push(asset.id)
        memberIds.set(asset.voiceProfile.id, members)
      }
      const latest = db.select({ id: max(task.id) }).from(task)
        .where(and(eq(task.type, 'video'), eq(scriptVideoVoiceParam('projectId'), project.id)))
        .groupBy(scriptVideoVoiceParam('assetId'), scriptVideoVoiceParam('profileId'))
      const records = db.select({ id: task.id, status: task.status, params: task.params, localPath: task.localPath, error: task.errorMsg })
        .from(task).where(inArray(task.id, latest)).orderBy(desc(task.id)).all()
      const seen = new Set<string>()
      return success(c, records.flatMap(record => {
        const owner = scriptVideoVoiceRequest(record.params)
        if (!owner) return []
        const ids = owner.profileId ? memberIds.get(owner.profileId) ?? [] : assetIds.has(owner.assetId) ? [owner.assetId] : []
        return ids.flatMap(assetId => {
          if (seen.has(assetId)) return []
          seen.add(assetId)
          const job = { id: record.id, assetId, videoUrl: generatedVoiceVideoUrl(record.localPath) }
          if (record.status === 'completed') return [{ ...job, status: 'completed', voiceAudio: generatedVoiceAudio(owner) }]
          if (record.status === 'processing') return [{ ...job, status: 'processing' }]
          return [{ ...job, status: 'failed', error: record.error || '角色声音生成失败' }]
        })
      }))
    } catch (error) { return respondError(c, error) }
  })
}
