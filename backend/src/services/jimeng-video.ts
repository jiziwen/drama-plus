import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import type { AIConfig } from './adapters/types.js'
import type { GenerateVideoParams } from './generation.js'
import {
  createJimengCanvas, createJimengVideoDraft, getJimengPersonalSpaceAccountId, JimengCliError, uploadJimengReference,
} from './jimeng-cli.js'
import { jimengVideoModel } from './jimeng-video-models.js'

export { jimengVideoModels } from './jimeng-video-models.js'
const maxReferenceBytes = 100 * 1024 * 1024
const mediaExtensions = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'],
  video: ['.mp4', '.mov', '.webm'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'],
}
type Reference = { kind: keyof typeof mediaExtensions; source: string }
const canvases = new Map<string, Promise<{ projectId: string }>>()
let preparing = 0

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

export async function prepareJimengVideo(params: GenerateVideoParams, config: AIConfig, signal?: AbortSignal) {
  if (preparing >= 3) throw new JimengCliError('即梦正在准备的任务过多，请稍后再试')
  preparing++
  let scratch: string | undefined
  try {
    const draft = draftInput(params, config)
    const accountId = await getJimengPersonalSpaceAccountId()
    scratch = await mkdtemp(path.join(tmpdir(), 'drama-jimeng-'))
    const files = await Promise.all(draft.references.map((ref, index) => resolveReference(ref, scratch!, index)))
    signal?.throwIfAborted()
    const { projectId } = await getCanvas(accountId)
    const references = []
    for (const [index, ref] of draft.references.entries()) {
      signal?.throwIfAborted()
      references.push({ kind: ref.kind, resourceId: await uploadJimengReference(projectId, files[index], ref.kind) })
    }
    signal?.throwIfAborted()
    const { references: _references, ...input } = draft
    return await createJimengVideoDraft({ ...input, projectId, prompt: providerPrompt(input.prompt, references), references }, accountId)
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {})
    preparing--
  }
}
