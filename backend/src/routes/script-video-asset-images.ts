import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { generateImage, recoverImageTask } from '../services/generation.js'
import { projectModelOptions, projectModelSelection, type ProjectModelSelection } from '../services/project-model-options.js'
import { scriptVideoAssetImagePrompt, scriptVideoMidjourneySceneDescription, scriptVideoMidjourneyScenePrompt } from '../services/script-video-asset-image-prompt.js'
import { rewriteScriptVideoMidjourneyScene } from '../services/script-video-midjourney-scene-rewrite.js'
import { ScriptVideoStoreError, type ScriptVideoStore } from '../services/script-video-store.js'
import type { ScriptVideoAssetImageFields } from '../services/script-video-types.js'
import { safeTaskError } from '../services/video-download.js'
import { badRequest, success } from '../utils/response.js'
import { logTaskError, logTaskWarn } from '../utils/task-logger.js'

const imageAspect = { scene: '16:9', character: '16:9', prop: '1:1', creature: '16:9' } as const
const assetIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u)).min(1).max(1000)
const requestSchema = z.union([
  projectModelSelection.partial().extend({ assetIds }).strict(),
  z.strictObject({ assetIds, mode: z.literal('midjourney') }),
])

type ImageOwner = NonNullable<Parameters<typeof generateImage>[0]['scriptVideoAsset']>
type ImageSelection = Partial<ProjectModelSelection>
type ImageTask = { id: number; status: string | null; localPath: string | null; error: string | null }
type ImageAsset = ScriptVideoAssetImageFields & {
  id: string
  name: string
  kind: string
  image: string
  imageRequestId?: string
}
type ImageRequest = {
  owner: ImageOwner
  prompt: string
  selection: ProjectModelSelection
  aspect: typeof imageAspect[keyof typeof imageAspect]
  midjourney: boolean
}
type ImagePatch = ScriptVideoAssetImageFields & { image?: string }

function selectTextImageModel(selection: ImageSelection, midjourneyImagineOnly = false): ProjectModelSelection | undefined {
  const selected = projectModelOptions({ configId: selection.configId, imageMode: 'text', midjourneyImagineOnly })
    .find(option => option.kind === 'image' && (!selection.model || option.model === selection.model))
  if (selected) return { configId: selected.configId, model: selected.model }
}

function readImageTask(owner: ImageOwner, id?: number): ImageTask | undefined {
  const task = schema.sysTask
  const row = db.select({ id: task.id, status: task.status, localPath: task.localPath, error: task.errorMsg, params: task.params })
    .from(task).where(and(eq(task.type, 'image'), id === undefined
      ? sql`CASE WHEN json_valid(${task.params}) THEN json_extract(${task.params}, '$.scriptVideoAsset.requestId') END = ${owner.requestId}`
      : eq(task.id, id))).get()
  if (!row?.params) return
  const { params, ...result } = row
  let stored: ImageOwner | undefined
  try { stored = JSON.parse(params)?.scriptVideoAsset } catch { return }
  if (stored?.requestId === owner.requestId && stored.projectId === owner.projectId && stored.assetId === owner.assetId) return result
}

function trackedOwner(projectId: string, asset: ImageAsset): ImageOwner | undefined {
  if (typeof asset.imageRequestId === 'string' && (asset.imageStatus === 'generating' ||
      (asset.imageTaskId !== undefined && ['failed', 'delivery_pending'].includes(asset.imageStatus || '')))) {
    return { projectId, assetId: asset.id, requestId: asset.imageRequestId }
  }
}

function canResumeDelivery(status: string | null | undefined) {
  return status === 'delivery_pending' || status === 'processing' || status === 'completed'
}

function imageUpdate(task: ImageTask | undefined): ImagePatch {
  if (!task) return { imageTaskId: undefined, imageStatus: 'failed', imageError: '图片任务已中断，可以重新生成。' }
  if (task.status === 'processing') return { imageTaskId: task.id, imageStatus: 'generating', imageError: undefined }
  if (task.status === 'delivery_pending') return { imageTaskId: task.id, imageStatus: 'delivery_pending',
    imageError: task.error ? safeTaskError(task.error) : '图片已生成，可以重试取回原图。' }
  if (task.status === 'completed' && /^\/?static\/images\/[a-z0-9_-]+\.(?:png|jpe?g|webp|gif|avif|heic|heif)$/iu.test(task.localPath || '')) {
    return { imageTaskId: task.id, imageStatus: 'completed', imageError: undefined, image: '/' + task.localPath!.replace(/^\//u, '') }
  }
  return { imageTaskId: task.id, imageStatus: 'failed', imageError: task.error ? safeTaskError(task.error) : '图片生成失败。' }
}

const defaults = { generateImage, recoverImageTask, readImageTask, selectTextImageModel, rewriteScriptVideoMidjourneyScene, pollIntervalMs: 1500, workers: 3 }

export function createScriptVideoAssetImages(store: Pick<ScriptVideoStore, 'summary' | 'mutateAssets'>, overrides: Partial<typeof defaults> = {}) {
  const dependencies = { ...defaults, ...overrides }
  const routes = new Hono()
  const queue: ImageRequest[] = []
  const owned = new Set<string>()
  let active = 0

  function publish(owner: ImageOwner, patch: ImagePatch) {
    return store.mutateAssets(owner.projectId, assets => ({
      assets: assets.map((asset: ImageAsset) => asset.id === owner.assetId && asset.imageStatus === 'generating' && asset.imageRequestId === owner.requestId
        ? { ...asset, ...patch } : asset),
      result: undefined,
    }))
  }

  async function hasPendingRequest(owner: ImageOwner) {
    const project = await store.summary(owner.projectId)
    return project.assets.some(asset => asset.id === owner.assetId && asset.imageStatus === 'generating' && asset.imageRequestId === owner.requestId)
  }

  async function run({ owner, prompt, selection, aspect, midjourney }: ImageRequest) {
    if (!await hasPendingRequest(owner)) return
    let taskId: number
    try {
      if (midjourney) {
        const description = scriptVideoMidjourneySceneDescription(prompt)
        let rewritten: string | undefined
        if (description) {
          try { rewritten = await dependencies.rewriteScriptVideoMidjourneyScene(description) }
          catch (error) {
            logTaskWarn('ScriptVideoAssetImage', 'midjourney-prompt-fallback', { ...owner, error: safeTaskError(error) })
          }
          if (!await hasPendingRequest(owner)) return
        }
        prompt = scriptVideoMidjourneyScenePrompt(prompt, rewritten)
      }
      taskId = await dependencies.generateImage({ prompt, ...selection, galleryAspect: aspect, scriptVideoAsset: owner })
    } catch (error) {
      await publish(owner, { imageStatus: 'failed', imageError: safeTaskError(error) })
      return
    }

    await publish(owner, { imageTaskId: taskId })
    const deadline = Date.now() + 14 * 60_000
    do {
      const task = dependencies.readImageTask(owner, taskId)
      if (task?.status !== 'processing') {
        await publish(owner, imageUpdate(task))
        return
      }
      await delay(dependencies.pollIntervalMs, undefined, { ref: false })
    } while (Date.now() < deadline)
  }

  function drain() {
    while (active < dependencies.workers && queue.length) {
      const item = queue.shift()!
      active++
      void run(item).catch(error => {
        logTaskError('ScriptVideoAssetImage', 'sync-failed', { ...item.owner, error: safeTaskError(error) })
      }).finally(() => {
        owned.delete(item.owner.requestId)
        active--
        drain()
      })
    }
  }

  async function refresh(projectId: string, snapshot?: Pick<Awaited<ReturnType<ScriptVideoStore['summary']>>, 'assets'>) {
    const project = snapshot ?? await store.summary(projectId)
    const updates = new Map<string, { requestId: string; previous: ImageAsset['imageStatus']; patch: ImagePatch }>()
    for (const asset of project.assets as ImageAsset[]) {
      const owner = trackedOwner(projectId, asset)
      if (!owner || owned.has(owner.requestId)) continue
      const task = dependencies.readImageTask(owner, asset.imageTaskId)
        ?? (asset.imageTaskId !== undefined ? dependencies.readImageTask(owner) : undefined)
      // Older versions marked an interrupted download as failed. Reconcile it only
      // when the task still belongs to this request and has a recoverable result.
      if (asset.imageStatus === 'failed' && !canResumeDelivery(task?.status)) continue
      const patch = imageUpdate(task)
      if (Object.entries(patch).every(([key, value]) => asset[key as keyof ImagePatch] === value)) continue
      updates.set(asset.id, { requestId: owner.requestId, previous: asset.imageStatus, patch })
    }
    if (!updates.size) return false

    return store.mutateAssets(projectId, assets => {
      let changed = false
      const next = assets.map((asset: ImageAsset) => {
        const update = updates.get(asset.id)
        if (!update || asset.imageStatus !== update.previous || asset.imageRequestId !== update.requestId) return asset
        changed = true
        return { ...asset, ...update.patch }
      })
      return { assets: next, result: changed }
    })
  }

  routes.post('/projects/:id/assets/:assetId/recover-image', async c => {
    const projectId = c.req.param('id')
    try {
      const project = await store.summary(projectId)
      const asset = project.assets.find(asset => asset.id === c.req.param('assetId'))
      const owner = asset && trackedOwner(projectId, asset)
      const task = owner && asset?.imageTaskId !== undefined ? dependencies.readImageTask(owner, asset.imageTaskId) : undefined
      if (!task || !canResumeDelivery(task.status)) return badRequest(c, '该资产没有可取回的原图。')
      if (task.status === 'delivery_pending') await dependencies.recoverImageTask(task.id)
      await refresh(projectId)
      return success(c, { taskId: task.id })
    } catch (error) {
      if (error instanceof ScriptVideoStoreError) return c.json({ code: error.code, message: error.message }, error.status as ContentfulStatusCode)
      return badRequest(c, safeTaskError(error))
    }
  })

  routes.post('/projects/:id/assets/generate', async c => {
    const projectId = c.req.param('id')
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return badRequest(c, '请选择需要出图的项目资产和有效的图片模型。')
    const input = parsed.data
    const midjourney = 'mode' in input
    const selection = midjourney ? dependencies.selectTextImageModel({}, true) : dependencies.selectTextImageModel(input)
    if (!selection) return badRequest(c, midjourney
      ? '请在模型设置中启用「火灵灵 · Midjourney」的 mj_imagine 模型后重试。'
      : '请在设置中启用支持文生图的模型，或重新选择图片模型。')

    const requests = new Map([...new Set(input.assetIds)].map(assetId => [assetId, randomUUID()]))
    for (const requestId of requests.values()) owned.add(requestId)
    try {
      const work = await store.mutateAssets(projectId, assets => {
        const items: ImageRequest[] = []
        const next = assets.map((asset: ImageAsset) => {
          const requestId = requests.get(asset.id)
          if (!requestId || asset.imageStatus === 'generating' || (midjourney && asset.kind !== 'scene')) return asset
          const prompt = asset.imagePrompt?.trim()
          const aspect = Object.hasOwn(imageAspect, asset.kind) ? imageAspect[asset.kind as keyof typeof imageAspect] : undefined
          if (!prompt || !aspect) return asset
          items.push({
            owner: { projectId, assetId: asset.id, requestId },
            prompt: midjourney ? prompt : scriptVideoAssetImagePrompt(asset.kind, prompt, asset.name),
            selection, aspect, midjourney,
          })
          return { ...asset, imageTaskId: undefined, imageError: undefined, imageStatus: 'generating', imageRequestId: requestId }
        })
        return { assets: next, result: items }
      })
      const started = work.map(item => item.owner.assetId)
      const startedIds = new Set(started)
      for (const [assetId, requestId] of requests) if (!startedIds.has(assetId)) owned.delete(requestId)
      queue.push(...work)
      drain()
      return success(c, { started })
    } catch (error) {
      for (const requestId of requests.values()) owned.delete(requestId)
      if (error instanceof ScriptVideoStoreError) return c.json({ code: error.code, message: error.message }, error.status as ContentfulStatusCode)
      logTaskError('ScriptVideoAssetImage', 'queue-failed', { projectId, error: safeTaskError(error) })
      return c.json({ code: 'IMAGE_QUEUE_FAILED', message: '无法提交图片生成任务，请重试。' }, 500)
    }
  })

  return { routes, refresh }
}
