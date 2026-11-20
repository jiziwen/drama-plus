import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import 'dotenv/config'
import { scriptVideoPromptStylePrefix, isScriptVideoStylePreset, type ScriptVideoStylePreset } from './script-video-style.js'
import { annotateScriptVideoAssets, type MentionAsset } from './script-video-mentions.js'
import { annotateScriptVideoInnerOs } from './script-video-inner-os.js'
import { hasScriptVideoShotHeadings } from './script-video-asset-scope.js'
import { replaceScriptVideoPromptStyle } from './script-video-format.js'
import { getScriptVideoOutlineDurationIssues } from './script-video-types.js'
import { getScriptVideoVoiceInputs, scriptVideoVoiceSource, type ScriptVideoDeliveryAsset, type ScriptVideoDeliveryCard } from './script-video-delivery.js'
import type { ScriptVideoStoryboardCheckpoint, ScriptVideoStoryboardProgress } from './script-video-ai.js'
import type { LightingCheck } from './script-video-lighting.js'
import type { ScriptVideoReferenceNames } from './script-video-generation.js'
import { isScriptVideoGenerationDuration } from './script-video-capabilities.js'

export const OUTLINE_DURATION_POLICY = '30-except-tail-v1' as const

export type ScriptVideoJob = {
  id: string
  projectId: string
  episodeId: string
  action: 'outline' | 'storyboard' | 'revisions' | 'review' | 'video'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  createdAt: string
  updatedAt: string
  result?: unknown
  error?: string
  code?: string
  issues?: { code: string; message: string }[]
  cardId?: string
  cardVersion?: number
  taskId?: number
  baseDigest?: string
  videoDigestVersion?: 2 | 3 | 4 | 5 | 6
  videoModel?: string
  videoProvider?: string
  videoDuration?: number
  staleResult?: boolean
  lightingChecks?: LightingCheck[]
  videoReferenceNames?: ScriptVideoReferenceNames
  progress?: ScriptVideoStoryboardProgress
  /** Server-owned resume data; stripped from public job responses. */
  checkpoint?: ScriptVideoStoryboardCheckpoint
  resumeKey?: string
}
export function publicScriptVideoJob(job: ScriptVideoJob): ScriptVideoJob {
  const { checkpoint: _checkpoint, resumeKey: _resumeKey, lightingChecks: _lightingChecks, videoReferenceNames: _videoReferenceNames, ...visible } = job
  return visible
}
export type ScriptVideoProject = {
  id: string
  title: string
  revision: number
  assets: any[]
  episodes: any[]
  episodeId: string
  [key: string]: any
}
type RecordFile = { project: ScriptVideoProject; jobs: ScriptVideoJob[] }
type EpisodeLease = { session: string; expiresAt: number }
const EPISODE_LEASE_MS = 30_000

export function scriptVideoSession(value: string | undefined): string | null {
  if (!value) return null
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new ScriptVideoStoreError('制作会话无效，请重新打开页面', 400, 'INVALID_SESSION')
  return value.toLowerCase()
}

export class ScriptVideoStoreError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'INVALID',
  ) {
    super(message)
  }
}
export function assertOutlineDurationPolicy(cards: Array<{ duration: number }>) {
  const issues = getScriptVideoOutlineDurationIssues(cards)
  if (issues.length) throw new ScriptVideoStoreError(issues.map(issue => issue.message).join('；') + '。请重新编排大纲，保持剧情自然衔接。', 422, 'OUTLINE_DURATION')
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id)
function assertId(id: unknown) {
  if (!validId(id)) throw new ScriptVideoStoreError('无效的标识')
}
const styleKeys = ['id', 'name', 'prefix'] as const
function validStyle(value: unknown): value is ScriptVideoStylePreset {
  if (!isScriptVideoStylePreset(value)) return false
  if (Object.keys(value).length !== styleKeys.length || Object.keys(value).some(key => !styleKeys.includes(key as typeof styleKeys[number]))) return false
  return value.id.length <= 64 && value.name.length <= 100 && value.prefix.length > 0 && value.prefix.length <= 20000
}
function validateAsset(asset: any) {
  if (
    !asset ||
    typeof asset !== 'object' ||
    !validId(asset.id) ||
    typeof asset.name !== 'string' ||
    !asset.name.trim() ||
    !['character', 'scene', 'prop', 'creature'].includes(asset.kind)
  )
    throw new ScriptVideoStoreError('资产信息无效')
  if (asset.voiceMode !== undefined && (asset.kind !== 'character' || !['model', 'reference'].includes(asset.voiceMode))) {
    throw new ScriptVideoStoreError('角色配音设置无效')
  }
  if (asset.voiceAudio !== undefined) {
    const voice = asset.voiceAudio
    if (asset.kind !== 'character' || !voice || typeof voice !== 'object' || Array.isArray(voice) || Object.keys(voice).some(key => !['url', 'name', 'mimeType', 'duration'].includes(key)) || typeof voice.url !== 'string' || !/^\/static\/uploads\/[a-z0-9_-]+\.(?:mp3|wav|m4a|aac)$/iu.test(voice.url) || typeof voice.name !== 'string' || !voice.name.trim() || voice.name.length > 255 || (voice.mimeType !== undefined && (typeof voice.mimeType !== 'string' || voice.mimeType.length > 100 || !/^audio\/[a-z0-9.+-]+$/iu.test(voice.mimeType))) || (voice.duration !== undefined && (typeof voice.duration !== 'number' || !Number.isFinite(voice.duration) || voice.duration <= 0 || voice.duration > 86400))) {
      throw new ScriptVideoStoreError('角色参考音频信息无效，请重新上传音频')
    }
  }
  if (
    typeof asset.image !== 'string' ||
    !asset.image.startsWith('/static/') ||
    /[?#\\]/.test(asset.image)
  )
    throw new ScriptVideoStoreError('资产图片必须先上传并使用本地静态文件地址')
  try {
    const decoded = decodeURIComponent(asset.image)
    if (
      decoded.includes('\\') ||
      decoded
        .split('/')
        .some((segment: string) => segment === '..' || segment === '.')
    )
      throw new Error()
  } catch {
    throw new ScriptVideoStoreError('资产图片地址无效')
  }
}
function withoutCardMetadata(card: any) {
  const { status, version, videoUrl, promptNeedsSync, ...rest } = card
  return rest
}

function episodeContent(episode: any) {
  const { busy, selectedCardId, tasks, generationsHistory, cards, ...fields } = episode
  return {
    ...fields,
    cards: cards.map((card: any) => ({ ...withoutCardMetadata(card), promptNeedsSync: !!card.promptNeedsSync })),
  }
}

function sharedProjectContent(project: ScriptVideoProject) {
  const { revision, episodes, episodeId, ...shared } = project
  return shared
}

function sameJson(a: unknown, b: unknown) {
  // Compare what can be persisted, without treating object key order or undefined fields as edits.
  return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
}

function withoutShotReferences(shots: unknown) {
  if (!Array.isArray(shots)) return shots
  return shots.map(shot => {
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) return shot
    const { visualAssetIds, speakerAssetIds, ...content } = shot
    return content
  })
}

export function scriptVideoVisualAssetInput(asset: ScriptVideoDeliveryAsset | undefined) {
  if (asset) return [asset.id, asset.name, asset.kind, asset.image, asset.originalName, asset.sourcePath]
}

export function scriptVideoReferencedAssetIds(card: Partial<ScriptVideoDeliveryCard> | undefined) {
  if (!card) return []
  const ids = (value?: readonly string[]) => Array.isArray(value) ? value : []
  return [
    ...ids(card.assetIds),
    ...ids(card.openingAssetIds),
    ...(Array.isArray(card.shots) ? card.shots.flatMap(shot =>
      [...ids(shot?.visualAssetIds), ...ids(shot?.speakerAssetIds)]) : []),
  ]
}

function changedVisualAssetIds(before: ScriptVideoDeliveryAsset[], after: ScriptVideoDeliveryAsset[]) {
  const oldAssets = new Map(before.map(asset => [asset.id, scriptVideoVisualAssetInput(asset)]))
  const newAssets = new Map(after.map(asset => [asset.id, scriptVideoVisualAssetInput(asset)]))
  return new Set([...new Set([...oldAssets.keys(), ...newAssets.keys()])]
    .filter(id => !isDeepStrictEqual(oldAssets.get(id), newAssets.get(id))))
}

function changedVoiceAssetIds(before: ScriptVideoDeliveryAsset[], after: ScriptVideoDeliveryAsset[]) {
  const previousAudio = new Map(before.map(asset => [asset.id, scriptVideoVoiceSource(asset)]))
  return after.filter(asset => previousAudio.has(asset.id) && previousAudio.get(asset.id) !== scriptVideoVoiceSource(asset)).map(asset => asset.id)
}
// A stored, edited prompt is authoritative. Add identity markers in place so
// opening a legacy project never regenerates its shots or overwrites revisions.
function cardReferences(card: any, assets: MentionAsset[], production: any, style?: ScriptVideoStylePreset) {
  if (!Array.isArray(card.assetIds) || typeof card.prompt !== 'string' || !card.prompt.trim()) return card
  const protectedPrefix = style && scriptVideoPromptStylePrefix(style)
  const prompt = annotateScriptVideoInnerOs(card.prompt, {
    protectedPrefix,
    speakers: [...assets.filter(asset => asset.kind === 'character').map(asset => asset.name),
      ...(production?.characters?.map((role: { name: string }) => role.name) ?? [])],
  })
  if (!assets.length) return { ...card, prompt }
  const result = annotateScriptVideoAssets(prompt, assets, card.assetIds, {
    characters: card.characters, cast: production?.characters, excludedIds: card.excludedAssetIds,
    protectedPrefix, autoBind: true,
  })
  const implicit = result.mentions.filter(mention => !mention.explicit && mention.usage !== 'context').map(mention => mention.id)
  const used = new Set(result.assetIds)
  const contextual = new Set(result.contextAssetIds)
  const assigned = hasScriptVideoShotHeadings(prompt)
    ? card.assetIds
    : card.assetIds.filter((id: string) => !contextual.has(id) || used.has(id))
  return { ...card, prompt: result.text, assetIds: [...new Set([...assigned, ...implicit])] }
}

function sanitizeProject(
  input: any,
  previous?: ScriptVideoProject,
): ScriptVideoProject {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new ScriptVideoStoreError('项目数据无效')
  assertId(input.id)
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    !Array.isArray(input.assets) ||
    !Array.isArray(input.episodes)
  )
    throw new ScriptVideoStoreError('项目字段无效')
  if (input.settings !== undefined && (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings))) throw new ScriptVideoStoreError('项目设置无效')
  const settings = { ...(previous?.settings || {}), ...(input.settings || {}) }
  if (settings.stylePreset !== undefined && !validStyle(settings.stylePreset)) throw new ScriptVideoStoreError('风格预设无效，请检查名称、字段或长度')
  const assetIds = new Set<string>()
  for (const asset of input.assets) {
    validateAsset(asset)
    if (assetIds.has(asset.id)) throw new ScriptVideoStoreError('资产标识重复')
    assetIds.add(asset.id)
  }
  const episodes = new Set<string>()
  const assets = input.assets as ScriptVideoDeliveryAsset[]
  const changedAssets = changedVisualAssetIds(previous?.assets || [], assets)
  const changedVoices = previous ? changedVoiceAssetIds(previous.assets, assets) : []
  const sanitizedEpisodes = input.episodes.map((episode: any) => {
    if (
      !episode ||
      typeof episode !== 'object' ||
      !validId(episode.id) ||
      episodes.has(episode.id) ||
      !Array.isArray(episode.cards) ||
      typeof episode.script !== 'string' ||
      typeof episode.confirmedScript !== 'string'
    )
      throw new ScriptVideoStoreError('分集数据无效')
    episodes.add(episode.id)
    if (episode.production?.stylePreset !== undefined && !validStyle(episode.production.stylePreset)) throw new ScriptVideoStoreError('制作规格中的风格预设无效')
    const old = previous?.episodes.find((item) => item.id === episode.id)
    const incomingNotes = episode.characterAppearanceNotes
    if (incomingNotes !== undefined && (typeof incomingNotes !== 'string' || incomingNotes.length > 1500))
      throw new ScriptVideoStoreError('本集角色造型备注须为 1500 字以内的文本')
    const characterAppearanceNotes = incomingNotes === undefined
      ? old?.characterAppearanceNotes
      : incomingNotes.trim()
    const outlineDurationPolicy = old?.outlineDurationPolicy
    if (outlineDurationPolicy === OUTLINE_DURATION_POLICY && !old?.outlineConfirmed && episode.outlineConfirmed)
      assertOutlineDurationPolicy(episode.cards)
    const production = episode.production ?? old?.production
    const style = production?.stylePreset || settings.stylePreset
    const previousStyle = old?.production?.stylePreset || previous?.settings?.stylePreset
    const ids = new Set<string>()
    const cards = episode.cards.map((card: any) => {
      if (
        !card ||
        typeof card !== 'object' ||
        !validId(card.id) ||
        ids.has(card.id)
      )
        throw new ScriptVideoStoreError('分镜标识无效或重复')
      ids.add(card.id)
      if (card.excludedAssetIds !== undefined &&
          (!Array.isArray(card.excludedAssetIds) || !card.excludedAssetIds.every(validId))) {
        throw new ScriptVideoStoreError('分镜的已移除参考素材标识无效')
      }
      if (card.stylePreset !== undefined && !validStyle(card.stylePreset)) throw new ScriptVideoStoreError('分镜的风格预设无效')
      const prior = old?.cards?.find((item: any) => item.id === card.id)
      const normalizedPrompt = style && typeof card.prompt === 'string' && card.prompt.trim()
        ? replaceScriptVideoPromptStyle(card.prompt, style, previousStyle, production)
        : card.prompt
      const normalizedPriorPrompt = style && typeof prior?.prompt === 'string' && prior.prompt.trim()
        ? replaceScriptVideoPromptStyle(prior.prompt, style, previousStyle, production)
        : prior?.prompt
      // Only a new card added to an existing video-production episode can use
      // a free-form prompt. A snapshot edit cannot change a saved card's origin.
      const { manuallyAdded, ...cardContent } = card
      const manual = prior?.manuallyAdded === true || !prior && manuallyAdded === true &&
        old?.outlineConfirmed === true && (old.stage === 'production' || episode.stage === 'production' || !!old.production)
      const annotated = cardReferences({ ...cardContent, ...(manual && { manuallyAdded: true }), prompt: normalizedPrompt }, input.assets, production, style)
      const shotsChanged = prior && !sameJson(
        { shots: withoutShotReferences(prior.shots) },
        { shots: withoutShotReferences(card.shots) },
      )
      const promptChanged = prior && normalizedPriorPrompt !== annotated.prompt
      const promptNeedsSync = !manual && (!!card.promptNeedsSync || (!!prior && !promptChanged && (!!shotsChanged || !!prior.promptNeedsSync)))
      const visualAssetChanged = changedAssets.size > 0 && [prior, annotated].some(card =>
        scriptVideoReferencedAssetIds(card).some(id => changedAssets.has(id)))
      let voiceChanged = false
      // A completed render keeps its inputs. Check the next submission's voice
      // sources only for unfinished cards after a voice setting changes.
      if (prior && previous && !(prior.status === 'ready' && prior.videoUrl) && changedVoices.length > 0) {
        const delivery = { model: episode.modelName, provider: episode.modelProvider, cast: production?.characters, stylePreset: style }
        const before = getScriptVideoVoiceInputs(annotated, previous.assets, delivery)
        const after = getScriptVideoVoiceInputs(annotated, assets, delivery)
        voiceChanged = changedVoices.some(id => before.get(id) !== after.get(id))
      }
      const changed =
        !prior || promptNeedsSync !== !!prior.promptNeedsSync ||
        visualAssetChanged || voiceChanged ||
        !sameJson(withoutCardMetadata(prior), withoutCardMetadata(annotated))
      return {
        ...annotated,
        promptNeedsSync,
        videoUrl: prior?.videoUrl,
        version: prior ? (Number(prior.version) || 0) + (changed ? 1 : 0) : 1,
        status: !prior || changed ? 'draft' : prior.status,
      }
    })
    // The client cannot replace task records. Removing a segment removes its
    // finished tasks from the episode view, while active work must finish first.
    const remainingTasks = (old?.tasks || []).filter((task: { cardId: string; status: string }) => {
      if (ids.has(task.cardId)) return true
      if (task.status === 'processing' && old?.cards.some((card: { id: string }) => card.id === task.cardId)) {
        throw new ScriptVideoStoreError('片段正在生成，请等待完成后再删除。', 409, 'VIDEO_RUNNING')
      }
      return false
    })
    const { production: _incomingProduction, outlineDurationPolicy: _incomingPolicy, characterAppearanceNotes: _incomingNotes,
      videoDurations: incomingDurations, ...episodeFields } = episode
    if (incomingDurations !== undefined && (!incomingDurations || typeof incomingDurations !== 'object' || Array.isArray(incomingDurations)))
      throw new ScriptVideoStoreError('视频生成时长设置无效')
    const videoDurations = Object.entries(incomingDurations ?? old?.videoDurations ?? {}).filter(([cardId, duration]) => ids.has(cardId) && isScriptVideoGenerationDuration(duration))
    return { ...episodeFields, ...(production === undefined ? {} : { production }), ...(outlineDurationPolicy === undefined ? {} : { outlineDurationPolicy }), ...(characterAppearanceNotes ? { characterAppearanceNotes } : {}),
      ...(videoDurations.length ? { videoDurations: Object.fromEntries(videoDurations) } : {}),
      cards, tasks: remainingTasks, generationsHistory: old?.generationsHistory || [], busy: false }
  })
  if (input.episodeId && !episodes.has(input.episodeId))
    throw new ScriptVideoStoreError('当前分集不存在')
  return {
    ...input,
    id: input.id,
    title: input.title,
    settings,
    assets: input.assets,
    episodes: sanitizedEpisodes,
    episodeId: input.episodeId || '',
    revision: previous?.revision || 0,
  }
}
function makeEpisode() {
  const id = `episode-${randomUUID()}`
  return {
    id,
    number: 1,
    title: '未命名分集',
    script: '',
    confirmedScript: '',
    confirmed: false,
    outlineConfirmed: false,
    stage: 'materials',
    cards: [],
    selectedCardId: '',
    tasks: [],
    outlineSummaries: {},
    busy: false,
    modelKey: '',
    modelLabel: '',
    modelMaxDuration: 15,
    aspectRatio: '16:9',
    resolution: '720P',
  }
}
export function defaultScriptVideoStoreDirectory() {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  )
  const dbPath =
    process.env.SQLITE_PATH || path.join(repoRoot, 'data/huobao.sqlite3')
  return path.join(path.dirname(path.resolve(dbPath)), 'script-video/projects')
}
export class ScriptVideoStore {
  private locks = new Map<string, Promise<void>>()
  private episodeLeases = new Map<string, Map<string, EpisodeLease>>()
  private init: Promise<void>
  constructor(public directory = defaultScriptVideoStoreDirectory()) {
    this.init = this.initialize()
  }
  private async initialize() {
    await fs.mkdir(this.directory, { recursive: true })
    // An interrupted process cannot complete its queued/running work after restart.
    for (const entry of await fs.readdir(this.directory)) {
      if (!entry.endsWith('.json') || !validId(entry.slice(0, -5))) continue
      const id = entry.slice(0, -5)
      try {
        const record = await this.readRecord(id)
        let changed = false
        for (const job of record.jobs) {
          if (job.status !== 'queued' && job.status !== 'running') continue
          // Submitted video tasks can still be polled after restart. An interrupted
          // submission without a task ID is ambiguous and must not auto-retry.
          if (job.action === 'video' && job.taskId) continue
          job.status = 'failed'
          job.error =
            job.action === 'video'
              ? '服务重启时未收到提交结果。重新提交可能重复计费。'
              : '服务重启，任务未完成，请重试'
          job.code =
            job.action === 'video' ? 'SUBMISSION_UNKNOWN' : 'INTERRUPTED'
          job.updatedAt = new Date().toISOString()
          if (job.action === 'video') {
            const task = record.project.episodes
              .find((ep) => ep.id === job.episodeId)
              ?.tasks?.find((t: any) => t.id === job.id)
            if (task) {
              task.status = 'failed'
              task.error = job.error
              task.code = job.code
              record.project.revision++
            }
          }
          changed = true
        }
        if (changed) await this.writeRecord(record)
      } catch {
        /* Report malformed project when it is accessed; do not destroy it. */
      }
    }
  }
  private filename(id: string) {
    assertId(id)
    return path.join(this.directory, `${id}.json`)
  }
  private async readRecord(id: string, normalizeCards = true): Promise<RecordFile> {
    try {
      const record = JSON.parse(
        await fs.readFile(this.filename(id), 'utf8'),
      ) as RecordFile
      if (
        !record.project ||
        record.project.id !== id ||
        !Array.isArray(record.jobs)
      )
        throw new Error('invalid record')
      if (!normalizeCards) return record
      // Older snapshots stored the preset's display heading and trailing blank
      // lines in the current prompt. Present its normalized form consistently
      // to reads, jobs and future writes, without touching historical versions.
      const completedJobs = new Map(record.jobs.filter(job =>
        job.action === 'video' && job.status === 'completed' && !job.staleResult && job.taskId,
      ).map(job => [job.id, job]))
      for (const episode of record.project.episodes || []) {
        const style = episode.production?.stylePreset || record.project.settings?.stylePreset
        const completedByCard = new Map<string, { cardVersion: number; videoUrl: string }>()
        for (const task of episode.tasks || []) {
          const job = completedJobs.get(task.id)
          if (job && job.episodeId === episode.id && job.cardId === task.cardId &&
              job.taskId === task.taskId && job.cardVersion === task.cardVersion &&
              Number.isSafeInteger(task.cardVersion) && task.cardVersion > 0 &&
              task.status === 'completed' && !task.staleResult && task.videoUrl) {
            completedByCard.set(task.cardId, task)
          }
        }
        for (const card of episode.cards || []) {
          if (validStyle(style) && typeof card.prompt === 'string' && card.prompt.trim())
            card.prompt = replaceScriptVideoPromptStyle(card.prompt, style, style, episode.production)
          Object.assign(card, cardReferences(card, record.project.assets, episode.production, validStyle(style) ? style : undefined))
          // Older snapshots can retain the result only on the task. Recover a
          // matching render without promoting results from a changed card.
          const completed = completedByCard.get(card.id)
          if (completed && !(card.status === 'ready' && card.videoUrl) && !card.promptNeedsSync && completed.cardVersion === card.version) {
            card.status = 'ready'
            card.videoUrl = completed.videoUrl
          }
        }
      }
      return record
    } catch (error: any) {
      if (error?.code === 'ENOENT')
        throw new ScriptVideoStoreError('项目不存在', 404, 'NOT_FOUND')
      if (error instanceof ScriptVideoStoreError) throw error
      throw new ScriptVideoStoreError('项目数据无法读取', 500, 'CORRUPT')
    }
  }
  private async writeRecord(record: RecordFile) {
    const target = this.filename(record.project.id),
      tmp = `${target}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(record), {
        encoding: 'utf8',
        flag: 'wx',
      })
      await fs.rename(tmp, target)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
  private async exclusive<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertId(id)
    await this.init
    const prior = this.locks.get(id) || Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = prior.catch(() => {}).then(() => gate)
    this.locks.set(id, queued)
    await prior.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(id) === queued) this.locks.delete(id)
    }
  }
  async list(): Promise<ScriptVideoProject[]> {
    await this.init
    const names = (await fs.readdir(this.directory))
      .filter((name) => name.endsWith('.json') && validId(name.slice(0, -5)))
      .sort()
    const projects = await Promise.all(names.map(async (name) => {
      try {
        return await this.get(name.slice(0, -5))
      } catch (error) {
        if (error instanceof ScriptVideoStoreError && error.code === 'NOT_FOUND') return null
        throw error
      }
    }))
    return projects.filter(project => project !== null)
  }
  async create(title: string, stylePreset?: ScriptVideoStylePreset): Promise<ScriptVideoProject> {
    if (typeof title !== 'string' || !title.trim())
      throw new ScriptVideoStoreError('项目名称必填')
    const episode = makeEpisode(),
      id = `project-${randomUUID()}`
    const project = sanitizeProject({
      id,
      title: title.trim(),
      revision: 0,
      assets: [],
      episodes: [episode],
      episodeId: episode.id,
      settings: stylePreset === undefined ? {} : { stylePreset },
    })
    project.revision = 1
    await this.exclusive(id, () => this.writeRecord({ project, jobs: [] }))
    return project
  }
  async get(id: string): Promise<ScriptVideoProject> {
    return this.exclusive(id, async () => (await this.readRecord(id)).project)
  }

  private activeEpisodeLeases(id: string) {
    const leases = this.episodeLeases.get(id) ?? new Map<string, EpisodeLease>()
    const now = Date.now()
    for (const [episodeId, lease] of leases) {
      if (lease.expiresAt <= now) leases.delete(episodeId)
    }
    if (!leases.size) this.episodeLeases.delete(id)
    return leases
  }

  // Call inside exclusive() or a mutate() callback to keep the lease check and write atomic.
  requireEpisodeLease(id: string, episodeId: string, session: string | null) {
    const lease = this.activeEpisodeLeases(id).get(episodeId)
    if (lease && lease.session !== session)
      throw new ScriptVideoStoreError('该分集正在制作中，请稍后再进入', 423, 'EPISODE_LOCKED')
    if (!lease)
      throw new ScriptVideoStoreError('本集制作占用已结束，请重新进入后继续', 423, 'EPISODE_LOCK_REQUIRED')
  }

  private requireNoForeignEpisodeLease(id: string, session?: string | null) {
    if ([...this.activeEpisodeLeases(id).values()].some(lease => lease.session !== session))
      throw new ScriptVideoStoreError('项目有其他分集正在制作，请等制作人员退出后再操作', 423, 'EPISODE_LOCKED')
  }

  async listEpisodeLeases(id: string, session: string | null) {
    return this.exclusive(id, async () => {
      return Object.fromEntries([...this.activeEpisodeLeases(id)]
        .filter(([, lease]) => lease.session !== session)
        .map(([episodeId, { expiresAt }]) => [episodeId, { expiresAt }]))
    })
  }

  async acquireEpisodeLease(id: string, episodeId: string, session: string | null, renew: boolean) {
    assertId(episodeId)
    if (!session) throw new ScriptVideoStoreError('缺少制作会话，请重新打开页面', 400, 'INVALID_SESSION')
    return this.exclusive(id, async () => {
      const leases = this.activeEpisodeLeases(id)
      if (renew || leases.has(episodeId)) {
        this.requireEpisodeLease(id, episodeId, session)
      } else {
        const { project } = await this.readRecord(id)
        if (!project.episodes.some(episode => episode.id === episodeId))
          throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      }
      const expiresAt = Date.now() + EPISODE_LEASE_MS
      leases.set(episodeId, { session, expiresAt })
      this.episodeLeases.set(id, leases)
      return { expiresAt }
    })
  }

  async releaseEpisodeLease(id: string, episodeId: string, session: string | null) {
    assertId(episodeId)
    return this.exclusive(id, async () => {
      const leases = this.activeEpisodeLeases(id)
      if (leases.get(episodeId)?.session === session) leases.delete(episodeId)
      if (!leases.size) this.episodeLeases.delete(id)
    })
  }

  async delete(id: string, session?: string | null): Promise<void> {
    await this.exclusive(id, async () => {
      const { project, jobs } = await this.readRecord(id)
      const activeJob = jobs.some(job => job.status === 'queued' || job.status === 'running')
      const processingVideo = project.episodes.some(episode =>
        episode.tasks?.some((task: { status: string }) => task.status === 'processing'),
      )
      if (activeJob || processingVideo)
        throw new ScriptVideoStoreError('项目还有任务在运行，请等任务结束后再删除', 409, 'PROJECT_BUSY')
      this.requireNoForeignEpisodeLease(id, session)
      await fs.unlink(this.filename(id))
      this.episodeLeases.delete(id)
    })
  }
  async update(
    id: string,
    input: unknown,
    expectedRevision: number,
    session?: string | null,
  ): Promise<ScriptVideoProject> {
    return this.exclusive(id, async () => {
      const record = await this.readRecord(id)
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision !== record.project.revision
      )
        throw new ScriptVideoStoreError(
          '项目已更新，请刷新后重试',
          409,
          'CONFLICT',
        )
      if ((input as any)?.id !== id)
        throw new ScriptVideoStoreError('项目标识不匹配')
      const project = sanitizeProject(input, record.project)
      const leases = this.activeEpisodeLeases(id)
      const sharedChanged = !sameJson(sharedProjectContent(record.project), sharedProjectContent(project))
      if (sharedChanged) this.requireNoForeignEpisodeLease(id, session)
      const projectEpisodes = new Map(project.episodes.map(episode => [episode.id, episode]))
      const hasOwnLease = [...leases.values()].some(lease => lease.session === session)
      for (const prior of record.project.episodes) {
        const next = projectEpisodes.get(prior.id)
        const lease = leases.get(prior.id)
        const ownsEpisode = !!lease && lease.session === session
        if (!next || !sameJson(episodeContent(prior), episodeContent(next))) {
          // Global style and asset changes can rewrite cards across all idle episodes.
          const sharedEdit = sharedChanged && !!next && hasOwnLease
          if (!sharedEdit && (session !== undefined || lease))
            this.requireEpisodeLease(id, prior.id, session ?? null)
        }
        if (next && !ownsEpisode && session !== undefined) next.selectedCardId = prior.selectedCardId
      }
      project.revision = record.project.revision + 1
      record.project = project
      await this.writeRecord(record)
      for (const episodeId of leases.keys()) {
        if (!projectEpisodes.has(episodeId)) leases.delete(episodeId)
      }
      if (!leases.size) this.episodeLeases.delete(id)
      return project
    })
  }
  async updateCharacterVoice(
    id: string, episodeId: string, assetId: string, session: string | null,
    field: 'voiceAudio' | 'voiceMode', expected: unknown, value: unknown,
  ): Promise<ScriptVideoProject> {
    return this.mutate(id, (record) => {
      this.requireEpisodeLease(id, episodeId, session)
      const project = record.project
      const index = project.assets.findIndex(asset => asset.id === assetId)
      const asset = project.assets[index]
      if (!asset || asset.kind !== 'character')
        throw new ScriptVideoStoreError('请选择项目里的角色资产')
      const current = asset[field] ?? null
      if (sameJson(current, value)) return { result: project, recordChanged: false }
      if (!sameJson(current, expected))
        throw new ScriptVideoStoreError('该角色的声音已在其他页面更新，已保留最新设置，请重新操作', 409, 'ASSET_VOICE_CONFLICT')
      const next = { ...asset }
      if (value === null) delete next[field]
      else next[field] = value
      validateAsset(next)
      // Text generation reads whether the role has a voice reference. Keep
      // its inputs stable until the current generation has written its result.
      if (record.jobs.some(job => job.action !== 'video' && (job.status === 'queued' || job.status === 'running')))
        throw new ScriptVideoStoreError('本项目正在 AI 编排，请等当前任务完成后再修改角色声音', 409, 'VOICE_TEXT_JOB_ACTIVE')
      const assets = project.assets.slice()
      assets[index] = next
      record.project = sanitizeProject({ ...project, assets }, project)
      return { result: record.project, documentChanged: true }
    })
  }
  /** Server-only mutation under the project lock. Document changes bump revision;
   * pass recordChanged: false when a conditional mutation found nothing to write. */
  async mutate<T>(
    id: string,
    fn: (record: RecordFile) =>
      { result: T; documentChanged?: boolean; recordChanged?: boolean } | Promise<{ result: T; documentChanged?: boolean; recordChanged?: boolean }>,
  ): Promise<T> {
    return this.exclusive(id, async () => {
      const record = await this.readRecord(id)
      const change = await fn(record)
      if (change.documentChanged) record.project.revision++
      if (change.documentChanged || change.recordChanged !== false) await this.writeRecord(record)
      return change.result
    })
  }
  async getVideoJob(projectId: string, taskId: number): Promise<ScriptVideoJob> {
    return this.exclusive(projectId, async () => {
      const { jobs } = await this.readRecord(projectId, false)
      const job = jobs.find(item => item.action === 'video' && item.taskId === taskId)
      if (!job) throw new ScriptVideoStoreError('任务不属于此项目', 404, 'NOT_FOUND')
      return job
    })
  }
  async listPendingVideoJobs(projectId: string, episodeId?: string) {
    return this.exclusive(projectId, async () => {
      const { project, jobs } = await this.readRecord(projectId, false)
      if (episodeId && !project.episodes.some(episode => episode.id === episodeId))
        throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      return jobs.filter((job): job is ScriptVideoJob & { taskId: number } =>
        job.action === 'video' && typeof job.taskId === 'number' &&
        (!episodeId || job.episodeId === episodeId) && (job.status === 'queued' || job.status === 'running'),
      )
    })
  }
  async listJobs(projectId: string, episodeId?: string): Promise<ScriptVideoJob[]> {
    return this.exclusive(
      projectId,
      async () => (await this.readRecord(projectId, false)).jobs
        .filter(job => !episodeId || job.episodeId === episodeId)
        .map(publicScriptVideoJob),
    )
  }
  async getJob(projectId: string, jobId: string) {
    assertId(jobId)
    return this.exclusive(projectId, async () => {
      const job = (await this.readRecord(projectId, false)).jobs.find(
        (item) => item.id === jobId,
      )
      if (!job) throw new ScriptVideoStoreError('任务不存在', 404, 'NOT_FOUND')
      return publicScriptVideoJob(job)
    })
  }

  async cancelTextJob(projectId: string, jobId: string, session: string | null) {
    assertId(jobId)
    return this.mutate(projectId, record => {
      const job = record.jobs.find(item => item.id === jobId && item.action !== 'video')
      if (!job) throw new ScriptVideoStoreError('文字生成任务不存在', 404, 'NOT_FOUND')
      this.requireEpisodeLease(projectId, job.episodeId, session)
      if (job.status !== 'queued' && job.status !== 'running') {
        return { result: publicScriptVideoJob(job), recordChanged: false }
      }
      job.status = 'canceled'
      job.code = 'CANCELED'
      job.error = '生成已取消，现有内容已保留'
      job.updatedAt = new Date().toISOString()
      delete job.checkpoint
      return { result: publicScriptVideoJob(job) }
    })
  }
}
