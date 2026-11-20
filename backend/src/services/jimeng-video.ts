import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import type { AIConfig } from './adapters/types.js'
import type { GenerateVideoParams } from './generation.js'
import {
  createJimengCanvas, createJimengVideoQuote, getJimengAccount, uploadJimengReference,
  type JimengVideoRunInput,
} from './jimeng-cli.js'
import { jimengVideoModel } from './jimeng-video-models.js'

export { jimengVideoModels } from './jimeng-video-models.js'
const quoteLifetime = 10 * 60_000
const maxReferenceBytes = 100 * 1024 * 1024
const mediaExtensions = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'],
  video: ['.mp4', '.mov', '.webm'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
}
type Reference = { kind: keyof typeof mediaExtensions; source: string }
type Quote = { input: JimengVideoRunInput; expiresAt: number; requestDigest: string }
const quotes = new Map<string, Quote>()
const canvases = new Map<string, Promise<{ projectId: string }>>()
let pendingQuotes = 0

function draftInput(params: GenerateVideoParams, config: AIConfig) {
  const model = config.model
  const spec = jimengVideoModel(model)
  if (!spec) throw new Error('请选择已支持的即梦 Seedance 模型')
  if (params.referenceFileUrl || params.referenceLinkUrl) throw new Error('即梦参考素材请使用项目内的图片、视频或音频')
  const images = params.referenceImageUrls?.length ? params.referenceImageUrls : params.imageUrl ? [params.imageUrl] : []
  const videos = params.referenceVideoUrls || []
  const audios = params.referenceAudioUrls || []
  const references: Reference[] = []
  let mode: 't2v' | 'm2v' | 'first_last_frame' = 't2v'
  if (params.firstFrameUrl || params.lastFrameUrl) {
    if (!params.firstFrameUrl || images.length || videos.length || audios.length) {
      throw new Error('即梦首尾帧模式需要首帧，且需单独使用')
    }
    mode = 'first_last_frame'
    references.push({ kind: 'image', source: params.firstFrameUrl })
    if (params.lastFrameUrl) references.push({ kind: 'image', source: params.lastFrameUrl })
  } else if (images.length || videos.length || audios.length) {
    mode = 'm2v'
    references.push(...images.map(source => ({ kind: 'image' as const, source })),
      ...videos.map(source => ({ kind: 'video' as const, source })), ...audios.map(source => ({ kind: 'audio' as const, source })))
  }
  const prompt = params.prompt?.trim() || ''
  if (!prompt && !references.length) throw new Error('请填写视频提示词或添加参考素材')
  if ([...prompt].length > spec.promptLimit) throw new Error(`所选即梦模型单次提示词最多 ${spec.promptLimit} 字符`)
  const duration = params.duration ?? 5
  const aspectRatio = params.aspectRatio || '16:9'
  const resolution = (params.resolution || (spec.resolutions.includes('720p') ? '720p' : spec.resolutions[0])).toLowerCase()
  if (!Number.isInteger(duration) || duration < 4 || duration > spec.maxDuration) throw new Error(`所选即梦模型支持 4–${spec.maxDuration} 秒的整数时长`)
  if (!spec.resolutions.includes(resolution)) throw new Error(`所选即梦模型支持 ${spec.resolutions.join('、')}`)
  if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].includes(aspectRatio)) throw new Error('所选画幅不适用于即梦视频')
  if (images.length > spec.images || videos.length > spec.videos || audios.length > spec.audios || references.length > spec.maxReferences) throw new Error('即梦参考素材超出所选模型限制')
  return { model, mode, prompt, duration, aspectRatio, resolution, references }
}

type Draft = ReturnType<typeof draftInput>

function requestDigest(draft: Draft, params: GenerateVideoParams, config: AIConfig) {
  return createHash('sha256').update(JSON.stringify([config.id, params.storyboardId, params.dramaId, params.jimengScope, draft])).digest('hex')
}

async function resolveReference(ref: Reference, scratch: string, index: number) {
  const data = ref.kind === 'image' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z\d+/]+={0,2})$/u.exec(ref.source)
  if (data && Buffer.byteLength(data[2], 'base64') <= maxReferenceBytes) {
    const filename = path.join(scratch, `${index}.${data[1] === 'jpeg' ? 'jpg' : data[1]}`)
    await writeFile(filename, Buffer.from(data[2], 'base64'))
    return filename
  }
  if (!/^\/?static\//u.test(ref.source) || /[%?#\\\0]/u.test(ref.source) || ref.source.split('/').includes('..')) {
    throw new Error('即梦参考素材需要先上传到当前项目')
  }
  try {
    const root = await realpath(STORAGE_ROOT)
    const filename = await realpath(path.join(root, ref.source.replace(/^\/?static\//u, '')))
    const file = await stat(filename)
    if (!filename.startsWith(root + path.sep) || !file.isFile() || file.size > maxReferenceBytes ||
      !mediaExtensions[ref.kind].includes(path.extname(filename).toLowerCase())) throw new Error()
    return filename
  } catch { throw new Error('即梦参考素材无法读取、格式不支持或超过 100 MB，请重新上传') }
}

function providerPrompt(prompt: string, references: { kind: Reference['kind']; resourceId: string }[]) {
  const byKind = { image: [] as string[], video: [] as string[], audio: [] as string[] }
  for (const { kind, resourceId } of references) byKind[kind].push(resourceId)
  return prompt.replace(/\{\{/gu, '\\{{').replace(/@?(图片|图像|视频|音频|声音)\s*(\d+)/gu, (label, type, number) => {
    const kind = type === '视频' ? 'video' : type === '音频' || type === '声音' ? 'audio' : 'image'
    const resourceId = byKind[kind][Number(number) - 1]
    return resourceId ? `${label}{{res:${resourceId}}}` : label
  })
}

function getCanvas(accountId: string) {
  let canvas = canvases.get(accountId)
  if (!canvas) {
    canvas = createJimengCanvas('小李短剧 · Seedance 分镜').catch(error => { canvases.delete(accountId); throw error })
    canvases.set(accountId, canvas)
  }
  return canvas
}

export function validateJimengVideo(params: GenerateVideoParams, config: AIConfig) {
  draftInput(params, config)
}

export async function quoteJimengVideo(params: GenerateVideoParams, config: AIConfig) {
  if (!params.jimengScope) throw new Error('请在「剧本转视频」中为分镜获取即梦报价')
  const draft = draftInput(params, config)
  const account = await getJimengAccount()
  if (!account.authenticated || !account.accountId) throw new Error(account.message || '请先在 AI 服务中连接即梦账号')
  for (const [id, quote] of quotes) if (quote.expiresAt <= Date.now()) quotes.delete(id)
  if (pendingQuotes >= 3 || quotes.size >= 100) throw new Error('即梦待确认报价过多，请稍后再试')
  pendingQuotes++
  let scratch: string | undefined
  try {
    scratch = await mkdtemp(path.join(tmpdir(), 'drama-jimeng-'))
    const files = await Promise.all(draft.references.map((ref, index) => resolveReference(ref, scratch!, index)))
    const { projectId } = await getCanvas(String(account.accountId))
    const references = []
    for (const [index, ref] of draft.references.entries()) {
      references.push({ kind: ref.kind, resourceId: await uploadJimengReference(projectId, files[index], ref.kind) })
    }
    const { references: _references, ...input } = draft
    const quote = await createJimengVideoQuote({ ...input, projectId, prompt: providerPrompt(input.prompt, references), references })
    if (String(quote.accountId) !== String(account.accountId)) throw new Error('即梦报价账号有变动，请重新报价')
    const id = randomUUID()
    const expiresAt = Date.now() + quoteLifetime
    quotes.set(id, { input: { ...quote, submitId: randomUUID() }, expiresAt, requestDigest: requestDigest(draft, params, config) })
    return { quote_id: id, credits: quote.credits, model: draft.model, expires_at: new Date(expiresAt).toISOString() }
  } finally {
    pendingQuotes--
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

export function claimJimengVideoQuote(params: GenerateVideoParams, config: AIConfig) {
  const id = params.jimengQuoteId
  const quote = id ? quotes.get(id) : undefined
  if (!params.jimengScope || !quote || quote.expiresAt <= Date.now() || requestDigest(draftInput(params, config), params, config) !== quote.requestDigest) {
    throw new JimengQuoteRequiredError()
  }
  quotes.delete(id!)
  return quote.input
}

export class JimengQuoteRequiredError extends Error {
  constructor() { super('请获取当前分镜的即梦积分报价，并确认后再生成') }
}
