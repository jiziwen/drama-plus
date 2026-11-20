import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { db } from '../db/index.js'
import { releaseNotes } from '../db/schema.js'
import { hasReleaseNotesAdminAccess } from '../utils/private-access.js'
import { badRequest, created, now, success } from '../utils/response.js'

const app = new Hono()
const publishSchema = z.object({
  title: z.string().trim().min(1, '请填写更新标题').max(100, '更新标题最多 100 字'),
  changes: z.array(z.string().trim().min(1, '请填写更新内容').max(500, '每条更新内容最多 500 字'))
    .min(1, '请填写至少一条更新内容').max(20, '最多发布 20 条更新内容'),
  requestId: z.uuid('发布请求编号无效').transform(id => id.toLowerCase()),
})
const noteFields = {
  id: releaseNotes.id,
  title: releaseNotes.title,
  changes: releaseNotes.changes,
  publishedAt: releaseNotes.publishedAt,
}

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

app.get('/', c => {
  const items = db.select(noteFields).from(releaseNotes).orderBy(desc(releaseNotes.id)).limit(30).all()
  return success(c, { items })
})

app.get('/access', c => success(c, { canPublish: hasReleaseNotesAdminAccess(c) }))

app.post('/', async (c, next) => {
  const fetchSite = c.req.header('Sec-Fetch-Site')
  if (fetchSite && fetchSite !== 'same-origin') return c.json({ code: 403, message: '请在站内发布版本更新' }, 403)
  if (!hasReleaseNotesAdminAccess(c)) return c.json({ code: 403, message: '仅管理员可以发布版本更新' }, 403)
  if (!/^application\/json\s*(?:;|$)/i.test(c.req.header('Content-Type') || '')) {
    return badRequest(c, '请使用 JSON 发布版本更新')
  }
  await next()
}, bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ code: 413, message: '版本更新内容过长' }, 413) }), async c => {
  const parsed = publishSchema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, parsed.error.issues[0]?.message || '请检查版本更新内容')

  const { requestId, title, changes } = parsed.data
  const result = db.transaction(tx => {
    const existing = tx.select(noteFields).from(releaseNotes).where(eq(releaseNotes.requestId, requestId)).get()
    if (existing) {
      const matches = existing.title === title && existing.changes.length === changes.length &&
        existing.changes.every((change, index) => change === changes[index])
      return { note: matches ? existing : null, inserted: false }
    }
    const note = tx.insert(releaseNotes).values({ requestId, title, changes, publishedAt: now() }).returning(noteFields).get()
    return { note, inserted: true }
  }, { behavior: 'immediate' })

  if (!result.note) return c.json({ code: 409, message: '此发布请求已使用，请重新提交更新说明' }, 409)
  return result.inserted ? created(c, result.note) : success(c, result.note)
})

export default app
