import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { created, success } from '../utils/response.js'
import {
  extractScriptVideoAssets,
  isScriptVideoAssetExtractionResultUnknown,
  isTransientScriptVideoAssetExtractionError,
  mergeScriptVideoAssetOccurrences,
  scriptVideoAssetIdentityKey,
  type ScriptVideoExtractedAsset,
} from '../services/script-video-asset-extraction.js'
import {
  ScriptVideoAssetExtractionJobError,
  type AssetExtractionClaim,
  type ScriptVideoAssetExtractionJobs,
} from '../services/script-video-asset-extraction-jobs.js'
import { mergeScriptVideoProjectVoices, type ScriptVideoVoiceAssignment } from '../services/script-video-project-voices.js'
import { ScriptVideoStoreError, type ScriptVideoProject, type ScriptVideoStore } from '../services/script-video-store.js'
import { safeTaskError } from '../services/video-download.js'

const MAX_SCRIPT_BYTES = 16 * 1024 * 1024
const modelOptions = z.object({
  configId: z.number().int().positive().optional(),
  model: z.string().trim().min(1).max(300).optional(),
})
const extractionInput = modelOptions.extend({
  sources: z.array(z.object({
    title: z.string().trim().min(1).max(400),
    script: z.string().trim().min(1),
    episodeNumber: z.number().int().positive().optional(),
  })).max(2000).optional(),
  restartJobId: z.uuid().optional(),
})

const normalizedName = (s: string) => s.normalize('NFKC').trim().toLowerCase()

function mergeProjectAssets(current: ScriptVideoProject['assets'], items: ScriptVideoExtractedAsset[]) {
  const assets = [...current]
  const ids = new Map(assets.map((asset, index) => [asset.id, index]))
  const identities = new Map(assets.flatMap((asset, index) =>
    asset.assetIdentity ? [[scriptVideoAssetIdentityKey(asset.kind, asset.assetIdentity), index] as const] : [],
  ))
  const legacyNames = new Map(assets.flatMap((asset, index) =>
    !asset.assetIdentity ? [[scriptVideoAssetIdentityKey(asset.kind, asset.name), index] as const] : [],
  ))
  const displayNames = new Set(assets.map(asset => normalizedName(asset.name)))
  const added = new Set<string>()
  const reused = new Set<string>()
  const voiceProfiles = new Map<string, ScriptVideoVoiceAssignment>()
  for (const item of items) {
    const { existingAssetId, voiceProfile, observedVoiceAge, ...fields } = item
    const identity = scriptVideoAssetIdentityKey(item.kind, item.assetIdentity)
    const requestedIndex = existingAssetId ? ids.get(existingAssetId) : undefined
    const index = (requestedIndex !== undefined && assets[requestedIndex].kind === item.kind ? requestedIndex : undefined)
      ?? identities.get(identity) ?? legacyNames.get(scriptVideoAssetIdentityKey(item.kind, item.name))
    if (index !== undefined) {
      const previous = assets[index]
      const occurrences = mergeScriptVideoAssetOccurrences(previous.occurrences, item.occurrences)
      assets[index] = {
        ...previous,
        assetIdentity: previous.assetIdentity ?? item.assetIdentity,
        imagePrompt: previous.imagePrompt ?? item.imagePrompt,
        aliases: [...new Set([...(previous.aliases ?? []), ...item.aliases, item.name])].filter(name => name !== previous.name),
        sourceTitles: [...new Set([...(previous.sourceTitles ?? []), ...item.sourceTitles])],
        sourceEpisodes: [...new Set<number>([...(previous.sourceEpisodes ?? []), ...item.sourceEpisodes])].sort((a, b) => a - b),
        ...(occurrences && { occurrences }),
      }
      if (voiceProfile) voiceProfiles.set(previous.id, { draft: voiceProfile, observedAge: observedVoiceAge })
      identities.set(identity, index)
      if (!added.has(previous.id)) reused.add(previous.id)
      continue
    }
    let name = item.name
    for (let suffix = 2; displayNames.has(normalizedName(name)); suffix++) name = `${item.name}-${suffix}`
    displayNames.add(normalizedName(name))
    const id = randomUUID()
    identities.set(identity, assets.length)
    ids.set(id, assets.length)
    assets.push({ ...fields, id, name, image: '', imageStatus: 'pending', ...(name !== item.name && { originalName: item.name }) })
    if (voiceProfile) voiceProfiles.set(id, { draft: voiceProfile, observedAge: observedVoiceAge })
    added.add(id)
  }
  return { assets: mergeScriptVideoProjectVoices(assets, voiceProfiles), result: { added: added.size, reused: reused.size } }
}

export function registerScriptVideoAssetExtractionRoutes(
  app: Hono,
  store: ScriptVideoStore,
  respondError: (c: Context, error: unknown) => Response,
  extract = extractScriptVideoAssets,
) {
  const route = '/projects/:id/assets/extract'
  const handleError = (c: Context, error: unknown) => respondError(c,
    error instanceof ScriptVideoAssetExtractionJobError ? new ScriptVideoStoreError(error.message, error.status, error.code) : error)

  function runExtraction(jobs: ScriptVideoAssetExtractionJobs, claim: AssetExtractionClaim) {
    const controller = new AbortController()
    const loseClaim = () => controller.abort(new Error('提取任务已交还，请从已保存的进度继续。'))
    const heartbeat = setInterval(() => {
      try { if (!jobs.renew(claim)) loseClaim() }
      catch { loseClaim() }
    }, 15_000)
    heartbeat.unref()
    void (async () => {
      try {
        const items = await extract({
          ...claim.input,
          checkpoint: claim.checkpoint,
          signal: controller.signal,
          onCheckpoint(checkpoint) {
            const next = checkpoint.pending[0]
            const source = next && claim.input.sources[next.sourceIndex]
            const stage = source && { title: source.title, episodeNumber: source.episodeNumber }
            if (!jobs.checkpoint(claim, checkpoint, { completed: checkpoint.done, total: checkpoint.done + checkpoint.pending.length, stage })) {
              loseClaim()
              controller.signal.throwIfAborted()
            }
          },
        })
        controller.signal.throwIfAborted()
        // Both writes commit together. A retry after a storage error can apply
        // the completed checkpoint without replaying any model requests.
        await store.mutateAssets(claim.projectId, assets => {
          if (!jobs.owns(claim)) return { result: undefined }
          const merged = mergeProjectAssets(assets, items)
          if (!jobs.complete(claim, merged.result)) return { result: undefined }
          return merged
        })
      } catch (error) {
        if (!controller.signal.aborted) {
          try {
            const detail = safeTaskError(error)
            const message = isScriptVideoAssetExtractionResultUnknown(error)
              ? `当前分段未收到模型结果。上游可能已完成并计费，点击「继续提取」会重新请求此分段。${detail}`
              : isTransientScriptVideoAssetExtractionError(error) ? `文字模型暂时无法完成当前分段。${detail}` : detail
            jobs.fail(claim, message)
          }
          catch { loseClaim() }
        }
      } finally { clearInterval(heartbeat) }
    })()
  }

  app.get(route, async c => {
    try {
      const id = c.req.param('id')
      const jobs = await store.assetExtractionJobsFor(id)
      c.header('Cache-Control', 'no-store')
      return success(c, jobs.get(id) ?? null)
    } catch (error) { return handleError(c, error) }
  })

  app.post(route, bodyLimit({ maxSize: MAX_SCRIPT_BYTES + 512 * 1024, onError: c => c.json({
    code: 413, message: '本次导入的剧本超过 16 MB，请分批提取。',
  }, 413) }), async c => {
    try {
      const input = extractionInput.safeParse(await c.req.json().catch(() => null))
      if (!input.success) throw new ScriptVideoStoreError('请检查导入的剧本和文字模型设置。')
      const id = c.req.param('id')
      const jobs = await store.assetExtractionJobsFor(id)
      const previous = jobs.get(id)
      if (previous?.status === 'running') return success(c, previous)
      const project = await store.get(id)
      const sources = input.data.sources?.length ? input.data.sources : project.episodes.flatMap(episode => {
        const script = (episode.script || episode.confirmedScript || '').trim()
        return script ? [{ title: episode.title || `第 ${episode.number} 集`, script, episodeNumber: episode.number }] : []
      })
      if (!sources.length) throw new ScriptVideoStoreError('请先导入或保存剧本。')
      if (sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.script), 0) > MAX_SCRIPT_BYTES)
        throw new ScriptVideoStoreError('本次导入的剧本超过 16 MB，请分批提取。', 413)
      const { model, configId, restartJobId } = input.data
      const { job, run } = jobs.start(id, {
        sources, model, configId,
        existingAssets: project.assets.filter(asset => ['character', 'scene', 'prop', 'creature'].includes(asset.kind)).map(asset => ({
          id: asset.id, name: asset.name, kind: asset.kind, assetIdentity: asset.assetIdentity,
          aliases: asset.aliases, originalName: asset.originalName, sourcePath: asset.sourcePath, imagePrompt: asset.imagePrompt,
          voiceProfile: asset.voiceProfile,
          voiceLocked: Boolean(asset.voiceAudio || asset.voiceProfile?.generatedOutputId || asset.voiceDescription?.sourceLabel === '手动编辑'),
        })),
        style: project.settings?.stylePreset?.prefix,
      }, restartJobId)
      if (!run) return success(c, job)
      runExtraction(jobs, run)
      return created(c, job)
    } catch (error) { return handleError(c, error) }
  })

  app.post(`${route}/:jobId/resume`, bodyLimit({ maxSize: 8 * 1024 }), async c => {
    try {
      const body = await c.req.text()
      let requested: unknown = {}
      if (body.trim()) {
        try { requested = JSON.parse(body) }
        catch { requested = null }
      }
      const options = modelOptions.safeParse(requested)
      if (!options.success) throw new ScriptVideoStoreError('请检查文字模型设置。')
      const jobId = c.req.param('jobId')
      if (!z.uuid().safeParse(jobId).success) throw new ScriptVideoStoreError('提取任务不存在。', 404, 'NOT_FOUND')
      const id = c.req.param('id')
      const jobs = await store.assetExtractionJobsFor(id)
      const { job, run } = jobs.resume(id, jobId, options.data)
      if (!run) return success(c, job)
      runExtraction(jobs, run)
      return created(c, job)
    } catch (error) { return handleError(c, error) }
  })
}
