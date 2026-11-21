import { randomUUID } from 'node:crypto'
import { ScriptVideoDatabase, type ScriptVideoRecord, type ProjectRow } from './script-video-database.js'
import { ScriptVideoQueue } from './script-video-queue.js'
import { ScriptVideoMediaRetention } from './script-video-media-retention.js'
import { applyScriptVideoChanges, validateScriptVideoChanges, type ScriptVideoChange } from './script-video-sync.js'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import 'dotenv/config'
import { scriptVideoPromptStylePrefix, isScriptVideoStylePreset, styleVisualSpecs, type ScriptVideoStylePreset } from './script-video-style.js'
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
import { listScriptVideoVersions } from './script-video-versions.js'

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
  ownerSession?: string
  requestId?: string
  taskId?: number
  baseDigest?: string
  videoDigestVersion?: 2 | 3 | 4 | 5 | 6 | 7
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
  const { ownerSession: _ownerSession, requestId: _requestId, checkpoint: _checkpoint, resumeKey: _resumeKey, lightingChecks: _lightingChecks, videoReferenceNames: _videoReferenceNames, ...visible } = job
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
type RecordFile = ScriptVideoRecord
type Mutation<T> = { result: T; documentChanged?: boolean; recordChanged?: boolean }
type MutateRecord<T> = (record: RecordFile) => Mutation<T> | Promise<Mutation<T>>
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
function assertId(id: unknown): asserts id is string {
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
  const { status, version, videoUrl, videoVersions, promptNeedsSync, ...rest } = card
  return rest
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
  partialWrite = false,
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
  const settings = partialWrite ? input.settings || {} : { ...(previous?.settings || {}), ...(input.settings || {}) }
  if (settings.stylePreset !== undefined && !validStyle(settings.stylePreset)) throw new ScriptVideoStoreError('风格预设无效，请检查名称、字段或长度')
  const assetIds = new Set<string>()
  for (const asset of input.assets) {
    validateAsset(asset)
    if (assetIds.has(asset.id)) throw new ScriptVideoStoreError('资产标识重复')
    assetIds.add(asset.id)
  }
  const episodes = new Set<string>()
  const oldAssetIds = new Set(previous?.assets.map(asset => asset.id))
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
      ? (partialWrite ? undefined : old?.characterAppearanceNotes)
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
      if (previous) {
        const oldReferences = new Set(scriptVideoReferencedAssetIds(prior))
        if (scriptVideoReferencedAssetIds(card).some(id => !assetIds.has(id) && (!oldReferences.has(id) || oldAssetIds.has(id))))
          throw new ScriptVideoStoreError('引用的素材已移除，请更新本地草稿后再保存', 409, 'ASSET_REMOVED')
      }
      const normalizedPrompt = style && typeof card.prompt === 'string' && card.prompt.trim()
        ? replaceScriptVideoPromptStyle(card.prompt, style, previousStyle, production)
        : card.prompt
      const normalizedPriorPrompt = style && typeof prior?.prompt === 'string' && prior.prompt.trim()
        ? replaceScriptVideoPromptStyle(prior.prompt, style, previousStyle, production)
        : prior?.prompt
      // Only a new card added to an existing video-production episode can use
      // a free-form prompt. A snapshot edit cannot change a saved card's origin.
      const { manuallyAdded, videoVersions: _incomingVersions, ...cardContent } = card
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
      const videoVersions = prior?.videoVersions ??
        (changed && prior?.status === 'ready' && prior.videoUrl ? listScriptVideoVersions(prior) : undefined)
      return {
        ...annotated,
        promptNeedsSync,
        videoUrl: prior?.videoUrl,
        ...(videoVersions && { videoVersions }),
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
    const videoDurations = Object.entries(incomingDurations ?? (partialWrite ? {} : old?.videoDurations) ?? {}).filter(([cardId, duration]) => ids.has(cardId) && isScriptVideoGenerationDuration(duration))
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
// Resolve mentions against the old asset index before replacing or deleting the name.
function propagateSharedEdits(before: ScriptVideoProject, after: ScriptVideoProject) {
  const nextAssets = new Map<string, MentionAsset>(after.assets.map(asset => [asset.id, asset]))
  const renamed = new Map<string, string>()
  const removed = new Set<string>()
  for (const asset of before.assets) {
    const next = nextAssets.get(asset.id)
    if (!next) removed.add(asset.id)
    else if (next.name !== asset.name) renamed.set(asset.id, next.name)
  }
  const style = after.settings?.stylePreset
  const styleChanged = validStyle(style) && !isDeepStrictEqual(style, before.settings?.stylePreset)
  if (!renamed.size && !removed.size && !styleChanged) return
  for (const episode of after.episodes) {
    const oldStyle = episode.production?.stylePreset || before.settings?.stylePreset
    for (const card of episode.cards) {
      const ids: string[] = card.assetIds || []
      const rewrite = (value: unknown, dialogue = false) => {
        if (typeof value !== 'string' || !value.includes('@') || !(renamed.size || removed.size)) return value
        const { mentions } = annotateScriptVideoAssets(value, before.assets, ids, {
          dialogue, cast: episode.production?.characters, characters: card.characters,
          protectedPrefix: oldStyle && scriptVideoPromptStylePrefix(oldStyle), excludedIds: card.excludedAssetIds,
        })
        let result = '', last = 0
        for (const mention of mentions) {
          if (!mention.explicit || mention.spoken || (!renamed.has(mention.id) && !removed.has(mention.id))) continue
          result += value.slice(last, mention.start) + (removed.has(mention.id) ? mention.name : '@' + renamed.get(mention.id))
          last = mention.end
        }
        return result + value.slice(last)
      }
      for (const key of ['prompt', 'openingRecap', 'opening', 'scene', 'characters', 'independentGeneration', 'ending']) {
        if (typeof card[key] === 'string') card[key] = rewrite(card[key])
      }
      for (const key of ['assetIds', 'openingAssetIds', 'excludedAssetIds']) {
        if (removed.size && Array.isArray(card[key])) card[key] = card[key].filter((id: string) => !removed.has(id))
      }
      for (const shot of card.shots || []) {
        for (const key of ['camera', 'action', 'dialogue']) if (typeof shot[key] === 'string') shot[key] = rewrite(shot[key], key === 'dialogue')
        for (const key of ['visualAssetIds', 'speakerAssetIds']) {
          if (removed.size && Array.isArray(shot[key])) shot[key] = shot[key].filter((id: string) => !removed.has(id))
        }
      }
      if (styleChanged && typeof card.prompt === 'string' && card.prompt.trim()) {
        const prompt = replaceScriptVideoPromptStyle(card.prompt, style, oldStyle, episode.production)
        if (prompt !== card.prompt) {
          card.promptVersions = [...(card.promptVersions || []), {             id: 'prompt-' + randomUUID(), prompt: card.prompt,
            assetIds: [...ids], ...(card.excludedAssetIds?.length && { excludedAssetIds: [...card.excludedAssetIds] }),
            createdAt: new Date().toISOString(), instruction: '更新项目统一风格', summary: '更新风格前的提示词'           }]
          card.prompt = prompt
        }
      }
    }
    if (styleChanged && episode.production) {
      episode.production.stylePreset = style
      episode.production.visualSpecs = styleVisualSpecs(style, { aspectRatio: episode.aspectRatio, resolution: episode.resolution, videoModel: episode.modelName })
    }
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
  private generationQueue?: ScriptVideoQueue
  get queue() { return this.generationQueue ??= new ScriptVideoQueue(this.directory) }
  constructor(public directory = defaultScriptVideoStoreDirectory()) {
    this.init = this.initialize()
    void this.init.catch(() => { })
  }
  private catalog!: ScriptVideoDatabase
  private media!: ScriptVideoMediaRetention
  private corruptLegacy = new Set<string>()
  private async initialize() {
    await fs.mkdir(this.directory, { recursive: true })
    this.catalog = new ScriptVideoDatabase(this.directory)
    const db = this.catalog.db
    this.media = new ScriptVideoMediaRetention(db)
    for (const name of await fs.readdir(this.directory)) {
      const id = name.slice(0, -5)
      if (!name.endsWith('.json') || !validId(id) || db.prepare('SELECT 1 FROM imported_files WHERE id=?').get(id)) continue
      let record: RecordFile
      try {
        record = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'))
        if (record.project?.id !== id || typeof record.project.title !== 'string' || !Number.isSafeInteger(record.project.revision) ||
          !Array.isArray(record.project.assets) || !Array.isArray(record.jobs) || !Array.isArray(record.project.episodes) ||
          record.jobs.some(job => !validId(job?.episodeId) || typeof job?.action !== 'string' || typeof job?.status !== 'string') ||
          [record.jobs, record.project.episodes].some(items => items.some(item => !validId(item?.id)) ||
            new Set(items.map(item => item.id)).size !== items.length)) throw Error()
        db.transaction(() => {
          if (!this.catalog.project(id)) this.writeRecord(record)
          db.prepare('INSERT OR IGNORE INTO imported_files(id) VALUES(?)').run(id)
        }).immediate()
      } catch (error) {
        // Disk/SQLite errors must surface instead of misclassifying a healthy legacy file.
        if (error && typeof error === 'object' && 'code' in error) throw error
        this.corruptLegacy.add(id)
        continue
      }
    }
    // Submitted video tasks survive restarts. Unsubmitted work has no live worker.
    const interrupted = db.prepare<[], { project_id: string }>(`
      SELECT DISTINCT project_id FROM jobs WHERE status IN ('queued','running') AND (action<>'video' OR task_id IS NULL)
    `).all()
    for (const { project_id: id } of interrupted) {
      const record = this.readRecord(id)
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
      if (changed) this.writeRecord(record)
    }
    if (!this.corruptLegacy.size) this.media.startCleanup()
  }

  private projectRow(id: string): ProjectRow {
    assertId(id)
    const row = this.catalog.project(id)
    if (row) return row
    if (this.corruptLegacy.has(id)) throw new ScriptVideoStoreError('项目数据无法读取', 500, 'CORRUPT')
    throw new ScriptVideoStoreError('项目不存在', 404, 'NOT_FOUND')
  }

  private readRecord(id: string, scope?: string, trackChanges = true): RecordFile {
    const row = this.projectRow(id)
    const project = this.catalog.shared(row)
    let episodeRevision: number | undefined
    if (scope) {
      const episode = this.catalog.episode(id, scope)
      if (!episode) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      episodeRevision = episode.episodeRevision
      project.episodes = [episode.episode]
    } else project.episodes = this.catalog.allEpisodes(row)
    return {       project, jobs: this.catalog.jobs(id, scope), storageVersion: row.version, scope, episodeRevision,
      originalEpisodes: trackChanges ? new Map(project.episodes.map(episode => [episode.id, JSON.stringify(episode)])) : undefined     }
  }

  private normalizeRecord(record: RecordFile, episodes: ScriptVideoProject['episodes']) {
    // Older snapshots stored the preset's display heading and trailing blank
    // lines in the current prompt. Present its normalized form consistently
    // to reads, jobs and future writes, without touching historical versions.
    const completedJobs = new Map(record.jobs.filter(job =>
      job.action === 'video' && job.status === 'completed' && !job.staleResult && job.taskId,
    ).map(job => [job.id, job]))
    for (const episode of episodes) {
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
          const archive = listScriptVideoVersions(card)
          if (archive.length && !archive.some(item => item.url === completed.videoUrl)) {
            card.videoVersions = [...archive, { url: completed.videoUrl }]
          }
          card.status = 'ready'
          card.videoUrl = completed.videoUrl
        }
      }
    }
  }

  private writeRecord(record: RecordFile) {
    const { project, jobs } = record
    const db = this.catalog.db
    const cleanupNeeded = db.transaction(() => {
      const prior = this.catalog.project(project.id)
      if (record.storageVersion !== undefined && record.storageVersion !== prior?.version)
        throw new ScriptVideoStoreError('项目刚刚更新，请重试', 409, 'CONFLICT')
      const changedEpisodes = record.originalEpisodes ? project.episodes.filter(episode => record.originalEpisodes!.get(episode.id) !== JSON.stringify(episode)) : project.episodes
      this.normalizeRecord(record, changedEpisodes)
      const ids: string[] = record.scope && prior ? JSON.parse(prior.episode_order) : project.episodes.map(ep => ep.id)
      this.catalog.putProject(project, ids, prior)
      if (!record.scope && prior) {
        const keep = new Set(ids)
        for (const id of JSON.parse(prior.episode_order) as string[]) {
          if (!keep.has(id)) db.prepare('DELETE FROM episodes WHERE project_id=? AND id=?').run(project.id, id)
        }
      }
      for (const episode of changedEpisodes) this.catalog.putEpisode(project.id, episode)
      const assetsChanged = !prior || prior.assets !== JSON.stringify(project.assets)
      if (assetsChanged)
        this.media.replaceProjectAssets(project.id, prior ? JSON.parse(prior.assets) : [], project.assets)
      const heldSql = "SELECT id FROM jobs WHERE project_id=? AND action='video' AND status IN ('queued','running') AND task_id IS NULL"
      const held = db.prepare<unknown[], { id: string }>(heldSql + (record.scope ? ' AND episode_id=?' : ''))
        .all(...(record.scope ? [project.id, record.scope] : [project.id]))
      const next = new Set(jobs.filter(job => job.action === 'video' && !job.taskId && (job.status === 'queued' || job.status === 'running')).map(job => job.id))
      const released = held.filter(item => !next.delete(item.id))
      for (const item of released) this.media.releaseJob(item.id)
      for (const id of next) this.media.holdJob(id, project.assets)
      this.catalog.putJobs(project.id, jobs, record.scope)
      return assetsChanged || released.length > 0
    }).immediate()
    if (cleanupNeeded) this.media.scheduleCleanup()
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
  private readProject(id: string) {
    const row = this.projectRow(id)
    return { ...this.catalog.shared(row), episodes: this.catalog.allEpisodes(row) }
  }
  async close() {
    await this.init
    this.media.dispose()
    this.generationQueue?.close()
    this.catalog.db.close()
  }
  async list(): Promise<ScriptVideoProject[]> {
    await this.init
    if (this.corruptLegacy.size) throw new ScriptVideoStoreError('部分旧项目无法读取，请检查原始存档', 500, 'CORRUPT')
    return this.catalog.db.transaction(() => this.catalog.directory().map(row => this.readProject(row.id)))()
  }
  async listSummaries() {
    await this.init
    return [...this.catalog.directory(), ...Array.from(this.corruptLegacy, id => ({ id, title: '存档待恢复 · ' + id, revision: 0 }))]
  }
  async summary(id: string) {
    await this.init
    return this.catalog.db.transaction(() => this.catalog.summary(this.projectRow(id)))()
  }
  async episode(id: string, episodeId: string) {
    await this.init
    assertId(episodeId)
    assertId(id)
    const result = this.catalog.episode(id, episodeId)
    if (!result) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
    return result
  }
  async activity(id: string, episodeId: string) {
    await this.init
    assertId(id)
    assertId(episodeId)
    const result = this.catalog.activity(id, episodeId)
    if (!result) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
    return result
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
    await this.exclusive(id, async () => this.writeRecord({ project, jobs: [] }))
    return project
  }
  async get(id: string): Promise<ScriptVideoProject> {
    await this.init
    return this.catalog.db.transaction(() => this.readProject(id))()
  }

  // Presence is advisory. It never participates in a document write or reserves an episode.
  private liveViewers(id: string) {
    const viewers = this.episodeLeases.get(id) ?? new Map<string, EpisodeLease>()
    for (const [key, entry] of viewers) if (entry.expiresAt <= Date.now()) viewers.delete(key)
    if (!viewers.size) this.episodeLeases.delete(id)
    return viewers
  }
  async listEpisodeLeases(id: string, session: string | null) {
    await this.init
    assertId(id)
    const result: Record<string, { expiresAt: number }> = Object.create(null)
    for (const [key, viewer] of this.liveViewers(id)) {
      if (viewer.session === session) continue
      const episodeId = key.split('/')[0]
      result[episodeId] = { expiresAt: Math.max(result[episodeId]?.expiresAt ?? 0, viewer.expiresAt) }
    }
    return result
  }
  async acquireEpisodeLease(id: string, episodeId: string, session: string | null, _renew: boolean) {
    await this.init
    assertId(id)
    assertId(episodeId)
    if (!session) throw new ScriptVideoStoreError('缺少页面标识')
    if (!this.catalog.db.prepare('SELECT 1 FROM episodes WHERE project_id=? AND id=?').get(id, episodeId))
      throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
    const expiresAt = Date.now() + EPISODE_LEASE_MS
    const viewers = this.liveViewers(id)
    viewers.set(episodeId + '/' + session, { session, expiresAt })
    this.episodeLeases.set(id, viewers)
    return { expiresAt }
  }
  async releaseEpisodeLease(id: string, episodeId: string, session: string | null) {
    assertId(id)
    assertId(episodeId)
    this.liveViewers(id).delete(episodeId + '/' + session)
  }

  private assertRemovalsAllowed(before: ScriptVideoProject, afterEpisodes: ScriptVideoProject['episodes']) {
    const next = new Map(afterEpisodes.map(episode => [episode.id, episode]))
    for (const episode of before.episodes) {
      const remaining = new Set<string>((next.get(episode.id)?.cards || []).map((card: any) => card.id))
      if (next.has(episode.id) && episode.cards.every((card: any) => remaining.has(card.id))) continue
      if (this.queue.list(before.id, episode.id).some(item => !remaining.has(item.cardId)))
        throw new ScriptVideoStoreError('分镜正在排队，请先取消生成或等待完成', 409, 'VIDEO_RUNNING')
      if (!next.has(episode.id) && (episode.tasks?.some((task: any) => task.status === 'processing') ||
        this.catalog.db.prepare("SELECT 1 FROM jobs WHERE project_id=? AND episode_id=? AND status IN ('queued','running') LIMIT 1").get(before.id, episode.id)))
        throw new ScriptVideoStoreError('分集还有任务在运行，请等任务结束后再删除', 409, 'PROJECT_BUSY')
    }
  }
  async delete(id: string, session?: string | null): Promise<void> {
    await this.exclusive(id, async () => {
      this.catalog.db.transaction(() => {
        const { project, jobs } = this.readRecord(id)
        const activeJob = jobs.some(job => job.status === 'queued' || job.status === 'running')
        const processingVideo = project.episodes.some(episode =>
          episode.tasks?.some((task: { status: string }) => task.status === 'processing'),
        )
        if (activeJob || processingVideo)
          throw new ScriptVideoStoreError('项目还有任务在运行，请等任务结束后再删除', 409, 'PROJECT_BUSY')
        this.assertRemovalsAllowed(project, [])
        this.media.replaceProjectAssets(id, project.assets, [])
        this.catalog.db.prepare('DELETE FROM projects WHERE id=?').run(id)
      }).immediate()
      this.media.scheduleCleanup()
      this.episodeLeases.delete(id)
    })
  }
  async update(
    id: string,
    input: unknown,
    expectedRevision: number,
    session?: string | null,
  ): Promise<ScriptVideoProject> {
    return this.exclusive(id, async () => this.catalog.db.transaction(() => {
      const record = this.readRecord(id)
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
      this.assertRemovalsAllowed(record.project, project.episodes)
      project.revision = record.project.revision + 1
      record.project = project
      this.writeRecord(record)
      return project
    }).immediate())
  }
  async applyChanges(id: string, body: { clientId: string; sequence: number; changes: ScriptVideoChange[]; loadedEpisodeIds?: string[] }, user = '') {
    if (!body || !validId(body.clientId) || !Number.isSafeInteger(body.sequence) || body.sequence < 1)
      throw new ScriptVideoStoreError('保存请求标识无效')
    if (body.loadedEpisodeIds !== undefined && (!Array.isArray(body.loadedEpisodeIds) || !body.loadedEpisodeIds.every(validId)))
      throw new ScriptVideoStoreError('分集标识无效')
    try { validateScriptVideoChanges(body.changes) }
    catch (error) { throw new ScriptVideoStoreError((error as Error).message) }
    const { changes, sequence } = body
    const client = JSON.stringify([user, body.clientId])
    const edits = new Set<string>()
    for (const change of changes) {
      if ((change.target === 'card' || change.target === 'shot') && change.episodeId) edits.add(change.episodeId)
      if (change.target === 'episode' && change.id) edits.add(change.id)
    }
    const requested = new Set([...edits, ...(body.loadedEpisodeIds || [])])
    return this.exclusive(id, async () => {
      const db = this.catalog.db
      let assetsChanged = false
      const result = db.transaction(() => {
        const row = this.projectRow(id)
        const last = db.prepare<[string, string], { sequence: number }>('SELECT sequence FROM client_writes WHERE project_id=? AND client_id=?').get(id, client)
        const fresh = !last || sequence > last.sequence
        if (fresh && changes.length) {
          const before = this.catalog.shared(row)
          const order: string[] = JSON.parse(row.episode_order)
          // Only edits whose meaning spans the whole project need to visit other episodes.
          const voiceModesOnly = changes.every(change => change.target === 'asset' && !change.order && !change.remove && !change.value &&
            [...Object.keys(change.fields || {}), ...(change.unset || [])].every(field => field === 'voiceMode'))
          const whole = !voiceModesOnly && changes.some(change => change.target === 'asset' && !change.order ||
            change.target === 'project' && [...Object.keys(change.fields || {}), ...(change.unset || [])].some(field =>
              field === 'settings' || field === 'settings.stylePreset' || field.startsWith('settings.stylePreset.')))
          before.episodes = whole ? this.catalog.allEpisodes(row)
            : [...edits].map(eid => this.catalog.episode(id, eid)?.episode).filter(Boolean)
          let next: ScriptVideoProject
          try { next = applyScriptVideoChanges(before, changes) }
          catch (error) { throw new ScriptVideoStoreError((error as Error).message, 409, 'CHANGE_CONFLICT') }
          for (const episode of next.episodes) if (!before.episodes.some(prior => prior.id === episode.id))
            Object.assign(episode, { ...makeEpisode(), ...episode })
          if (whole) propagateSharedEdits(before, next)
          // Directory operations only need IDs, including when the new episode is inserted between unloaded ones.
          let nextOrder = order
          for (const change of changes) {
            if (change.target !== 'episode') continue
            if (change.order) {
              const known = new Set(nextOrder), listed = new Set(change.order)
              nextOrder = [...change.order.filter(id => known.has(id)), ...nextOrder.filter(id => !listed.has(id))]
            } else if (change.remove) nextOrder = nextOrder.filter(id => id !== change.id)
            else if (change.value && change.id && !nextOrder.includes(change.id)) nextOrder = [...nextOrder, change.id]
          }
          next.episodeId = ''
          next = sanitizeProject(next, before, true)
          if (voiceModesOnly) {
            // A persisted toggle only affects speakers that actually use the
            // fallback. With an uploaded recording there is no episode work.
            const changedVoices = changedVoiceAssetIds(before.assets, next.assets)
            if (changedVoices.length) for (const episode of this.catalog.allEpisodes(row)) {
              const options = { model: episode.modelName, provider: episode.modelProvider,
                cast: episode.production?.characters, stylePreset: episode.production?.stylePreset || next.settings?.stylePreset }
              let changed = false
              for (const card of episode.cards) {
                if (card.status === 'ready' && card.videoUrl) continue
                const voices = getScriptVideoVoiceInputs(card, next.assets, options)
                if (!changedVoices.some(id => voices.has(id))) continue
                card.version = (Number(card.version) || 0) + 1
                card.status = 'draft'
                changed = true
              }
              if (changed) next.episodes.push(episode)
            }
          }
          next.episodeId = nextOrder.includes(before.episodeId) ? before.episodeId : nextOrder[0] || ''
          const deletions = order.filter(eid => !nextOrder.includes(eid))
          this.assertRemovalsAllowed(before, next.episodes)
          next.revision = row.revision + 1
          this.catalog.putProject(next, nextOrder, row)
          for (const eid of deletions) db.prepare('DELETE FROM episodes WHERE project_id=? AND id=?').run(id, eid)
          for (const episode of next.episodes) this.catalog.putEpisode(id, episode)
          assetsChanged = !isDeepStrictEqual(before.assets, next.assets)
          if (assetsChanged) this.media.replaceProjectAssets(id, before.assets, next.assets)
        }
        if (fresh) db.prepare('INSERT INTO client_writes VALUES(?,?,?) ON CONFLICT(project_id,client_id) DO UPDATE SET sequence=excluded.sequence')
          .run(id, client, sequence)
        const project = this.catalog.summary(this.projectRow(id))
        return { project, episodes: [...requested].map(eid => this.catalog.episode(id, eid)?.episode).filter(Boolean), revision: project.revision, sequence }
      }).immediate()
      if (assetsChanged) this.media.scheduleCleanup()
      return result
    })
  }
  async updateCharacterVoice(
    id: string, episodeId: string, assetId: string, session: string | null,
    field: 'voiceAudio' | 'voiceMode', expected: unknown, value: unknown,
  ): Promise<ScriptVideoProject> {
    return this.mutate(id, (record) => {
      const project = record.project
      if (!project.episodes.some(episode => episode.id === episodeId)) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
      const index = project.assets.findIndex(asset => asset.id === assetId)
      const asset = project.assets[index]
      if (!asset || asset.kind !== 'character')
        throw new ScriptVideoStoreError('请选择项目里的角色资产')
      const current = asset[field] ?? null
      if (sameJson(current, value)) return { result: project, recordChanged: false }
      const next = { ...asset }
      if (value === null) delete next[field]
      else next[field] = value
      validateAsset(next)
      const assets = project.assets.slice()
      assets[index] = next
      record.project = sanitizeProject({ ...project, assets }, project)
      return { result: record.project, documentChanged: true }
    })
  }
  /** Server-only mutation under the project lock. Document changes bump revision;
   * pass recordChanged: false when a conditional mutation found nothing to write. */
  async mutate<T>(id: string, fn: MutateRecord<T>, episodeId?: string): Promise<T> {
    return this.exclusive(id, async () => {
      const commit = (record: RecordFile, change: Mutation<T>) => {
        if (change.documentChanged) record.project.revision++
        if (change.documentChanged || change.recordChanged !== false) this.writeRecord(record)
        return change.result
      }
      // A reservation and an edit arriving in different server processes must
      // observe one another. Synchronous checks and writes share the SQLite writer.
      const state = this.catalog.db.transaction(() => {
        const record = this.readRecord(id, episodeId)
        const change = fn(record)
        if (change instanceof Promise) return { pending: change, record }
        return { result: commit(record, change) }
      }).immediate()
      // Legacy async callbacks run without a database transaction across await.
      // Their storageVersion check prevents a stale snapshot from being committed.
      if (state.pending) return commit(state.record, await state.pending)
      return state.result as T
    })
  }
  mutateEpisode<T>(id: string, episodeId: string, fn: MutateRecord<T>) {
    assertId(episodeId)
    return this.mutate(id, fn, episodeId)
  }

  async episodeSnapshot(id: string, episodeId: string) {
    await this.init
    assertId(episodeId)
    return this.catalog.db.transaction(() => this.readRecord(id, episodeId, false))()
  }

  // sys_task has committed its exact input URLs before this synchronous callback.
  attachVideoTask(id: string, jobId: string, taskId: number) {
    const db = this.catalog.db
    db.transaction(() => {
      const result = db.prepare(`UPDATE jobs SET task_id=?,document=json_set(document,'$.taskId',?)
        WHERE project_id=? AND id=? AND action='video' AND task_id IS NULL`).run(taskId, taskId, id, jobId)
      if (!result.changes) return
      db.prepare('UPDATE projects SET version=version+1 WHERE id=?').run(id)
      this.media.releaseJob(jobId)
    }).immediate()
    this.media.scheduleCleanup()
  }

  async getVideoJob(projectId: string, taskId: number): Promise<ScriptVideoJob> {
    await this.init
    assertId(projectId)
    const row = this.catalog.db.prepare<[string, number], { document: string }>("SELECT document FROM jobs WHERE project_id=? AND task_id=? AND action='video'").get(projectId, taskId)
    if (!row) throw new ScriptVideoStoreError('任务不属于此项目', 404, 'NOT_FOUND')
    return JSON.parse(row.document)
  }
  async listPendingVideoJobs(projectId: string, episodeId?: string) {
    await this.init
    assertId(projectId)
    if (episodeId && !this.catalog.db.prepare('SELECT 1 FROM episodes WHERE project_id=? AND id=?').get(projectId, episodeId))
      throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
    const sql = "SELECT document FROM jobs WHERE project_id=? AND action='video' AND task_id IS NOT NULL AND status IN ('queued','running')"
    const rows = this.catalog.db.prepare<unknown[], { document: string }>(sql + (episodeId ? ' AND episode_id=?' : '') + ' ORDER BY rowid')
      .all(...(episodeId ? [projectId, episodeId] : [projectId]))
    return rows.map(row => JSON.parse(row.document) as ScriptVideoJob & { taskId: number })
  }
  async listJobs(projectId: string, episodeId?: string, restore = false): Promise<ScriptVideoJob[]> {
    await this.init
    assertId(projectId)
    if (!this.catalog.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) this.projectRow(projectId)
    if (restore) {
      assertId(episodeId)
      return this.catalog.restoreJobs(projectId, episodeId).map(publicScriptVideoJob)
    }
    return this.catalog.jobs(projectId, episodeId).map(publicScriptVideoJob)
  }
  async getJob(projectId: string, jobId: string) {
    await this.init
    assertId(projectId)
    assertId(jobId)
    const row = this.catalog.db.prepare<[string, string], { document: string }>('SELECT document FROM jobs WHERE project_id=? AND id=?').get(projectId, jobId)
    if (!row) throw new ScriptVideoStoreError('任务不存在', 404, 'NOT_FOUND')
    return publicScriptVideoJob(JSON.parse(row.document))
  }

  async cancelTextJob(projectId: string, jobId: string, session: string | null) {
    assertId(jobId)
    return this.mutate(projectId, record => {
      const job = record.jobs.find(item => item.id === jobId && item.action !== 'video')
      if (!job) throw new ScriptVideoStoreError('文字生成任务不存在', 404, 'NOT_FOUND')
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
