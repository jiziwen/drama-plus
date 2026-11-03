import { Hono } from 'hono'
import { and, asc, count, desc, eq, gt, like, max, min, sql } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, notFound } from '../utils/response.js'
import { describeLoggedRequest, parseLoggedJson, requestParameters } from '../utils/api-call-request.js'
import { sanitizeCallData } from '../services/api-call-log.js'

const app = new Hono()
const table = schema.apiCallLogs
const summary = { id: table.id, provider: table.provider, category: table.category, model: table.model, taskId: table.taskId, dramaId: table.dramaId,
  method: table.method, url: table.url, status: table.status, statusCode: table.statusCode, durationMs: table.durationMs, error: table.error, createdAt: table.createdAt }
function aggregate(where: ReturnType<typeof and>) {
  return db.select({ id: max(table.id).as('last_id'), callCount: count().as('call_count'),
    firstAt: min(table.createdAt).as('first_at'), lastAt: max(table.createdAt).as('last_at'),
    totalDurationMs: sql<number>`coalesce(sum(${table.durationMs}), 0)`.mapWith(Number).as('total_duration_ms'),
    successCount: sql<number>`sum(case when ${table.status} = 'success' then 1 else 0 end)`.mapWith(Number).as('success_count'),
    errorCount: sql<number>`sum(case when ${table.status} = 'error' then 1 else 0 end)`.mapWith(Number).as('error_count'),
    pendingCount: sql<number>`sum(case when ${table.status} = 'pending' then 1 else 0 end)`.mapWith(Number).as('pending_count'),
  }).from(table).where(where).groupBy(sql`coalesce(${table.requestKey}, 'id:' || ${table.id})`).as('groups')
}
app.get('/', c => {
  const page = Math.max(1, Math.floor(Number(c.req.query('page')) || 1))
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(c.req.query('page_size')) || 25)))
  const filters = []
  for (const key of ['provider', 'category'] as const) {
    const value = c.req.query(key)
    if (value) filters.push(eq(table[key], value))
  }
  const task = Number(c.req.query('task_id'))
  if (Number.isSafeInteger(task) && task > 0) filters.push(eq(table.taskId, task))
  const keyword = c.req.query('keyword')?.trim()
  if (keyword) filters.push(like(table.url, `%${keyword}%`))
  const baseWhere = and(...filters)
  const status = c.req.query('status')
  if (c.req.query('grouped') === '0') {
    const where = and(baseWhere, status ? eq(table.status, status) : undefined)
    const items = db.select({ ...summary, callCount: sql<number>`1`, firstAt: table.createdAt, lastAt: table.createdAt }).from(table).where(where)
      .orderBy(desc(table.id)).limit(pageSize).offset((page - 1) * pageSize).all()
    const total = db.select({ value: count() }).from(table).where(where).get()!.value
    return success(c, { items, total, totalCalls: total, grouped: false, page, page_size: pageSize })
  }
  const groups = aggregate(baseWhere)
  const where = status === 'success' ? gt(groups.successCount, 0) : status === 'error' ? gt(groups.errorCount, 0) : status === 'pending' ? gt(groups.pendingCount, 0) : undefined
  const items = db.select({ ...summary, callCount: groups.callCount, firstAt: groups.firstAt, lastAt: groups.lastAt,
    successCount: groups.successCount, errorCount: groups.errorCount, pendingCount: groups.pendingCount, totalDurationMs: groups.totalDurationMs,
  }).from(table).innerJoin(groups, eq(table.id, groups.id)).where(where).orderBy(desc(table.id)).limit(pageSize).offset((page - 1) * pageSize).all()
  const totals = db.select({ total: count(), totalCalls: sql<number>`coalesce(sum(${groups.callCount}), 0)`.mapWith(Number) }).from(groups).where(where).get()!
  return success(c, { items, ...totals, grouped: true, page, page_size: pageSize })
})
app.get('/:id', c => {
  let row = db.select().from(table).where(eq(table.id, Number(c.req.param('id')))).get()
  if (!row) return notFound(c, '调用记录不存在')
  const sameRequest = row.requestKey ? eq(table.requestKey, row.requestKey) : eq(table.id, row.id)
  if (c.req.query('grouped') === '1') row = db.select().from(table).where(sameRequest).orderBy(desc(table.id)).get()!
  const groups = aggregate(sameRequest)
  const group = db.select().from(groups).get()!
  const attempts = db.select(summary).from(table).where(sameRequest).orderBy(desc(table.id)).limit(50).all()
  const params = requestParameters(row.method, row.url)
  const isHistory = row.provider === 'comfyui' && row.method === 'GET' && !!params.pathParams.prompt_id
  let generationRequest: any = null
  if (isHistory) {
    const promptUrl = new URL(row.url)
    promptUrl.pathname = promptUrl.pathname.replace(/\/history\/[^/]+\/?$/, '/prompt')
    promptUrl.search = ''
    const identity = row.taskId ? eq(table.taskId, row.taskId)
      : sql`case when json_valid(${table.response}) then json_extract(${table.response}, '$.body.prompt_id') end = ${params.pathParams.prompt_id}`
    const original = db.select().from(table).where(and(eq(table.provider, 'comfyui'), eq(table.method, 'POST'), eq(table.url, promptUrl.toString()), identity)).orderBy(asc(table.id)).get()
    const task = row.taskId ? db.select().from(schema.sysTask).where(eq(schema.sysTask.id, row.taskId)).get() : undefined
    if (original) generationRequest = { id: original.id, method: original.method, url: original.url, createdAt: original.createdAt, prompt: task?.prompt || undefined, source: 'log' }
    else if (task) generationRequest = { source: 'task', prompt: task.prompt, model: task.model, params: parseLoggedJson(task.params) }
  }
  const { requestKey, request, response, ...columns } = row
  return success(c, { ...columns, request: describeLoggedRequest(row), response: parseLoggedJson(response),
    group: { ...group, attempts }, operation: isHistory ? '查询生成进度' : row.provider === 'comfyui' && row.method === 'POST' && params.path.endsWith('/prompt') ? '提交生成工作流' : '',
    requestNote: ['GET', 'HEAD'].includes(row.method) ? '此接口没有请求体，入参位于路径参数和查询参数中。' : '',
    generationRequest: sanitizeCallData(generationRequest),
  })
})
export default app
