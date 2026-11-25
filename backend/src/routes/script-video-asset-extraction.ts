import { randomUUID } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { created, success } from '../utils/response.js'
import {
  extractScriptVideoAssets,
  scriptVideoAssetIdentityKey,
  type ScriptVideoExtractedAsset,
} from '../services/script-video-asset-extraction.js'
import { ScriptVideoStoreError, type ScriptVideoProject, type ScriptVideoStore } from '../services/script-video-store.js'
import { safeTaskError } from '../services/video-download.js'

const MAX_SCRIPT_BYTES = 16 * 1024 * 1024
const extractionInput = z.object({
  sources: z.array(z.object({
    title: z.string().trim().min(1).max(400),
    script: z.string().trim().min(1),
    episodeNumber: z.number().int().positive().optional(),
  })).max(2000).optional(),
  configId: z.number().int().positive().optional(),
  model: z.string().trim().min(1).max(300).optional(),
})

type ExtractionJob = {
  id: string
  status: 'running' | 'completed' | 'failed'
  completed: number
  total: number
  added?: number
  reused?: number
  error?: string
}

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
  for (const item of items) {
    const identity = scriptVideoAssetIdentityKey(item.kind, item.assetIdentity)
    const requestedIndex = item.existingAssetId ? ids.get(item.existingAssetId) : undefined
    const index = (requestedIndex !== undefined && assets[requestedIndex].kind === item.kind ? requestedIndex : undefined)
      ?? identities.get(identity) ?? legacyNames.get(scriptVideoAssetIdentityKey(item.kind, item.name))
    if (index !== undefined) {
      const previous = assets[index]
      assets[index] = {
        ...previous,
        assetIdentity: previous.assetIdentity ?? item.assetIdentity,
        imagePrompt: previous.imagePrompt ?? item.imagePrompt,
        aliases: [...new Set([...(previous.aliases ?? []), ...item.aliases, item.name])].filter(name => name !== previous.name),
        sourceTitles: [...new Set([...(previous.sourceTitles ?? []), ...item.sourceTitles])],
        sourceEpisodes: [...new Set<number>([...(previous.sourceEpisodes ?? []), ...item.sourceEpisodes])].sort((a, b) => a - b),
      }
      identities.set(identity, index)
      if (!added.has(previous.id)) reused.add(previous.id)
      continue
    }
    let name = item.name
    for (let suffix = 2; displayNames.has(normalizedName(name)); suffix++) name = `${item.name}-${suffix}`
    displayNames.add(normalizedName(name))
    const { existingAssetId: _existingAssetId, ...fields } = item
    const id = randomUUID()
    identities.set(identity, assets.length)
    ids.set(id, assets.length)
    assets.push({ ...fields, id, name, image: '', imageStatus: 'pending', ...(name !== item.name && { originalName: item.name }) })
    added.add(id)
  }
  return { assets, result: { added: added.size, reused: reused.size } }
}

export function registerScriptVideoAssetExtractionRoutes(
  app: Hono,
  store: ScriptVideoStore,
  respondError: (c: Context, error: unknown) => Response,
  extract = extractScriptVideoAssets,
) {
  const jobs = new Map<string, ExtractionJob>()
  const route = '/projects/:id/assets/extract'
  app.get(route, async c => {
    try {
      const id = c.req.param('id')
      await store.summary(id)
      c.header('Cache-Control', 'no-store')
      return success(c, jobs.get(id) ?? null)
    } catch (error) { return respondError(c, error) }
  })

  app.post(route, bodyLimit({ maxSize: MAX_SCRIPT_BYTES + 512 * 1024, onError: c => c.json({
    code: 413, message: '本次导入的剧本超过 16 MB，请分批提取。',
  }, 413) }), async c => {
    try {
      const input = extractionInput.safeParse(await c.req.json().catch(() => null))
      if (!input.success) throw new ScriptVideoStoreError('请检查导入的剧本和文字模型设置。')
      const id = c.req.param('id')
      const project = await store.get(id)
      const sources = input.data.sources?.length ? input.data.sources : project.episodes.flatMap(episode => {
        const script = (episode.script || episode.confirmedScript || '').trim()
        return script ? [{ title: episode.title || `第 ${episode.number} 集`, script, episodeNumber: episode.number }] : []
      })
      if (!sources.length) throw new ScriptVideoStoreError('请先导入或保存剧本。')
      if (sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.script), 0) > MAX_SCRIPT_BYTES)
        throw new ScriptVideoStoreError('本次导入的剧本超过 16 MB，请分批提取。', 413)
      const previous = jobs.get(id)
      if (previous?.status === 'running') return success(c, previous)
      const job: ExtractionJob = { id: randomUUID(), status: 'running', completed: 0, total: 0 }
      jobs.set(id, job)
      void (async () => {
        try {
          const items = await extract({
            sources,
            existingAssets: project.assets,
            style: project.settings?.stylePreset?.prefix,
            model: input.data.model,
            configId: input.data.configId,
            onProgress(completed, total) { Object.assign(job, { completed, total }) },
          })
          const counts = await store.mutateAssets(id, assets => mergeProjectAssets(assets, items))
          Object.assign(job, counts, { status: 'completed', completed: job.total })
        } catch (error) {
          job.error = safeTaskError(error).slice(0, 800)
          job.status = 'failed'
        } finally {
          setTimeout(() => { if (jobs.get(id) === job) jobs.delete(id) }, 60 * 60 * 1000).unref()
        }
      })()
      return created(c, job)
    } catch (error) { return respondError(c, error) }
  })
}
