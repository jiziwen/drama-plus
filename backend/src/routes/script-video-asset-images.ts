import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { generateImage } from '../services/generation.js'
import { projectModelOptions, projectModelSelection, type ProjectModelSelection } from '../services/project-model-options.js'
import { ScriptVideoStoreError, type ScriptVideoStore } from '../services/script-video-store.js'
import type { ScriptVideoAssetImageFields } from '../services/script-video-types.js'
import { safeTaskError } from '../services/video-download.js'
import { badRequest, success } from '../utils/response.js'
import { logTaskError } from '../utils/task-logger.js'

const imageAspect = { scene: '16:9', character: '16:9', prop: '1:1', creature: '16:9' } as const
const requestSchema = projectModelSelection.partial().extend({
  assetIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/u)).min(1).max(1000),
}).strict()

type ImageOwner = NonNullable<Parameters<typeof generateImage>[0]['scriptVideoAsset']>
type ImageSelection = Partial<ProjectModelSelection>
type ImageTask = { id: number; status: string | null; localPath: string | null; error: string | null }
type ImageAsset = ScriptVideoAssetImageFields & {
  id: string
  kind: string
  image: string
  imageRequestId?: string
}
type ImageRequest = {
  owner: ImageOwner
  prompt: string
  selection: ProjectModelSelection
  aspect: typeof imageAspect[keyof typeof imageAspect]
}
type ImagePatch = ScriptVideoAssetImageFields & { image?: string }

function selectTextImageModel(selection: ImageSelection): ProjectModelSelection | undefined {
  const selected = projectModelOptions({ configId: selection.configId, imageMode: 'text' })
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

function pendingOwner(projectId: string, asset: ImageAsset): ImageOwner | undefined {
  if (asset.imageStatus === 'generating' && typeof asset.imageRequestId === 'string') {
    return { projectId, assetId: asset.id, requestId: asset.imageRequestId }
  }
}

function imageUpdate(task: ImageTask | undefined): ImagePatch {
  if (!task) return { imageTaskId: undefined, imageStatus: 'failed', imageError: '图片任务已中断，可以重新生成。' }
  if (task.status === 'processing') return { imageTaskId: task.id }
  if (task.status === 'completed' && /^\/?static\/images\/[a-z0-9_-]+\.(?:png|jpe?g|webp|gif|avif|heic|heif)$/iu.test(task.localPath || '')) {
    return { imageTaskId: task.id, imageStatus: 'completed', imageError: undefined, image: '/' + task.localPath!.replace(/^\//u, '') }
  }
  return { imageTaskId: task.id, imageStatus: 'failed', imageError: task.error ? safeTaskError(task.error) : '图片生成失败。' }
}

const defaults = { generateImage, readImageTask, selectTextImageModel, pollIntervalMs: 1500, workers: 3 }

export function createScriptVideoAssetImages(store: Pick<ScriptVideoStore, 'summary' | 'mutateAssets'>, overrides: Partial<typeof defaults> = {}) {
  const dependencies = { ...defaults, ...overrides }
  const routes = new Hono()
  const queue: ImageRequest[] = []
  const owned = new Set<string>()
  let active = 0

  function publish(owner: ImageOwner, patch: ImagePatch) {
    return store.mutateAssets(owner.projectId, assets => ({
      assets: assets.map((asset: ImageAsset) => asset.id === owner.assetId && pendingOwner(owner.projectId, asset)?.requestId === owner.requestId
        ? { ...asset, ...patch } : asset),
      result: undefined,
    }))
  }

  async function run({ owner, prompt, selection, aspect }: ImageRequest) {
    const project = await store.summary(owner.projectId)
    const asset = project.assets.find(item => item.id === owner.assetId)
    if (!asset || pendingOwner(owner.projectId, asset)?.requestId !== owner.requestId) return
    let taskId: number
    try {
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
    const updates = new Map<string, { requestId: string; patch: ImagePatch }>()
    for (const asset of project.assets as ImageAsset[]) {
      const owner = pendingOwner(projectId, asset)
      if (!owner || owned.has(owner.requestId)) continue
      const task = dependencies.readImageTask(owner, asset.imageTaskId)
        ?? (asset.imageTaskId !== undefined ? dependencies.readImageTask(owner) : undefined)
      if (task?.status === 'processing' && task.id === asset.imageTaskId) continue
      updates.set(asset.id, { requestId: owner.requestId, patch: imageUpdate(task) })
    }
    if (!updates.size) return false

    return store.mutateAssets(projectId, assets => {
      let changed = false
      const next = assets.map((asset: ImageAsset) => {
        const update = updates.get(asset.id)
        if (!update || pendingOwner(projectId, asset)?.requestId !== update.requestId) return asset
        changed = true
        return { ...asset, ...update.patch }
      })
      return { assets: next, result: changed }
    })
  }

  routes.post('/projects/:id/assets/generate', async c => {
    const projectId = c.req.param('id')
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return badRequest(c, '请选择需要出图的项目资产和有效的图片模型。')
    const selection = dependencies.selectTextImageModel(parsed.data)
    if (!selection) return badRequest(c, '请在设置中启用支持文生图的模型，或重新选择图片模型。')

    const requests = new Map([...new Set(parsed.data.assetIds)].map(assetId => [assetId, randomUUID()]))
    for (const requestId of requests.values()) owned.add(requestId)
    try {
      const work = await store.mutateAssets(projectId, assets => {
        const items: ImageRequest[] = []
        const next = assets.map((asset: ImageAsset) => {
          const requestId = requests.get(asset.id)
          if (!requestId || asset.imageStatus === 'generating') return asset
          const prompt = asset.imagePrompt?.trim()
          const aspect = Object.hasOwn(imageAspect, asset.kind) ? imageAspect[asset.kind as keyof typeof imageAspect] : undefined
          if (!prompt || !aspect) return asset
          items.push({ owner: { projectId, assetId: asset.id, requestId }, prompt, selection, aspect })
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
