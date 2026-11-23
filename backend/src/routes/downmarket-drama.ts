import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { createDramaTextRunner, downmarketDramaAgent, chapterNumber, briefSchema, chapterSchema, openingMode, outlineSchema, revisionNotes } from '../services/downmarket-drama-agent.js'
import { DRAMA_INLINE_REFERENCE_CHARACTERS, DRAMA_REFERENCE_PREVIEW_CHARACTERS, DRAMA_REFERENCE_UPLOAD_BYTES, DRAMA_REFERENCE_UPLOAD_MB } from '../services/downmarket-drama-types.js'
import type { DownmarketDrama, DramaAsset, DramaCommand, DramaJobAction, DramaModelSelection } from '../services/downmarket-drama-types.js'
import { generateImage } from '../services/generation.js'
import { assertImageMode, resolveMediaConfig } from '../services/media-selection.js'
import { projectModelKind, projectModelOptions, projectModelSelection } from '../services/project-model-options.js'
import type { ScriptVideoStore } from '../services/script-video-store.js'
import { safeTaskError } from '../services/video-download.js'
import { decodeTextFile } from '../services/text-file.js'
import { badRequest, created, notFound, now, success } from '../utils/response.js'

const drafts = schema.downmarketDramas
const references = schema.downmarketDramaReferences
const referenceSizeError = `对标文案文件最多 ${DRAMA_REFERENCE_UPLOAD_MB} MB。`
const revisionSchema = z.number().int().positive()
const assetId = z.uuid()
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveBrief'), brief: briefSchema }),
  z.object({ action: z.literal('selectModel'), kind: projectModelKind, selection: projectModelSelection.nullable() }),
  z.object({ action: z.literal('confirmOutline'), outline: outlineSchema }),
  z.object({ action: z.literal('saveChapter'), chapter: chapterNumber, content: chapterSchema }),
  z.object({ action: z.enum(['clearReference', 'discardCandidate', 'finalize', 'stop', 'analyze', 'write', 'logic', 'assets', 'images']) }),
  z.object({ action: z.literal('outline'), pitch: z.number().int().min(0).max(2), notes: revisionNotes }),
  z.object({ action: z.literal('opening'), mode: openingMode, reference: z.string().trim().max(6_000).optional(), notes: revisionNotes }),
  z.object({ action: z.literal('pace'), chapter: z.number().int().min(1).max(3) }),
  z.object({ action: z.literal('revise'), chapter: chapterNumber, source: z.enum(['logic', 'opening', 'pace']), notes: revisionNotes }),
  z.object({
    action: z.literal('image'),
    assetId,
    prompt: z.string().trim().min(1).max(3200),
    reference: z.string().regex(/^\/?static\/uploads\/[\w.-]+\.(?:png|jpe?g|webp)$/iu).optional(),
  }),
  z.object({ action: z.literal('deliver'), allowMissingImages: z.boolean() }),
])
const commandRequest = z.object({ revision: revisionSchema, command: commandSchema })

type Row = typeof drafts.$inferSelect
type ActiveTask = (
  signal: AbortSignal,
  phase: (label: string, partial?: Partial<DownmarketDrama>) => void,
) => Promise<Partial<DownmarketDrama>>
const leaseMs = 30_000
const imageIsRunning = (status?: string | null) => status === 'processing' || status === 'pending'
const withImageStatus = (draft: DownmarketDrama): DownmarketDrama => {
  const ids = draft.assets.flatMap(asset => asset.taskId ? [asset.taskId] : [])
  if (!ids.length) return draft
  const tasks = db.select({
    id: schema.sysTask.id, status: schema.sysTask.status,
    localPath: schema.sysTask.localPath, error: schema.sysTask.errorMsg,
  }).from(schema.sysTask).where(inArray(schema.sysTask.id, ids)).all()
  const byId = new Map(tasks.map(task => [task.id, task]))
  const assets = draft.assets.map((asset): DramaAsset => {
    if (!asset.taskId) return asset
    const task = byId.get(asset.taskId)
    if (task?.status === 'completed' && task.localPath) {
      return { ...asset, imageStatus: 'ready', image: '/' + task.localPath.replace(/^\//u, '') }
    }
    if (imageIsRunning(task?.status)) return { ...asset, imageStatus: 'running' }
    return { ...asset, imageStatus: 'failed', imageError: safeTaskError(task?.error || '图片任务未返回可用文件。') }
  })
  return { ...draft, assets }
}

function serialize(draft: DownmarketDrama) {
  const { id: _id, title: _title, revision: _revision, updatedAt: _updatedAt, ...document } = draft
  return JSON.stringify(document)
}

function write(row: Row, draft: DownmarketDrama, leaseUntil = 0, checkLease = false) {
  const revision = row.revision + 1
  const updatedAt = now()
  const saved = db.update(drafts).set({ document: serialize(draft), revision, updatedAt, leaseUntil })
    .where(and(eq(drafts.id, row.id), eq(drafts.revision, row.revision), checkLease ? eq(drafts.leaseUntil, row.leaseUntil) : undefined)).run()
  return saved.changes ? { ...draft, revision, updatedAt } : undefined
}

function saveReference(row: Row, draft: DownmarketDrama, source = '', file?: File) {
  const external = Boolean(file && source.length > DRAMA_INLINE_REFERENCE_CHARACTERS)
  const referenceFile = external && file ? {
    name: file.name.split(/[/\\]/u).at(-1)!.slice(0, 255), bytes: file.size, characters: source.length,
    preview: source.slice(0, DRAMA_REFERENCE_PREVIEW_CHARACTERS).replace(/[\uD800-\uDBFF]$/u, ''),
  } : undefined
  const next: DownmarketDrama = {
    ...draft, brief: { ...draft.brief, reference: referenceFile ? '' : source.trim() }, referenceFile,
    analysis: undefined, pitches: undefined, selectedPitch: undefined, outline: undefined, job: undefined,
  }
  return db.transaction(tx => {
    const saved = write(row, next)
    if (!saved) return
    if (referenceFile) tx.insert(references).values({ dramaId: row.id, source })
      .onConflictDoUpdate({ target: references.dramaId, set: { source } }).run()
    else tx.delete(references).where(eq(references.dramaId, row.id)).run()
    return saved
  })
}

function readReference(draft: DownmarketDrama) {
  if (!draft.referenceFile) return draft.brief.reference
  const saved = db.select({ source: references.source }).from(references).where(eq(references.dramaId, draft.id)).get()
  if (!saved?.source) throw new Error('无法读取对标文案，请重新导入文件。')
  return saved.source
}

function read(id: string) {
  const row = db.select().from(drafts).where(eq(drafts.id, id)).get()
  if (!row) return
  let draft: DownmarketDrama = {
    ...JSON.parse(row.document), id: row.id, title: row.title, revision: row.revision, updatedAt: row.updatedAt,
  }
  if (draft.job?.status === 'running' && row.leaseUntil <= Date.now()) {
    const interrupted = { ...draft, job: { ...draft.job, status: 'failed' as const, error: '服务中断，本次任务未完成。可以重试当前步骤。' } }
    write(row, interrupted, 0, true)
    return read(id)
  }
  draft = withImageStatus(draft)
  return { row, draft }
}

function assertStep(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const assetKey = (asset: Pick<DramaAsset, 'kind' | 'name'>) => asset.kind + ':' + asset.name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()

function mergeAssets(previous: DramaAsset[], proposed: Omit<DramaAsset, 'id'>[]): DramaAsset[] {
  const existing = new Map(previous.map(asset => [assetKey(asset), asset]))
  const seen = new Set<string>()
  const assets: DramaAsset[] = []
  for (const asset of proposed) {
    const key = assetKey(asset)
    if (seen.has(key)) continue
    seen.add(key)
    const prior = existing.get(key)
    assets.push(prior?.image || prior?.taskId ? prior : { ...asset, id: prior?.id || randomUUID() })
  }
  return assets
}

function imagePrompt(asset: DramaAsset, prompt: string, style: DownmarketDrama['brief']['style'], hasReference: boolean) {
  const medium = style === 'live' ? '电影级仿真真人实拍，保留自然皮肤和物理材质。' : '高质量3D漫剧，统一3D角色和材质渲染。'
  const framing = {
    character: '白色背景人物设定卡。左侧主肖像，中间同一人物正面、左侧、右侧、背面四张完整全身视图，右侧补充表情及服饰细节。所有区域保持同一身份、服装、比例和配色。',
    scene: '固定可拍摄的空间，建立可辨识的布局、光源和入口动线。画面中无人、无其他场景。',
    prop: '纯白背景的单品图。居中完整展示物件轮廓、材质和细节，无人手、无其他物件。',
  }[asset.kind]
  return [medium, '只生成一张16:9横屏图，仅含当前资产「' + asset.name + '」。', framing,
    hasReference ? '参考所给图的当前资产特征，保持身份和关键设计一致。' : '', prompt].filter(Boolean).join('\n')
}

export function createDownmarketDramaRoutes(
  store: Pick<ScriptVideoStore, 'importScriptSnapshot'>,
  dependencies: {
    createTextRunner: typeof createDramaTextRunner
    generateImage: typeof generateImage
    resolveImageConfig: (selection?: DramaModelSelection) => Promise<{ id?: number; model?: string }>
  } = {
    createTextRunner: createDramaTextRunner,
    generateImage,
    resolveImageConfig: async selection => {
      const config = await resolveMediaConfig('image', selection ?? {})
      assertImageMode(config, 'text')
      return config
    },
  },
) {
  const app = new Hono()
  const controllers = new Map<string, AbortController>()
  const projectConflict = (c: Parameters<typeof badRequest>[0]) =>
    c.json({ code: 409, message: '项目已有新进度，请刷新后继续。' }, 409)
  const commandBodyLimit = bodyLimit({ maxSize: 750_000, onError: c => c.json({ code: 413, message: '本次提交内容太长。' }, 413) })
  app.use('*', async (c, next) => {
    await next()
    c.header('Cache-Control', 'no-store')
  })

  app.get('/', c => success(c, db.select({ id: drafts.id, title: drafts.title, revision: drafts.revision, updatedAt: drafts.updatedAt })
    .from(drafts).orderBy(desc(drafts.updatedAt)).all()))

  app.post('/', commandBodyLimit, async c => {
    const input = z.object({ title: z.string().trim().min(1).max(100) }).safeParse(await c.req.json().catch(() => null))
    if (!input.success) return badRequest(c, '请填写100字以内的项目名称。')
    const { title } = input.data
    const id = randomUUID()
    const updatedAt = now()
    const document = {
      brief: { reference: '', direction: '', chapterCount: 15, chapterWords: 2_800, runtimeMinutes: 65, style: 'live', humor: false },
      outlineConfirmed: false, chapters: [], pacing: {}, finalized: false, assets: [], assetsCurrent: false,
    } satisfies Omit<DownmarketDrama, 'id' | 'title' | 'updatedAt' | 'revision'>
    db.insert(drafts).values({ id, title, updatedAt, document: JSON.stringify(document), revision: 1 }).run()
    return created(c, { ...document, id, title, updatedAt, revision: 1 })
  })

  app.get('/models', c => success(c, projectModelOptions()))

  app.put('/:id/reference', bodyLimit({
    maxSize: DRAMA_REFERENCE_UPLOAD_BYTES + 65_536,
    onError: c => c.json({ code: 413, message: referenceSizeError }, 413),
  }), async c => {
    const form = await c.req.parseBody().catch(() => null)
    const file = form?.file
    if (!(file instanceof File) || !/\.(txt|md|markdown)$/iu.test(file.name)) return badRequest(c, '请选择 TXT 或 Markdown 文件。')
    if (file.size > DRAMA_REFERENCE_UPLOAD_BYTES) return c.json({ code: 413, message: referenceSizeError }, 413)
    const revision = revisionSchema.safeParse(Number(form?.revision))
    if (!revision.success) return badRequest(c, '请刷新项目后再导入对标文案。')
    const current = read(c.req.param('id'))
    if (!current) return notFound(c, '下沉剧项目不存在。')
    const { row, draft } = current
    if (row.revision !== revision.data || draft.job?.status === 'running') return projectConflict(c)
    if (draft.outlineConfirmed) return badRequest(c, '大纲确认后已进入写作。')
    let source: string
    try {
      source = decodeTextFile(new Uint8Array(await file.arrayBuffer()))
      if (!source.trim() || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(source)) throw new Error('invalid text file')
    } catch {
      return badRequest(c, '无法读取对标文案，请检查文件是否为空或使用有效的文本编码。')
    }
    const saved = saveReference(row, draft, source, file)
    return saved ? success(c, saved) : projectConflict(c)
  })

  app.get('/:id', c => {
    const current = read(c.req.param('id'))
    return current ? success(c, current.draft) : notFound(c, '下沉剧项目不存在。')
  })
  app.delete('/:id', c => {
    const current = read(c.req.param('id'))
    if (!current) return notFound(c, '下沉剧项目不存在。')
    const { row, draft } = current
    if (draft.job?.status === 'running') {
      return c.json({ code: 409, message: '项目有任务正在运行。请先停止任务，或等任务完成后再删除。' }, 409)
    }
    const removed = db.delete(drafts).where(and(eq(drafts.id, row.id), eq(drafts.revision, row.revision))).run()
    return removed.changes ? success(c, { id: row.id }) : projectConflict(c)
  })
  app.get('/:id/progress', c => {
    const current = read(c.req.param('id'))
    if (!current) return notFound(c, '下沉剧项目不存在。')
    const { draft } = current
    if (draft.revision !== Number(c.req.query('revision'))) return success(c, { draft })
    const images = draft.assets.filter(asset => asset.taskId || asset.imageError).map(({ id, taskId, image, imageStatus, imageError }) => ({
      id, taskId, image, imageStatus, imageError,
    }))
    return success(c, { revision: draft.revision, job: draft.job, images })
  })

  async function queueImage(
    draft: DownmarketDrama, asset: DramaAsset, prompt: string, reference?: string,
    selection: { configId?: number; model?: string } = draft.models?.image ?? {},
  ) {
    const taskId = await dependencies.generateImage({
      prompt: imagePrompt(asset, prompt, draft.brief.style, Boolean(reference)),
      size: '2048x1152',
      requireLandscape16x9: true,
      referenceImages: reference ? [reference] : undefined,
      ...selection,
    })
    return { ...asset, taskId, prompt, imageStatus: undefined, imageError: undefined }
  }

  async function waitForImage(taskId: number, signal: AbortSignal) {
    const deadline = Date.now() + 14 * 60_000
    do {
      signal.throwIfAborted()
      const task = db.select({ status: schema.sysTask.status }).from(schema.sysTask).where(eq(schema.sysTask.id, taskId)).get()
      if (!imageIsRunning(task?.status)) return
      await delay(1600, undefined, { signal })
    } while (Date.now() < deadline)
    throw new Error('当前图片仍在运行，批量生成已暂停。图片完成后可以继续补齐。')
  }

  function prepare(draft: DownmarketDrama, command: DramaCommand): Partial<DownmarketDrama> | ActiveTask {
    const complete = draft.chapters.length === draft.brief.chapterCount
    const agent = async (signal: AbortSignal, phase: (label: string) => void) =>
      downmarketDramaAgent(await dependencies.createTextRunner(draft.models?.text), signal, phase)

    switch (command.action) {
      case 'selectModel': {
        const { kind, selection } = command
        if (selection) assertStep(projectModelOptions({ configId: selection.configId }).some(option =>
          option.kind === kind && option.model === selection.model), '所选模型已停用或已移除，请重新选择。')
        const models = { ...draft.models }
        if (selection) models[kind] = selection
        else delete models[kind]
        return { models }
      }
      case 'saveBrief': {
        assertStep(!draft.outlineConfirmed, '大纲确认后已进入写作。')
        assertStep(draft.referenceFile ? !command.brief.reference : command.brief.reference, '请先保存对标文案。')
        if (JSON.stringify(command.brief) === JSON.stringify(draft.brief)) return {}
        const analysisChanged = command.brief.reference !== draft.brief.reference || command.brief.direction !== draft.brief.direction
        return {
          brief: command.brief, outline: undefined,
          ...(analysisChanged && { analysis: undefined, pitches: undefined, selectedPitch: undefined }),
        }
      }
      case 'analyze':
        assertStep(!draft.outlineConfirmed && (draft.referenceFile || draft.brief.reference) && briefSchema.safeParse(draft.brief).success, '请先保存对标文案和创作规格。')
        return async (signal, phase) => ({
          ...await (await agent(signal, phase)).analyze(draft, readReference(draft)), outline: undefined, selectedPitch: undefined,
        })
      case 'outline':
        assertStep(!draft.outlineConfirmed && draft.pitches?.[command.pitch], '请先选择一条故事切口。')
        return async (signal, phase) => ({
          outline: await (await agent(signal, phase)).outline(draft, command.pitch, command.notes),
          selectedPitch: command.pitch,
        })
      case 'confirmOutline':
        assertStep(!draft.outlineConfirmed && draft.outline && command.outline.chapters.length === draft.brief.chapterCount, '请先生成大纲并检查章数。')
        return { outline: command.outline, outlineConfirmed: true }
      case 'write':
        assertStep(draft.outlineConfirmed && !complete, '请先确认大纲，或检查是否已经写完。')
        return async (signal, phase) => ({ chapters: [...draft.chapters, await (await agent(signal, phase)).write(draft)] })
      case 'saveChapter': {
        const current = draft.chapters[command.chapter - 1]
        assertStep(current && (!draft.candidate || draft.candidate.chapter === command.chapter), '请先处理待确认的修改稿。')
        if (JSON.stringify(current) === JSON.stringify(command.content)) return { candidate: undefined }
        const chapters = draft.chapters.map((chapter, index) => index + 1 === command.chapter ? command.content : chapter)
        const scriptChanged = current.title !== command.content.title || current.text !== command.content.text
        return { chapters, candidate: undefined, ...(scriptChanged && { finalized: false, assetsCurrent: false, delivery: undefined }) }
      }
      case 'logic':
        assertStep(complete, '写完全部章节后可进行全剧逻辑检查。')
        return async (signal, phase) => ({ logic: await (await agent(signal, phase)).logic(draft) })
      case 'opening':
        assertStep(complete, '写完全部章节后可优化第一章开头。')
        return async (signal, phase) => ({
          opening: { mode: command.mode, ...await (await agent(signal, phase)).opening(draft, command.mode, command.reference, command.notes) },
        })
      case 'pace':
        assertStep(complete && draft.chapters[command.chapter - 1], '只分析已经写完的前三章。')
        return async (signal, phase) => ({
          pacing: { ...draft.pacing, [command.chapter]: await (await agent(signal, phase)).pace(draft, command.chapter) },
        })
      case 'revise': {
        assertStep(complete && !draft.candidate && draft.chapters[command.chapter - 1], '请先写完全剧并处理已有修改稿。')
        const plan = command.source === 'logic' ? draft.logic?.issues.filter(issue => issue.chapter === command.chapter)
          : command.source === 'pace' ? draft.pacing[command.chapter]?.plan
          : command.chapter === 1 && draft.opening && command.notes
        assertStep(plan && (!Array.isArray(plan) || plan.length), '请先生成对应方案。采用开头时需确认开头正文。')
        const approvedChanges = command.source === 'opening' ? { openingText: plan, mode: draft.opening!.mode }
          : { plan, notes: command.notes }
        return async (signal, phase) => ({
          candidate: { chapter: command.chapter, content: await (await agent(signal, phase)).revise(draft, command.chapter, approvedChanges) },
        })
      }
      case 'discardCandidate':
        assertStep(draft.candidate, '当前没有修改稿。')
        return { candidate: undefined }
      case 'finalize':
        assertStep(complete && !draft.candidate, '全部章节写完且修改稿处理完才能定稿。')
        return { finalized: true }
      case 'assets':
        assertStep(draft.finalized && !draft.candidate, '请先处理修改稿并确认剧本定稿。')
        assertStep(!draft.assets.some(asset => asset.imageStatus === 'running'), '请等待当前图片任务完成后再更新资产清单。')
        return async (signal, phase) => ({
          assets: mergeAssets(draft.assets, (await (await agent(signal, phase)).assets(draft)).assets),
          assetsCurrent: true,
          delivery: undefined,
        })
      case 'image': {
        const asset = draft.assets.find(item => item.id === command.assetId)
        assertStep(draft.finalized && !draft.candidate && draft.assetsCurrent && asset, '请先根据当前定稿提取资产。')
        assertStep(asset.imageStatus !== 'running', '此资产正在生成图片。')
        return async (signal, phase) => {
          phase('提交「' + asset.name + '」的单张图片')
          signal.throwIfAborted()
          const queued = await queueImage(draft, asset, command.prompt, command.reference)
          return { assets: draft.assets.map(item => item.id === asset.id ? queued : item), delivery: undefined }
        }
      }
      case 'images': {
        assertStep(draft.finalized && !draft.candidate && draft.assetsCurrent, '请先根据当前定稿提取资产。')
        assertStep(!draft.assets.some(asset => asset.imageStatus === 'running'), '请等待当前图片任务完成。')
        const pending = draft.assets.filter(asset => !asset.image)
        assertStep(pending.length, '当前资产均已出图。')
        return async (signal, phase) => {
          const config = await dependencies.resolveImageConfig(draft.models?.image)
          const assets = new Map(draft.assets.map(asset => [asset.id, asset]))
          for (const [index, asset] of pending.entries()) {
            const label = `批量出图 ${index + 1}/${pending.length} · ${asset.name}`
            signal.throwIfAborted()
            phase(label)
            try {
              assets.set(asset.id, await queueImage(draft, asset, asset.prompt, undefined, { configId: config.id, model: config.model }))
            } catch (error) {
              assets.set(asset.id, { ...asset, taskId: undefined, imageStatus: 'failed', imageError: safeTaskError(error) })
            }
            phase(label, { assets: [...assets.values()], delivery: undefined })
            const taskId = assets.get(asset.id)?.taskId
            if (taskId) await waitForImage(taskId, signal)
          }
          return {}
        }
      }
      case 'deliver': {
        assertStep(draft.finalized && !draft.candidate && draft.assetsCurrent, '请先确认定稿并提取资产。')
        assertStep(!draft.assets.some(asset => asset.imageStatus === 'running'), '请等待正在生成的图片，完成后再移交分镜。')
        assertStep(command.allowMissingImages || draft.assets.every(asset => asset.image), '还有资产缺图，请先完成生图或确认带缺图移交。')
        const title = draft.outline?.title || draft.title
        const episodes = draft.chapters.map(({ title, text }) => ({ title, script: text }))
        const assets = draft.assets.flatMap(({ id, kind, name, image }) => image ? [{ id, kind, name, image }] : [])
        const stylePreset = draft.brief.style === 'live'
          ? { id: 'custom' as const, name: '仿真人短剧', prefix: '16:9电影级仿真人实拍。锁定角色面貌、服装、场景空间与物件；顺接动作、台词和情绪。对白及物理音效按剧本保留。' }
          : { id: 'custom' as const, name: '3D漫剧', prefix: '16:9电影级3D漫剧。统一角色建模、服装、材质、灯光和道具；顺接动作、台词和情绪。对白及物理音效按剧本保留。' }
        const snapshot = { title, episodes, assets, stylePreset }
        const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 24)
        return async (signal, phase) => {
          phase('将剧本与已完成的图片导入剧本转视频')
          signal.throwIfAborted()
          const project = await store.importScriptSnapshot('dm-' + draft.id + '-' + fingerprint, snapshot)
          return { delivery: { projectId: project.id, episodeId: project.episodes[0]?.id || '' } }
        }
      }
      case 'clearReference':
      case 'stop': return {}
    }
  }

  function start(row: Row, draft: DownmarketDrama, action: DramaJobAction, task: ActiveTask) {
    const job = { id: randomUUID(), action, status: 'running' as const, phase: '准备任务' }
    const started = write(row, { ...draft, job }, Date.now() + leaseMs)
    if (!started) return
    const controller = new AbortController()
    controllers.set(draft.id, controller)
    const target = and(eq(drafts.id, row.id), eq(drafts.revision, started.revision))
    let working = started
    let phaseLabel = job.phase
    const heartbeat = setInterval(() => {
      if (!db.update(drafts).set({ leaseUntil: Date.now() + leaseMs }).where(target).run().changes) controller.abort()
    }, leaseMs / 3)
    heartbeat.unref()
    const { signal } = controller
    const phase = (label: string, partial?: Partial<DownmarketDrama>) => {
      // Record an image that was already submitted even when the next batch step was just stopped.
      if (!partial) signal.throwIfAborted()
      phaseLabel = label
      working = { ...working, ...partial, job: { ...job, phase: label } }
      if (!db.update(drafts).set({ document: serialize(working), leaseUntil: Date.now() + leaseMs }).where(target).run().changes)
        controller.abort()
    }
    void Promise.resolve().then(() => task(signal, phase)).then(update => {
      write({ ...row, revision: started.revision }, { ...working, ...update, job: { ...job, phase: phaseLabel, status: 'done' } })
    }).catch(error => {
      const message = safeTaskError(error)
      write({ ...row, revision: started.revision }, { ...working, job: { ...job, phase: phaseLabel, status: 'failed', error: message } })
    }).finally(() => {
      clearInterval(heartbeat)
      if (controllers.get(draft.id) === controller) controllers.delete(draft.id)
    })
    return started
  }

  app.post('/:id/commands', commandBodyLimit, async c => {
    const input = commandRequest.safeParse(await c.req.json().catch(() => null))
    if (!input.success) return badRequest(c, '请检查填写内容、字数与章数后再试。')
    const current = read(c.req.param('id'))
    if (!current) return notFound(c, '下沉剧项目不存在。')
    const { row, draft } = current
    const { revision, command } = input.data
    const conflict = () => projectConflict(c)
    if (revision !== row.revision) return conflict()
    if (command.action === 'stop') {
      if (draft.job?.status !== 'running') return success(c, draft)
      if (['image', 'deliver'].includes(draft.job.action)) return badRequest(c, '提交中的图片和制作项目暂时不能停止。')
      if (draft.job.action === 'images') {
        const controller = controllers.get(draft.id)
        if (!controller) return badRequest(c, '当前服务正在恢复任务状态，请稍后再试。')
        controller.abort(new Error('已停止后续批量出图，已提交的图片会继续生成。'))
        return success(c, draft)
      }
      const stopped = write(row, { ...draft, job: { ...draft.job, status: 'failed', error: '已停止本次任务。' } })
      if (!stopped) return conflict()
      controllers.get(draft.id)?.abort()
      return success(c, stopped)
    }
    if (draft.job?.status === 'running') return c.json({ code: 409, message: '此项目有任务正在运行。' }, 409)
    if (command.action === 'clearReference') {
      if (draft.outlineConfirmed) return badRequest(c, '大纲确认后已进入写作。')
      const saved = saveReference(row, draft)
      return saved ? success(c, saved) : conflict()
    }
    let update
    try { update = prepare(draft, command) }
    catch (error) { return badRequest(c, safeTaskError(error)) }
    const saved = typeof update === 'function'
      ? start(row, draft, command.action as DramaJobAction, update)
      : write(row, { ...draft, ...update, job: undefined })
    return saved ? success(c, withImageStatus(saved)) : conflict()
  })
  return app
}
