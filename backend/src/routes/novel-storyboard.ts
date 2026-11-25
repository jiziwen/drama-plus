import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { generateImage } from '../services/generation.js'
import {
  createNovelTextRunner, NOVEL_UPLOAD_BYTES, novelAssetImagePrompt, novelAssetKey, novelStoryboardAgent,
  readNovelText, splitNovelChapters, type NovelAssetCandidate,
} from '../services/novel-storyboard-agent.js'
import type { NovelAsset, NovelChapter, NovelCommand, NovelJob, NovelProject, NovelStoryboard } from '../services/novel-storyboard-types.js'
import { projectModelKind, projectModelOptions, projectModelSelection } from '../services/project-model-options.js'
import { safeTaskError } from '../services/video-download.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'

const projects = schema.novelProjects
const chapters = schema.novelChapters
const projectFields = { id: projects.id, title: projects.title, fileName: projects.fileName, updatedAt: projects.updatedAt }
const summaryFields = { number: chapters.number, title: chapters.title, version: chapters.version, segmentCount: chapters.segmentCount }
const chapterNumber = z.number().int().min(1).max(3000)
const leaseMs = 45_000

const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pace'), pace: z.enum(['fast', 'normal']) }),
  z.object({ action: z.literal('selectModel'), kind: projectModelKind, selection: projectModelSelection.nullable() }),
  z.object({ action: z.literal('generate') }),
  z.object({ action: z.literal('assets') }),
  z.object({ action: z.literal('stop'), jobId: z.uuid() }),
  z.object({ action: z.literal('chapter'), chapter: chapterNumber, notes: z.string().trim().max(2000).optional() }),
  z.object({ action: z.literal('image'), assetId: z.uuid(), prompt: z.string().trim().min(1).max(2400) }),
])
const commandRequest = z.object({ revision: z.number().int().positive(), command })

type ProjectRow = typeof projects.$inferSelect
type ChapterRow = typeof chapters.$inferSelect
type ProjectDocument = Pick<NovelProject, 'pace' | 'models' | 'adaptationNotes' | 'assets' | 'assetsCurrent' | 'job'>
type ChapterUpdate = { number: number; changes: Partial<Pick<ChapterRow, 'assets' | 'storyboard' | 'version' | 'segmentCount'>> }

const summaries = (id: string) => db.select(summaryFields).from(chapters)
  .where(eq(chapters.projectId, id)).orderBy(asc(chapters.number)).all()
const chapterRow = (id: string, number: number) => db.select().from(chapters)
  .where(and(eq(chapters.projectId, id), eq(chapters.number, number))).get()
const board = (row?: ChapterRow): NovelStoryboard | undefined => row?.storyboard ? JSON.parse(row.storyboard) : undefined

function save(row: ProjectRow, document: ProjectDocument, options: { owned?: boolean; chapter?: ChapterUpdate } = {}) {
  const updated = {
    ...row,
    document: JSON.stringify(document), revision: row.revision + 1, updatedAt: now(),
    leaseUntil: document.job?.status === 'running' ? Date.now() + leaseMs : 0,
  }
  const saved = db.transaction(tx => {
    const result = tx.update(projects).set(updated).where(and(
      eq(projects.id, row.id), eq(projects.revision, row.revision),
      options.owned ? gt(projects.leaseUntil, Date.now()) : undefined,
    )).run()
    if (!result.changes) return false
    if (options.chapter) {
      tx.update(chapters).set(options.chapter.changes)
        .where(and(eq(chapters.projectId, row.id), eq(chapters.number, options.chapter.number))).run()
    }
    return true
  })
  return saved ? updated : undefined
}

function read(id: string) {
  let row = db.select().from(projects).where(eq(projects.id, id)).get()
  if (!row) return
  let document: ProjectDocument = JSON.parse(row.document)
  if (document.job?.status === 'running' && row.leaseUntil <= Date.now()) {
    const expired = { ...document, job: {
      ...document.job, status: 'failed' as const, error: '后台任务已中断。可以从上次保存的位置继续。',
    } }
    const updated = save(row, expired)
    row = updated ?? db.select().from(projects).where(eq(projects.id, id)).get()
    if (!row) return
    document = updated ? expired : JSON.parse(row.document)
  }
  return { row, document }
}

function withImages(assets: NovelAsset[]): NovelAsset[] {
  const ids = assets.flatMap(asset => asset.taskId ? [asset.taskId] : [])
  if (!ids.length) return assets
  const tasks = new Map<number, { status: string | null; localPath: string | null; resultUrl: string | null; error: string | null }>()
  for (let offset = 0; offset < ids.length; offset += 500) {
    const rows = db.select({ id: schema.sysTask.id, status: schema.sysTask.status,
      localPath: schema.sysTask.localPath, resultUrl: schema.sysTask.resultUrl, error: schema.sysTask.errorMsg,
    }).from(schema.sysTask).where(inArray(schema.sysTask.id, ids.slice(offset, offset + 500))).all()
    for (const row of rows) tasks.set(row.id, row)
  }
  return assets.map(asset => {
    if (!asset.taskId) return asset
    const task = tasks.get(asset.taskId)
    if (task?.status === 'completed' && task.localPath) {
      return { ...asset, imageStatus: 'ready', image: '/' + task.localPath.replace(/^\/+/u, '') }
    }
    if (task?.status === 'pending' || task?.status === 'processing') return { ...asset, imageStatus: 'running' }
    if (task?.status === 'delivery_pending') {
      return { ...asset, imageStatus: 'delivery_pending', imageCanRetryDelivery: !!(task.resultUrl || task.localPath),
        imageError: safeTaskError(task.error || '图片已生成，暂未保存到资产。') }
    }
    return { ...asset, imageStatus: 'failed', imageError: safeTaskError(task?.error || '图片任务没有返回可用文件。') }
  })
}

function view(row: ProjectRow, document: ProjectDocument): NovelProject {
  return {
    id: row.id, title: row.title, fileName: row.fileName, revision: row.revision, updatedAt: row.updatedAt,
    ...document, chapters: summaries(row.id), assets: withImages(document.assets),
  }
}

function addAssets(
  catalog: Map<string, NovelAsset>, previous: Map<string, NovelAsset>, chapter: number, candidates: NovelAssetCandidate[],
) {
  for (const candidate of candidates) {
    const { segments, ...detail } = candidate
    const key = novelAssetKey(detail)
    let asset = catalog.get(key)
    if (!asset) {
      const prior = previous.get(key)
      asset = {
        ...detail, id: prior?.id || randomUUID(), appearances: [],
        taskId: prior?.taskId, prompt: prior?.taskId ? prior.prompt : detail.prompt,
      }
      catalog.set(key, asset)
    }
    const match = asset.appearances.find(item => item.chapter === chapter)
    const unique = [...new Set([...(match?.segments ?? []), ...segments])].sort((a, b) => a - b)
    if (match) match.segments = unique
    else asset.appearances.push({ chapter, segments: unique })
  }
}

export function createNovelStoryboardRoutes(dependencies = { createTextRunner: createNovelTextRunner, generateImage }) {
  const app = new Hono()
  const active = new Map<string, AbortController>()
  const conflict = (c: Parameters<typeof badRequest>[0], message = '项目已更新，请重新读取后再试。') =>
    c.json({ code: 409, message }, 409)

  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  app.get('/', c => success(c, db.select(projectFields).from(projects).orderBy(desc(projects.updatedAt)).all()))
  app.get('/models', c => success(c, projectModelOptions({ imageMode: 'text' })))

  app.post('/', bodyLimit({ maxSize: NOVEL_UPLOAD_BYTES + 65_536,
    onError: c => c.json({ code: 413, message: '小说文件不能超过 8 MB。' }, 413),
  }), async c => {
    const form = await c.req.parseBody().catch(() => null)
    const file = form?.file
    if (!(file instanceof File) || !/\.(txt|md)$/iu.test(file.name)) return badRequest(c, '请上传 TXT 或 Markdown 小说。')
    if (file.size > NOVEL_UPLOAD_BYTES) return badRequest(c, '小说文件不能超过 8 MB。')
    const settings = z.object({
      pace: z.enum(['fast', 'normal']).default('fast'),
      adaptationNotes: z.string().trim().max(2000).optional(),
    }).safeParse(form)
    if (!settings.success) return badRequest(c, '请选择有效节奏，改编要求最多 2000 字。')

    let imported
    try {
      imported = splitNovelChapters(readNovelText(new Uint8Array(await file.arrayBuffer())))
    } catch {
      return badRequest(c, '无法读取小说正文，请检查文件内容与文本编码。')
    }
    if (imported.length > 3000) return badRequest(c, '每个项目最多支持 3000 章。请分卷上传。')
    const fileName = file.name.split(/[/\\]/u).at(-1)!.slice(0, 255)
    const document: ProjectDocument = { ...settings.data, assets: [], assetsCurrent: false }
    const row: ProjectRow = {
      id: randomUUID(), fileName, title: fileName.replace(/\.(txt|md)$/iu, '').trim().slice(0, 100) || '未命名小说',
      document: JSON.stringify(document), revision: 1, leaseUntil: 0, updatedAt: now(),
    }
    db.transaction(tx => {
      tx.insert(projects).values(row).run()
      for (const [index, chapter] of imported.entries()) {
        tx.insert(chapters).values({ ...chapter, projectId: row.id, number: index + 1 }).run()
      }
    })
    return created(c, view(row, document))
  })

  app.get('/:id', c => {
    const project = read(c.req.param('id'))
    return project ? success(c, view(project.row, project.document)) : notFound(c, '小说项目不存在。')
  })

  app.delete('/:id', c => {
    const project = read(c.req.param('id'))
    if (!project) return notFound(c, '小说项目不存在。')
    const { row, document } = project
    if (document.job?.status === 'running') {
      return conflict(c, '项目有正在进行的任务。请先停止任务，或等任务完成后再删除。')
    }
    const removed = db.delete(projects).where(and(eq(projects.id, row.id), eq(projects.revision, row.revision))).run()
    return removed.changes ? success(c, { id: row.id }) : conflict(c)
  })

  app.get('/:id/chapters/:number', c => {
    const number = chapterNumber.safeParse(Number(c.req.param('number')))
    const row = number.success && chapterRow(c.req.param('id'), number.data)
    if (!row) return notFound(c, '章节不存在。')
    const chapter: NovelChapter = {
      number: row.number, title: row.title, source: row.source, version: row.version,
      segmentCount: row.segmentCount, storyboard: board(row),
    }
    return success(c, chapter)
  })

  async function run(
    owner: ProjectRow, doc: ProjectDocument, job: NovelJob,
    action: Extract<NovelCommand, { action: NovelJob['action'] }>,
  ) {
    const controller = new AbortController()
    const { signal } = controller
    active.set(owner.id, controller)

    function commit(patch: Partial<ProjectDocument>, chapter?: ChapterUpdate) {
      signal.throwIfAborted()
      const next = { ...doc, ...patch }
      const updated = save(owner, next, { owned: true, chapter })
      if (!updated) {
        controller.abort()
        signal.throwIfAborted()
      }
      owner = updated!
      doc = next
    }

    function status(phase: string, chapter?: number) {
      job = { ...job, phase, chapter }
      commit({ job })
    }

    const heartbeat = setInterval(() => {
      try {
        const renewed = db.update(projects).set({ leaseUntil: Date.now() + leaseMs }).where(and(
          eq(projects.id, owner.id), eq(projects.revision, owner.revision), gt(projects.leaseUntil, Date.now()),
        )).run()
        if (!renewed.changes) controller.abort()
      } catch (error) {
        controller.abort(error)
      }
    }, leaseMs / 3)
    heartbeat.unref()

    try {
      if (action.action === 'image') {
        const asset = doc.assets.find(item => item.id === action.assetId)!
        const taskId = await dependencies.generateImage({
          prompt: novelAssetImagePrompt(asset, action.prompt), size: '1920x1080', ...doc.models?.image,
        })
        commit({ assets: doc.assets.map(item => item.id === asset.id ? { ...item, prompt: action.prompt, taskId } : item) })
      } else {
        let currentChapter: number | undefined
        const textRunner = await dependencies.createTextRunner(doc.models?.text)
        const agent = novelStoryboardAgent(textRunner, signal, phase => status(phase, currentChapter))
        const entries = summaries(owner.id)

        if (action.action === 'generate' || action.action === 'chapter') {
          const selected = action.action === 'chapter' ? entries.filter(item => item.number === action.chapter) : entries.filter(item => !item.version)
          for (const entry of selected) {
            currentChapter = entry.number
            const chapter = chapterRow(owner.id, entry.number)!
            const previous = chapterRow(owner.id, entry.number - 1)
            const next = chapterRow(owner.id, entry.number + 1)
            const storyboard = await agent.storyboard({
              title: chapter.title, source: chapter.source, pace: doc.pace, version: chapter.version + 1,
              adaptationNotes: doc.adaptationNotes,
              notes: action.action === 'chapter' ? action.notes : undefined,
              previous: board(previous), next: board(next), current: board(chapter),
              previousSource: previous?.source.slice(-900), nextSource: next?.source.slice(0, 900),
            })
            commit({ assetsCurrent: false }, { number: entry.number, changes: {
              version: storyboard.version, storyboard: JSON.stringify(storyboard),
              segmentCount: storyboard.segments.length, assets: null,
            } })
          }
        }

        if (!doc.assetsCurrent && summaries(owner.id).every(chapter => chapter.version > 0)) {
          const previous = new Map(doc.assets.map(asset => [novelAssetKey(asset), asset]))
          const catalog = new Map<string, NovelAsset>()
          const known = new Map(previous)
          for (const entry of entries) {
            currentChapter = entry.number
            const row = chapterRow(owner.id, entry.number)!
            let candidates: NovelAssetCandidate[]
            if (row.assets) {
              candidates = JSON.parse(row.assets)
            } else {
              status('从正式分镜提取资产', entry.number)
              const storyboard = board(row)!
              const names = [...known.values()].map(({ name, kind }) => ({ name, kind }))
              const searchable = JSON.stringify(storyboard).normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
              const relevant = names.filter(({ name }) => searchable.includes(name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')))
              candidates = await agent.assets(entry.title, storyboard, [...relevant, ...names.slice(-160).filter(item => !relevant.includes(item))].slice(0, 500))
              commit({}, { number: entry.number, changes: { assets: JSON.stringify(candidates) } })
            }
            addAssets(catalog, previous, entry.number, candidates)
            for (const candidate of candidates) {
              const key = novelAssetKey(candidate)
              known.set(key, catalog.get(key)!)
            }
          }
          commit({ assets: [...catalog.values()], assetsCurrent: true })
        }
      }
      commit({ job: { ...job, status: 'completed' } })
    } catch (error) {
      if (!signal.aborted) save(owner, { ...doc, job: { ...job, status: 'failed', error: safeTaskError(error) } }, { owned: true })
    } finally {
      clearInterval(heartbeat)
      if (active.get(owner.id) === controller) active.delete(owner.id)
    }
  }

  app.post('/:id/commands', bodyLimit({ maxSize: 32_768 }), async c => {
    const input = commandRequest.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return badRequest(c, '命令或参数无效。')
    const project = read(c.req.param('id'))
    if (!project) return notFound(c, '小说项目不存在。')
    const { row, document } = project
    const cmd = input.data.command
    const job = document.job

    if (cmd.action === 'stop') {
      if (job?.status !== 'running' || job.action === 'image' || job.id !== cmd.jobId) return conflict(c, '当前没有可停止的分镜任务。')
      const next = { ...document, job: { ...job, status: 'stopped' as const } }
      const saved = save(row, next)
      if (!saved) return conflict(c)
      active.get(row.id)?.abort()
      return success(c, view(saved, next))
    }
    if (row.revision !== input.data.revision) return conflict(c)
    if (job?.status === 'running') return conflict(c, '项目已有运行中的任务。')

    if (cmd.action === 'pace') {
      const next = { ...document, pace: cmd.pace }
      const saved = save(row, next)
      return saved ? success(c, view(saved, next)) : conflict(c)
    }
    if (cmd.action === 'selectModel') {
      const { kind, selection } = cmd
      if (selection && !projectModelOptions({ configId: selection.configId, imageMode: 'text' }).some(
        option => option.kind === kind && option.model === selection.model,
      )) return badRequest(c, '所选模型已停用、已移除或不适用于当前任务，请重新选择。')
      const models = { ...document.models }
      if (selection) models[kind] = selection
      else delete models[kind]
      const next = { ...document, models }
      const saved = save(row, next)
      return saved ? success(c, view(saved, next)) : conflict(c)
    }

    const entries = summaries(row.id)
    const firstPending = entries.find(item => !item.version)
    if (cmd.action === 'chapter') {
      const target = entries[cmd.chapter - 1]
      if (!target) return notFound(c, '章节不存在。')
      if (!target.version && firstPending?.number !== target.number) return badRequest(c, '请按章节顺序生成，以继承上一章的尾帧。')
    }
    if (cmd.action === 'assets' && firstPending) return badRequest(c, '全部章节生成后才可提取资产。')
    if (cmd.action === 'generate' && !firstPending && document.assetsCurrent) return conflict(c, '当前章节与资产已全部生成。')
    if (cmd.action === 'assets' && document.assetsCurrent) return conflict(c, '资产清单已是最新版本。')
    if (cmd.action === 'image') {
      const asset = document.assets.find(item => item.id === cmd.assetId)
      if (!document.assetsCurrent || !asset) return badRequest(c, '请先从当前分镜提取资产。')
      if (withImages([asset])[0]?.imageStatus === 'running') return conflict(c, '此资产的图片任务正在处理中。')
    }

    const running: NovelJob = {
      id: randomUUID(), action: cmd.action, status: 'running',
      phase: cmd.action === 'image' ? '提交资产生图任务' : '准备文字模型',
      chapter: cmd.action === 'chapter' ? cmd.chapter : undefined,
    }
    const next = { ...document, job: running }
    const saved = save(row, next)
    if (!saved) return conflict(c)
    void run(saved, next, running, cmd).catch(error => {
      console.error('小说转剧本后台任务无法保存状态', safeTaskError(error))
    })
    return success(c, view(saved, next))
  })
  return app
}
