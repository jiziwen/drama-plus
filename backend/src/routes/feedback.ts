import { and, count, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import sharp from 'sharp'
import { z } from 'zod'
import { db } from '../db/index.js'
import { feedback, feedbackScreenshots, feedbackStatuses } from '../db/schema.js'
import { hasFeedbackAdminAccess, trustedSiteUser } from '../utils/private-access.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'
import { imageThumbnail } from '../utils/storage.js'

const app = new Hono()
const pageSize = 20
const maxScreenshots = 3
const maxScreenshotBytes = 5 * 1024 * 1024
const maxScreenshotPixels = 40_000_000
const multipart = /^multipart\/form-data\s*(?:;|$)/i
const screenshotTypes = new Map([['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']])
const textLimit = bodyLimit({ maxSize: 48 * 1024, onError: c => c.json({ code: 413, message: '反馈内容过长' }, 413) })
const screenshotLimit = bodyLimit({
  maxSize: maxScreenshots * maxScreenshotBytes + 48 * 1024,
  onError: c => c.json({ code: 413, message: '截图最多上传 3 张，每张不超过 5 MB' }, 413),
})
const submitSchema = z.object({
  title: z.string().trim().min(1, '请填写问题标题').max(100, '标题最多 100 字'),
  description: z.string().trim().min(1, '请填写问题描述').max(4000, '描述最多 4000 字'),
  contact: z.string().trim().max(160, '联系方式最多 160 字').default(''),
  pagePath: z.string().max(200).regex(/^\/(?!\/)[^\s?#]*$/).default('/'),
})
const updateSchema = z.object({
  status: z.enum(feedbackStatuses),
  operatorNote: z.string().trim().max(4000, '处理备注最多 4000 字'),
  revision: z.number().int().nonnegative(),
})

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

app.get('/access', c => success(c, { canManage: hasFeedbackAdminAccess(c) }))

app.post('/', async (c, next) => {
  const fetchSite = c.req.header('Sec-Fetch-Site')
  if (fetchSite && fetchSite !== 'same-origin') return c.json({ code: 403, message: '请在站内提交反馈' }, 403)
  if (hasFeedbackAdminAccess(c)) return c.json({ code: 403, message: '管理员可查看和处理反馈' }, 403)
  const contentType = c.req.header('Content-Type') || ''
  if (multipart.test(contentType)) return screenshotLimit(c, next)
  if (/^application\/json\s*(?:;|$)/i.test(contentType)) return textLimit(c, next)
  return badRequest(c, '请从反馈表单提交')
}, async c => {
  const form = multipart.test(c.req.header('Content-Type') || '') ? await c.req.formData().catch(() => null) : undefined
  if (form === null) return badRequest(c, '无法读取反馈表单')
  const parsed = submitSchema.safeParse(form ? Object.fromEntries(form) : await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message || '请检查反馈内容')
  const submittedBy = trustedSiteUser(c)
  const files = form?.getAll('screenshots') ?? []
  if (files.length && !submittedBy) return c.json({ code: 403, message: '请登录后上传截图' }, 403)
  if (files.length > maxScreenshots) return badRequest(c, '截图最多上传 3 张')
  const screenshots: Omit<typeof feedbackScreenshots.$inferInsert, 'feedbackId'>[] = []
  for (const file of files) {
    if (!(file instanceof File) || !file.size) return badRequest(c, '请选择有效的截图文件')
    if (file.size > maxScreenshotBytes) return c.json({ code: 413, message: '每张截图不能超过 5 MB' }, 413)
    const content = Buffer.from(await file.arrayBuffer())
    const metadata = await sharp(content, { limitInputPixels: maxScreenshotPixels }).metadata().catch(() => undefined)
    const mimeType = screenshotTypes.get(metadata?.format ?? '')
    if (!mimeType || !metadata?.width || !metadata.height || metadata.width * metadata.height > maxScreenshotPixels || (metadata.pages ?? 1) > 1) {
      return badRequest(c, '请上传有效的 PNG、JPEG 或 WebP 截图')
    }
    screenshots.push({ position: screenshots.length + 1, mimeType, content })
  }

  const timestamp = now()
  const entry = db.transaction(tx => {
    const entry = tx.insert(feedback).values({
      ...parsed.data,
      submittedBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).returning({ id: feedback.id }).get()
    if (screenshots.length) tx.insert(feedbackScreenshots).values(screenshots.map(image => ({ ...image, feedbackId: entry.id }))).run()
    return entry
  })
  return created(c, entry)
})

app.get('/:id/screenshots/:position', async c => {
  const id = Number(c.req.param('id'))
  const position = Number(c.req.param('position'))
  const submittedBy = trustedSiteUser(c)
  const canManage = hasFeedbackAdminAccess(c)
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(position) || position < 1 || (!canManage && !submittedBy)) {
    return notFound(c, '截图不存在')
  }
  const screenshot = db.select({ mimeType: feedbackScreenshots.mimeType, content: feedbackScreenshots.content })
    .from(feedbackScreenshots).innerJoin(feedback, eq(feedback.id, feedbackScreenshots.feedbackId))
    .where(and(eq(feedbackScreenshots.feedbackId, id), eq(feedbackScreenshots.position, position),
      canManage ? undefined : eq(feedback.submittedBy, submittedBy))).get()
  if (!screenshot) return notFound(c, '截图不存在')
  if (c.req.query('thumbnail') === '1') {
    const thumbnail = await imageThumbnail(screenshot.content).toBuffer().catch(() => null)
    if (!thumbnail) return notFound(c, '截图缩略图暂不可用')
    return c.body(new Uint8Array(thumbnail), 200, {
      'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
    })
  }
  return c.body(new Uint8Array(screenshot.content), 200, {
    'Content-Type': screenshot.mimeType,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  })
})

app.use('/manage/*', async (c, next) => {
  if (!hasFeedbackAdminAccess(c)) return c.json({ code: 403, message: '仅反馈管理员可以查看或处理反馈' }, 403)
  await next()
})

app.get('/manage', async c => {
  const status = c.req.query('status')
  const page = Number(c.req.query('page') || '1')
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) return badRequest(c, '页码无效')
  const parsedStatus = z.enum(feedbackStatuses).safeParse(status)
  if (status && !parsedStatus.success) return badRequest(c, '反馈状态无效')
  const where = parsedStatus.success ? eq(feedback.status, parsedStatus.data) : undefined
  const result = db.transaction(tx => {
    const items = tx.select().from(feedback).where(where).orderBy(desc(feedback.id)).limit(pageSize).offset((page - 1) * pageSize).all()
    const total = tx.select({ value: count() }).from(feedback).where(where).get()?.value ?? 0
    const grouped = items.length ? tx.select({ id: feedbackScreenshots.feedbackId, value: count() }).from(feedbackScreenshots)
      .where(inArray(feedbackScreenshots.feedbackId, items.map(item => item.id))).groupBy(feedbackScreenshots.feedbackId).all() : []
    const counts = new Map(grouped.map(entry => [entry.id, entry.value]))
    return { items: items.map(item => ({ ...item, screenshotCount: counts.get(item.id) ?? 0 })), total, pageSize }
  })
  return success(c, result)
})

app.put('/manage/:id', textLimit, async c => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id < 1) return notFound(c, '反馈不存在')
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message || '请检查处理内容')

  const { status, operatorNote, revision } = parsed.data
  const result = db.transaction(tx => {
    const entry = tx.select().from(feedback).where(eq(feedback.id, id)).get()
    if (!entry) return { entry: null, conflict: false }
    if (entry.status === status && entry.operatorNote === operatorNote) return { entry, conflict: false }
    const updated = tx.update(feedback).set({ status, operatorNote, revision: revision + 1, updatedAt: now() })
      .where(and(eq(feedback.id, id), eq(feedback.revision, revision))).returning().get()
    return { entry: updated, conflict: !updated }
  }, { behavior: 'immediate' })
  if (result.conflict) return c.json({ code: 409, message: '这条反馈已有新的处理记录，请刷新后再保存' }, 409)
  if (!result.entry) return notFound(c, '反馈不存在')
  const screenshotCount = db.select({ value: count() }).from(feedbackScreenshots).where(eq(feedbackScreenshots.feedbackId, id)).get()?.value ?? 0
  return success(c, { ...result.entry, screenshotCount })
})

export default app
