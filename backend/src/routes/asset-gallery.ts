import { Hono } from 'hono'
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, getInsertId, schema } from '../db/index.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import {
  GALLERY_ASSET_KINDS, GALLERY_IMAGE_ASPECTS, isGalleryImageAspect,
  type GalleryAsset, type GalleryAssetKind, type GalleryImageRequest,
} from '../services/gallery-asset-types.js'
import { generateImage } from '../services/generation.js'
import { projectModelOptions, projectModelSelection } from '../services/project-model-options.js'
import { safeTaskError } from '../services/video-download.js'

const kindSchema = z.enum(GALLERY_ASSET_KINDS)
const imageSchema = projectModelSelection.extend({
  prompt: z.string().trim().min(1).max(12_000),
  aspect: z.enum(GALLERY_IMAGE_ASPECTS),
})
const createSchema = imageSchema.extend({ kind: kindSchema, name: z.string().trim().max(120).optional() })
const assetTaskFields = { characters: 'characterId', scenes: 'sceneId', props: 'propId' } as const
const task = schema.sysTask

function findProject(projectId: number) {
  return db.select({ id: schema.dramas.id }).from(schema.dramas)
    .where(and(eq(schema.dramas.id, projectId), isNull(schema.dramas.deletedAt))).get()
}

function assetCondition(table: typeof schema[GalleryAssetKind], projectId: number, id?: number) {
  return and(eq(table.dramaId, projectId), isNull(table.deletedAt), id === undefined ? undefined : eq(table.id, id))
}

function listAssets(projectId: number): GalleryAsset[] {
  const recentTasks = db.select({ id: sql<number>`max(${task.id})` }).from(task)
    .where(and(eq(task.dramaId, projectId), eq(task.type, 'image'),
      or(isNotNull(task.characterId), isNotNull(task.sceneId), isNotNull(task.propId))))
    .groupBy(task.characterId, task.sceneId, task.propId)
  const tasks = db.select({
    id: task.id, characterId: task.characterId, sceneId: task.sceneId, propId: task.propId,
    status: task.status, stage: task.stage, error: task.errorMsg, prompt: task.prompt, model: task.model, configId: task.configId,
    resultUrl: task.resultUrl, localPath: task.localPath,
    aspect: sql<unknown>`case when json_valid(${task.params}) then json_extract(${task.params}, '$.galleryAspect') end`,
  }).from(task).where(inArray(task.id, recentTasks)).all()
  const byAsset = new Map<string, typeof tasks[number]>()
  for (const row of tasks) {
    for (const kind of GALLERY_ASSET_KINDS) {
      const id = row[assetTaskFields[kind]]
      if (id == null) continue
      const key = `${kind}:${id}`
      if ((byAsset.get(key)?.id ?? 0) < row.id) byAsset.set(key, row)
    }
  }

  return GALLERY_ASSET_KINDS.flatMap(kind => {
    const table = schema[kind]
    return db.select().from(table).where(assetCondition(table, projectId)).orderBy(table.id).all().map(row => {
      const recent = byAsset.get(`${kind}:${row.id}`)
      const aspect = isGalleryImageAspect(recent?.aspect) ? recent.aspect : null
      const description = ('appearance' in row ? row.appearance : '') || ('description' in row ? row.description : '') || ('prompt' in row ? row.prompt : '') || ''
      return {
        id: row.id, kind, name: 'name' in row ? row.name : row.location,
        description: aspect ? recent?.prompt || description : description,
        prompt: (aspect ? recent?.prompt : row.finalPrompt) || description,
        model: (aspect ? recent?.model : row.imageModel) ?? recent?.model ?? null,
        configId: (aspect ? recent?.configId : row.imageConfigId) ?? recent?.configId ?? null,
        image: row.imageUrl || row.localPath,
        aspect,
        task: recent ? {
          id: recent.id, status: recent.status, stage: recent.stage, error: recent.error,
          canRetryDelivery: recent.status === 'delivery_pending' && Boolean(recent.resultUrl || recent.localPath),
        } : null,
      }
    })
  })
}

function insertAsset(projectId: number, input: z.infer<typeof createSchema>) {
  const timestamp = now()
  const fallback = { characters: '未命名人物', scenes: '未命名场景', props: '未命名物品' }[input.kind]
  const firstLine = input.prompt.split(/[\r\n。！？；;.!?]/u).find(part => /[\p{L}\p{N}]/u.test(part))?.trim()
  const suggestedName = firstLine?.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').replace(/\s+/gu, ' ')
  const name = input.name || (suggestedName ? Array.from(suggestedName).slice(0, 40).join('') : fallback)
  const common = {
    dramaId: projectId, createdAt: timestamp, updatedAt: timestamp,
    finalPrompt: input.prompt, imageModel: input.model, imageConfigId: input.configId,
  }
  if (input.kind === 'scenes') {
    const id = getInsertId(db.insert(schema.scenes).values({ ...common, location: name, time: '', prompt: input.prompt }).run())
    return { id, name }
  }
  const table = schema[input.kind]
  const id = getInsertId(db.insert(table).values({ ...common, name, description: input.prompt }).run())
  return { id, name }
}

function enqueue(projectId: number, kind: GalleryAssetKind, assetId: number, input: GalleryImageRequest) {
  return generateImage({
    [assetTaskFields[kind]]: assetId,
    dramaId: projectId, prompt: input.prompt, configId: input.configId, model: input.model, galleryAspect: input.aspect,
  })
}

const app = new Hono()
app.get('/models', c => success(c, projectModelOptions({ imageMode: 'text' }).filter(option => option.kind === 'image')))

app.get('/:projectId', c => {
  const projectId = Number(c.req.param('projectId'))
  if (!findProject(projectId)) return notFound(c, '项目不存在')
  return success(c, listAssets(projectId))
})

app.post('/:projectId', async c => {
  const projectId = Number(c.req.param('projectId'))
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, '请填写提示词，并选择有效的资产类型、尺寸及生图模型。')
  if (!findProject(projectId)) return notFound(c, '项目不存在')
  const input = parsed.data
  const model = projectModelOptions({ configId: input.configId, imageMode: 'text' })
    .find(option => option.kind === 'image' && option.model === input.model)
  if (!model) return badRequest(c, '所选生图模型不可用，请重新选择。')
  const { id, name } = insertAsset(projectId, input)
  try {
    const taskId = await enqueue(projectId, input.kind, id, input)
    return created(c, { id, name, taskId })
  } catch (error) {
    // A rejected submission has no task. Keep the asset so its prompt can be retried.
    return created(c, { id, name, taskId: null, error: safeTaskError(error) })
  }
})

app.post('/:projectId/:kind/:id/generate', async c => {
  const projectId = Number(c.req.param('projectId'))
  const id = Number(c.req.param('id'))
  const kind = kindSchema.safeParse(c.req.param('kind'))
  const input = imageSchema.safeParse(await c.req.json().catch(() => null))
  if (!kind.success || !input.success) return badRequest(c, '请填写提示词并选择有效的尺寸和生图模型。')
  const table = schema[kind.data]
  if (!findProject(projectId) || !db.select({ id: table.id }).from(table).where(assetCondition(table, projectId, id)).get()) {
    return notFound(c, '项目资产不存在')
  }
  try {
    return success(c, { id, taskId: await enqueue(projectId, kind.data, id, input.data) })
  } catch (error) {
    return badRequest(c, safeTaskError(error))
  }
})

app.delete('/:projectId/:kind/:id', c => {
  const projectId = Number(c.req.param('projectId'))
  const id = Number(c.req.param('id'))
  const kind = kindSchema.safeParse(c.req.param('kind'))
  if (!kind.success) return notFound(c, '资产类型不存在')
  const table = schema[kind.data]
  if (!db.select({ id: table.id }).from(table).where(assetCondition(table, projectId, id)).get()) return notFound(c, '项目资产不存在')
  const active = db.select({ id: task.id }).from(task).where(and(eq(task.type, 'image'),
    eq(task[assetTaskFields[kind.data]], id), eq(task.status, 'processing'))).get()
  if (active) return c.json({ code: 409, message: '这项资产正在生成，请等本次生成结束后再删除。' }, 409)
  const timestamp = now()
  const deleted = db.update(table).set({ deletedAt: timestamp, updatedAt: timestamp })
    .where(assetCondition(table, projectId, id)).run()
  return deleted.changes ? success(c) : notFound(c, '项目资产不存在')
})

export default app
