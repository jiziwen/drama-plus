import { randomUUID, randomInt } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildWorkFisher, type WorkFisherParams } from './work-fisher.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import { recordedFetch as fetch } from './api-call-log.js'
import { waitForLocalComfy } from './local-runtime.js'
import { logTaskWarn } from '../utils/task-logger.js'

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, any> }>
export interface ComfySettings {
  workflow?: ComfyWorkflow
  outputNode?: string
  referenceNode?: string
  referencePrefix?: string
  referenceStart?: number
  maxReferences?: number
  maxPixels?: number
  width?: number
  height?: number
  fps?: number
  frameStep?: number
  frameOffset?: number
  timeoutMinutes?: number
  /** Opt-in: keep the character workflow but disable its two soft-focus style LoRAs. */
  characterClarity?: boolean
}
interface Preset extends ComfySettings { label: string; type: 'image' | 'video'; workflow: ComfyWorkflow; outputNode: string }
export interface ComfyConnection { baseUrl: string; apiKey: string; model: string; comfyui?: ComfySettings }

export function parseComfySettings(raw: string | null | undefined): ComfySettings | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw)?.comfyui } catch { return undefined }
}

export function validateComfySettings(value: unknown): ComfySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ComfyUI 配置必须是 JSON 对象')
  const s = value as ComfySettings
  if (s.characterClarity !== undefined && typeof s.characterClarity !== 'boolean') throw new Error('ComfyUI characterClarity 必须为布尔值')
  for (const [key, min, max] of [
    ['maxPixels', 16384, 16777216], ['fps', 1, 120], ['frameStep', 1, 120],
    ['frameOffset', 0, 120], ['timeoutMinutes', 1, 720], ['maxReferences', 0, 16], ['referenceStart', 0, 16],
  ] as const) {
    const n = s[key]
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max)) {
      throw new Error(`ComfyUI ${key} 必须为 ${min}–${max} 的整数`)
    }
  }
  for (const key of ['outputNode', 'referenceNode', 'referencePrefix'] as const) {
    if (s[key] !== undefined && (typeof s[key] !== 'string' || !s[key]?.trim())) throw new Error(`ComfyUI ${key} 必须为非空字符串`)
  }
  if (s.width !== undefined || s.height !== undefined) {
    for (const key of ['width', 'height'] as const) {
      const n = s[key]
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 32 || n > 4096 || n % 32 !== 0) {
        throw new Error('ComfyUI 宽度和高度须同时填写，均为 32–4096 之间的 32 的倍数')
      }
    }
  }
  if (s.workflow !== undefined) {
    if (!s.workflow || typeof s.workflow !== 'object' || Array.isArray(s.workflow) || !Object.keys(s.workflow).length || 'nodes' in s.workflow) {
      throw new Error('请导入 ComfyUI API 格式工作流，不能使用普通画布 JSON')
    }
    for (const node of Object.values(s.workflow)) {
      if (!node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
        throw new Error('工作流节点必须包含 class_type 和 inputs')
      }
    }
    if (!s.outputNode || !s.workflow[s.outputNode]) throw new Error('请指定工作流中的最终输出节点 outputNode')
    if (s.referenceNode && !s.workflow[s.referenceNode]) throw new Error('参考图节点 referenceNode 不存在')
  }
  return s
}

export function comfyHeaders(config: Pick<ComfyConnection, 'apiKey'>): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

export function comfyUrl(baseUrl: string, endpoint: string): string {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.search || base.hash) throw new Error('ComfyUI 地址必须为 HTTP(S) 服务地址')
  return `${base.toString().replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`
}

async function requestJson(config: ComfyConnection, endpoint: string, init: RequestInit = {}) {
  const response = await fetch(comfyUrl(config.baseUrl, endpoint), {
    ...init, headers: { ...comfyHeaders(config), ...init.headers }, signal: AbortSignal.timeout(60_000),
  })
  const data = await response.json() as any
  if (!response.ok || data.error) {
    const detail = data.node_errors && Object.keys(data.node_errors).length ? JSON.stringify(data.node_errors) : JSON.stringify(data.error || data)
    throw new Error(`ComfyUI ${response.status}: ${detail.slice(0, 1200)}`)
  }
  return data
}

function selectPreset(config: ComfyConnection, type: 'image' | 'video'): Preset {
  const s = config.comfyui || {}
  if (s.workflow) return { label: '自定义工作流', type, ...s, workflow: s.workflow, outputNode: s.outputNode! }
  throw new Error(`不支持的 ComfyUI ${type} 工作流：${config.model}`)
}

export function buildComfyWorkflow(config: ComfyConnection, type: 'image' | 'video', params: WorkFisherParams, referenceNames: string[] = []) {
  validateComfySettings(config.comfyui || {})
  const seed = params.seed === undefined || params.seed === -1 ? randomInt(0, 2 ** 48 - 1) : params.seed
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('ComfyUI seed 必须是非负安全整数或 -1')
  if (!config.comfyui?.workflow) return buildWorkFisher(config, type, params, referenceNames, seed)
  const preset = selectPreset(config, type)
  const fps = preset.fps || 24
  const duration = Number(params.duration ?? 5)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('ComfyUI 视频时长须为 0–60 秒之间')
  const step = preset.frameStep || 1, offset = preset.frameOffset || 0
  const frames = Math.max(offset, Math.ceil((Math.round(duration * fps) - offset) / step) * step + offset)
  let [width, height] = (type === 'image' ? params.size || '1024x1024' : (params.aspectRatio || '16:9').replace(':', 'x')).split('x').map(Number)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('ComfyUI 尺寸或宽高比无效')
  if (type === 'video') {
    // 视频尺寸设置决定清晰度，项目画面比例决定横竖屏。
    const pixels = preset.width !== undefined && preset.height !== undefined
      ? preset.width * preset.height : preset.maxPixels || 213000
    const scale = Math.sqrt(pixels / (width * height))
    width = Math.max(32, Math.round(width * scale / 32) * 32)
    height = Math.max(32, Math.round(height * scale / 32) * 32)
  } else if (preset.width !== undefined && preset.height !== undefined) {
    width = preset.width
    height = preset.height
  } else {
    const maxPixels = preset.maxPixels || 1048576
    const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
    width = Math.max(32, Math.floor(width * scale / 32) * 32)
    height = Math.max(32, Math.floor(height * scale / 32) * 32)
  }
  const values: Record<string, string | number> = { prompt: params.prompt, width, height, seed, frames, fps, duration }
  const replace = (value: any): any => {
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{(\w+)\}\}$/)
      if (exact && exact[1] in values) return values[exact[1]]
      return value.replace(/\{\{(\w+)\}\}/g, (whole, key) => key in values ? String(values[key]) : whole)
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
    return value
  }
  const workflow = replace(preset.workflow) as ComfyWorkflow
  if (referenceNames.length) {
    if (!preset.referenceNode || !preset.referencePrefix) throw new Error('该工作流不支持参考图，请选择 Work-Fisher 自动图片或 Qwen Image 工作流')
    if (referenceNames.length > (preset.maxReferences ?? 6)) throw new Error(`该工作流最多支持 ${preset.maxReferences ?? 6} 张参考图`)
    const target = workflow[preset.referenceNode]
    if (!target) throw new Error('工作流参考图节点不存在')
    referenceNames.forEach((name, i) => {
      const nodeId = `huobao_ref_${i}`
      workflow[nodeId] = { class_type: 'LoadImage', inputs: { image: name } }
      target.inputs[`${preset.referencePrefix}${i + (preset.referenceStart || 0)}`] = [nodeId, 0]
    })
  }
  return { workflow, outputNode: preset.outputNode, duration: Number((frames / fps).toFixed(3)), width, height, preset: preset.label, sourceHash: undefined, canvasWorkflow: undefined }
}

async function uploadReference(config: ComfyConnection, source: string): Promise<string> {
  let bytes: Uint8Array, mime = 'image/png'
  if (source.startsWith('data:image/')) {
    const match = source.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/)
    if (!match) throw new Error('ComfyUI 参考图 data URL 无效')
    mime = match[1]; bytes = Buffer.from(match[2], 'base64')
  } else if (/^\/?static\//.test(source)) {
    const file = path.resolve(STORAGE_ROOT, source.replace(/^\/?static\//, ''))
    const rel = path.relative(path.resolve(STORAGE_ROOT), file)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('参考图路径超出素材目录')
    try {
      bytes = await fs.readFile(file)
    } catch (error) {
      logTaskWarn('ComfyUI', 'reference-read-failed', { path: file, error: (error as Error).message })
      throw new Error('参考图文件无法读取，请重新上传或选择历史图片')
    }
    mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png'
  } else if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`参考图下载失败：HTTP ${response.status}`)
    mime = response.headers.get('content-type')?.split(';')[0] || mime
    if (!mime.startsWith('image/')) throw new Error('参考素材不是图片')
    bytes = new Uint8Array(await response.arrayBuffer())
  } else throw new Error('ComfyUI 参考图必须是项目素材、HTTP 地址或图片 data URL')
  if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('参考图为空或超过 30 MB')
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
  const form = new FormData()
  form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), `huobao-${randomUUID()}.${ext}`)
  form.append('type', 'input')
  form.append('subfolder', 'huobao')
  const result = await requestJson(config, '/upload/image', { method: 'POST', body: form })
  if (!result.name) throw new Error('ComfyUI 上传未返回文件名')
  return result.subfolder ? `${result.subfolder}/${result.name}` : result.name
}

export async function submitComfyWorkflow(config: ComfyConnection, type: 'image' | 'video', params: WorkFisherParams, references: string[], onPrepared: (id: string, result: ReturnType<typeof buildComfyWorkflow>) => Promise<void>) {
  // Validate before uploading or submitting anything. Reference names are replaced after upload.
  buildComfyWorkflow(config, type, params, references.map((_, i) => `reference-${i}.png`))
  await waitForLocalComfy(config.baseUrl)
  const names: string[] = []
  for (const source of references) names.push(await uploadReference(config, source))
  const built = buildComfyWorkflow(config, type, params, names)
  const promptId = randomUUID()
  await onPrepared(promptId, built)
  const result = await requestJson(config, '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: built.workflow, prompt_id: promptId, client_id: `huobao-${promptId}`,
      ...(built.canvasWorkflow ? { extra_data: { extra_pnginfo: { workflow: built.canvasWorkflow, huobao_source_hash: built.sourceHash } } } : {}),
    }),
  })
  if (!result.prompt_id) throw new Error('ComfyUI 未返回 prompt_id')
  return String(result.prompt_id)
}

export function parseComfyHistory(config: ComfyConnection, history: any, promptId: string, outputNode: string, type: 'image' | 'video') {
  const task = history[promptId]
  if (!task) return { status: 'processing' as const }
  const errors = task.status?.messages?.filter((m: any) => ['execution_error', 'execution_interrupted'].includes(m[0])) || []
  if (task.status?.status_str === 'error' || errors.length) {
    const detail = errors[0]?.[1]
    return { status: 'failed' as const, error: `ComfyUI ${detail?.node_type || ''}: ${detail?.exception_message || '工作流执行失败或已中断'}` }
  }
  if (!task.status?.completed) return { status: 'processing' as const }
  const output = task.outputs?.[outputNode]
  const files = [...(output?.images || []), ...(output?.gifs || []), ...(output?.videos || [])]
  const file = files.find((f: any) => type === 'video' ? /\.(mp4|webm)$/i.test(f.filename || '') : /\.(png|jpe?g|webp)$/i.test(f.filename || ''))
  if (!file) return { status: 'failed' as const, error: `ComfyUI 输出节点 ${outputNode} 没有可用的${type === 'video' ? 'MP4/WebM 视频' : '图片'}，请检查保存节点` }
  const url = new URL(comfyUrl(config.baseUrl, '/view'))
  url.search = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' }).toString()
  return { status: 'completed' as const, url: url.toString() }
}

export async function pollComfyWorkflow(config: ComfyConnection, promptId: string, outputNode: string, type: 'image' | 'video') {
  return parseComfyHistory(config, await requestJson(config, `/history/${encodeURIComponent(promptId)}`), promptId, outputNode, type)
}

/** Verify required nodes and installed model/LoRA names without submitting a generation. */
export async function checkComfyWorkflow(config: ComfyConnection, type: 'image' | 'video') {
  await requestJson(config, '/system_stats')
  const info = await requestJson(config, '/object_info')
  const models = config.model === 'wf-image' && !config.comfyui?.workflow ? ['wf-z-image', 'wf-z-scene', 'wf-qwen-image'] : [config.model]
  const missing: string[] = []
  for (const model of models) {
    const refs = model === 'wf-qwen-image' && !config.comfyui?.workflow ? ['connection-test.png'] : []
    const built = buildComfyWorkflow({ ...config, model }, type, { prompt: 'connection test' }, refs)
    for (const [id, node] of Object.entries(built.workflow)) {
      const schema = info[node.class_type]
      if (!schema) { missing.push(`节点 ${node.class_type}`); continue }
      for (const key of ['unet_name', 'clip_name', 'vae_name', 'lora_name', 'ckpt_name', ...(node.class_type.startsWith('SeedVR2Load') ? ['model'] : [])]) {
        const value = node.inputs[key]
        const spec = schema.input?.required?.[key] || schema.input?.optional?.[key]
        const options = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options
        if (typeof value === 'string' && Array.isArray(options) && !options.includes(value)) missing.push(`${key}: ${value}`)
      }
      for (const [key, value] of Object.entries(node.inputs)) {
        if (Array.isArray(value) && (!built.workflow[value[0]] || !Number.isInteger(value[1]))) missing.push(`节点 ${id}.${key} 连线无效`)
      }
    }
  }
  if (missing.length) throw new Error(`ComfyUI 缺少：${[...new Set(missing)].join('；')}`)
  return 'ComfyUI 已连接，工作流所需节点和模型已找到（未执行生成）'
}
