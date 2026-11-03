import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

interface ImageTarget { characterId?: number; sceneId?: number; propId?: number }
const requests = new Map<string, Promise<number>>()
const submissions = new Map<string, Promise<number>>()

function coalesceImageRequest(target: ImageTarget, pending: Map<string, Promise<number>>, submit: () => Promise<number>): Promise<number> {
  const field = (['characterId', 'sceneId', 'propId'] as const).find(field => target[field] !== undefined)
  if (!field) return submit()
  const id = target[field]!
  const key = `${field}:${id}`
  const current = pending.get(key)
  if (current) return current
  const promise = Promise.resolve().then(async () => {
    const existing = db.select({ id: schema.sysTask.id }).from(schema.sysTask)
      .where(and(eq(schema.sysTask.type, 'image'), eq(schema.sysTask[field], id), eq(schema.sysTask.status, 'processing')))
      .orderBy(desc(schema.sysTask.id)).limit(1).get()
    return existing ? existing.id : submit()
  }).finally(() => { if (pending.get(key) === promise) pending.delete(key) })
  pending.set(key, promise)
  return promise
}

/** 覆盖最终提示词准备到任务入队，合并批量、单个和跨页面同时提交。 */
export const withAssetImageRequest = (target: ImageTarget, submit: () => Promise<number>) => coalesceImageRequest(target, requests, submit)
/** 统一任务入口兜底：HTTP 路由之外的调用也不能重复创建运行中的资产图片任务。 */
export const withImageTaskSubmission = (target: ImageTarget, submit: () => Promise<number>) => coalesceImageRequest(target, submissions, submit)
