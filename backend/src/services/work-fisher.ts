import { createHash } from 'node:crypto'
import sourceJson from './work-fisher/source.json'
import type { ComfyConnection, ComfyWorkflow } from './comfyui.js'

// This is the user's unmodified canvas, not a hand-written replacement graph.
export const workFisherSource = sourceJson as any
export const workFisherSourceHash = createHash('sha256').update(JSON.stringify(sourceJson)).digest('hex')
const virtualTypes = new Set(['Reroute', 'Note', 'MarkdownNote', 'Fast Groups Bypasser (rgthree)', '忽略多组孤海'])
export const workFisherModes = {
  'wf-z-image': { group: '角色资产生成编辑', type: 'image', output: '239', prompt: ['248', 'text'], seed: ['235', 'seed'], dimensions: ['251', '252'] },
  'wf-z-scene': { group: '场景资产生成编辑', type: 'image', output: '267', prompt: ['277', 'text'], seed: ['261', 'seed'], dimensions: ['275', '276'] },
  'wf-qwen-image': { group: '三视图生成编辑', type: 'image', output: '212', prompt: ['214', 'prompt'], seed: ['211', 'seed'], selector: '213', reference: '206', prefix: 'images.image_', start: 1, maxReferences: 4 },
  'wf-minimax-h3': { group: '多参生视频编辑', type: 'video', output: '156', prompt: ['138', 'value'], seed: ['129', 'noise_seed'], selector: '115', reference: '136', prefix: 'ref_images.ref_image_', start: 0, maxReferences: 6 },
} as const
type Mode = typeof workFisherModes[keyof typeof workFisherModes]

export function sourceGroupNodes(group: string): any[] {
  const bounds = workFisherSource.groups.find((g: any) => g.title === group)?.bounding
  if (!bounds) throw new Error(`原始工作流分组不存在：${group}`)
  const [x, y, w, h] = bounds
  return workFisherSource.nodes.filter((n: any) => n.pos[0] >= x && n.pos[0] <= x + w && n.pos[1] >= y && n.pos[1] <= y + h)
}

/** Compile every executable node in the selected source group. Only canvas-only nodes
 * are omitted. Reroutes are traversed, never used as a reason to drop a branch. */
export function compileSourceGroup(group: string): ComfyWorkflow {
  const nodes = new Map<string, any>(workFisherSource.nodes.map((n: any) => [String(n.id), n]))
  const links = new Map<number, any[]>(workFisherSource.links.map((l: any[]) => [l[0], l]))
  const selected = sourceGroupNodes(group)
  const selectedIds = new Set(selected.map(n => String(n.id)))
  const resolve = (linkId: number, seen = new Set<number>()): [string, number] => {
    if (seen.has(linkId)) throw new Error(`原始工作流连线循环：${linkId}`)
    seen.add(linkId)
    const link = links.get(linkId)
    if (!link) throw new Error(`原始工作流连线丢失：${linkId}`)
    const upstream = nodes.get(String(link[1]))
    if (!upstream || !selectedIds.has(String(upstream.id))) throw new Error(`连线 ${linkId} 超出模式 ${group}`)
    if (upstream.type === 'Reroute') return resolve(upstream.inputs[0].link, seen)
    return [String(upstream.id), link[2]]
  }
  const graph: ComfyWorkflow = {}
  for (const node of selected) {
    if (virtualTypes.has(node.type)) continue
    const inputs: Record<string, any> = {}
    for (const input of node.inputs || []) {
      if (input.link != null) inputs[input.name] = resolve(input.link)
      else if (input.widget && Object.hasOwn(node.widgets_values_named || {}, input.widget.name)) {
        inputs[input.name] = structuredClone(node.widgets_values_named[input.widget.name])
      }
    }
    graph[String(node.id)] = { class_type: node.type, inputs }
  }
  return graph
}

const ratios: Record<string, string> = {
  '1:1': '1:1 (Square)', '2:3': '2:3 (Portrait Photo)', '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '21:9': '21:9 (Ultrawide)',
}
// Match Python's round() in the original ResolutionSelector, including ties to even.
const roundEven = (n: number) => n % 1 === 0.5 ? 2 * Math.round(n / 2) : Math.round(n)
function selectorSize(inputs: Record<string, any>): [number, number] {
  const [w, h] = String(inputs.aspect_ratio).split(' ')[0].split(':').map(Number)
  const scale = Math.sqrt(inputs.megapixels * 1024 * 1024 / (w * h))
  return [roundEven(w * scale / inputs.multiple) * inputs.multiple, roundEven(h * scale / inputs.multiple) * inputs.multiple]
}

/** Embed an inspectable original canvas with the same active mode and parameter changes. */
function canvasFor(mode: Mode, graph: ComfyWorkflow): any {
  const canvas = structuredClone(workFisherSource)
  const active = new Set(sourceGroupNodes(mode.group).map(n => n.id))
  const byId = new Map<string, any>(canvas.nodes.map((n: any) => [String(n.id), n]))
  for (const node of canvas.nodes) {
    if (node.id !== 226) node.mode = active.has(node.id) ? 0 : 4
    const apiNode = graph[String(node.id)]
    if (!apiNode) { if (!virtualTypes.has(node.type)) node.mode = 4; continue }
    for (const input of node.inputs || []) {
      const value = apiNode.inputs[input.name]
      if (!input.widget || Array.isArray(value) || value === undefined) continue
      const names = Object.keys(node.widgets_values_named || {})
      const index = names.indexOf(input.widget.name)
      if (index >= 0 && Array.isArray(node.widgets_values)) node.widgets_values[index] = value
      if (node.widgets_values_named) node.widgets_values_named[input.widget.name] = value
    }
  }
  const controller = byId.get('226')
  controller.properties.guhai_ig_active_set = [mode.group, ...(mode.group === '角色资产生成编辑' ? ['1SeedVR高清放大（可以关闭）多样性', 'SeedVR 放大开关'] : [])]
  // Reference uploads replace only the source's reference inputs; never its model graph.
  if ('reference' in mode) {
    const target = byId.get(mode.reference)
    const refInputs = target.inputs.filter((i: any) => i.name.startsWith(mode.prefix))
    for (const input of refInputs) {
      if (input.link != null) canvas.links = canvas.links.filter((l: any[]) => l[0] !== input.link)
      input.link = null
    }
    for (const [name, value] of Object.entries(graph[mode.reference].inputs)) {
      if (!name.startsWith(mode.prefix) || !Array.isArray(value)) continue
      let upstream = byId.get(value[0])
      if (!upstream) {
        upstream = { id: Number(value[0]), type: 'LoadImage', pos: [target.pos[0] - 320, target.pos[1] + 200], size: [280, 300], mode: 0, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [] }, { name: 'MASK', type: 'MASK', links: [] }], properties: { 'Node name for S&R': 'LoadImage' }, widgets_values: [graph[value[0]].inputs.image, 'image'], widgets_values_named: { image: graph[value[0]].inputs.image, upload: 'image' } }
        canvas.nodes.push(upstream)
        canvas.last_node_id = Math.max(canvas.last_node_id, upstream.id)
        byId.set(value[0], upstream)
      }
      const slot = target.inputs.findIndex((i: any) => i.name === name)
      if (slot < 0) throw new Error(`原始参考图插槽不存在：${name}`)
      const id = ++canvas.last_link_id
      target.inputs[slot].link = id
      canvas.links.push([id, upstream.id, 0, target.id, slot, 'IMAGE'])
    }
  }
  // Rebuild output link lists after changing reference links.
  for (const node of canvas.nodes) for (let slot = 0; slot < (node.outputs || []).length; slot++) {
    node.outputs[slot].links = canvas.links.filter((l: any[]) => String(l[1]) === String(node.id) && l[2] === slot).map((l: any[]) => l[0])
  }
  return canvas
}

export interface WorkFisherParams {
  prompt: string; size?: string; aspectRatio?: string; duration?: number; seed?: number; assetType?: 'character' | 'scene' | 'prop' | 'storyboard'
}

export function buildWorkFisher(config: ComfyConnection, type: 'image' | 'video', params: WorkFisherParams, references: string[], seed: number) {
  const model = config.model === 'wf-image'
    ? references.length ? 'wf-qwen-image' : params.assetType === 'scene' ? 'wf-z-scene' : 'wf-z-image'
    : config.model
  const mode = workFisherModes[model as keyof typeof workFisherModes]
  if (!mode || mode.type !== type) throw new Error(`不支持的 ComfyUI ${type} 工作流：${config.model}`)
  const workflow = compileSourceGroup(mode.group)
  // API requests bypass browser-side date expansion.
  for (const node of Object.values(workflow)) {
    if (typeof node.inputs.filename_prefix === 'string') node.inputs.filename_prefix = node.inputs.filename_prefix.replace(/%date:yyyy-MM-dd%/g, new Date().toISOString().slice(0, 10))
  }
  const settings = config.comfyui || {}
  // Controlled comparisons documented in docs/image-clarity-debug.md isolate these
  // style LoRAs as the softening source. Keep the source graph, sampler and SeedVR.
  if (settings.characterClarity === true && model === 'wf-z-image' && params.assetType !== 'prop') {
    workflow['240'].inputs.strength_model = 0
    workflow['249'].inputs.strength_model = 0
  }
  if (settings.outputNode && settings.outputNode !== mode.output) throw new Error(`原始模式「${mode.group}」最终输出节点必须为 ${mode.output}，请清除旧 outputNode 设置`)
  workflow[mode.prompt[0]].inputs[mode.prompt[1]] = params.prompt
  workflow[mode.seed[0]].inputs[mode.seed[1]] = seed
  let width: number, height: number
  if ('dimensions' in mode) {
    ;[width, height] = mode.dimensions.map(id => Number(workflow[id].inputs.value))
    const size = settings.width && settings.height ? [settings.width, settings.height] : params.size?.split('x').map(Number)
    if (size) [width, height] = size
    if (!settings.width && settings.maxPixels && width * height > settings.maxPixels) {
      const scale = Math.sqrt(settings.maxPixels / (width * height))
      width = Math.max(32, Math.floor(width * scale / 32) * 32)
      height = Math.max(32, Math.floor(height * scale / 32) * 32)
    }
    workflow[mode.dimensions[0]].inputs.value = width
    workflow[mode.dimensions[1]].inputs.value = height
  } else {
    const selector = workflow[mode.selector].inputs
    if (type === 'video') {
      if (params.aspectRatio) {
        if (!ratios[params.aspectRatio]) throw new Error(`原始尺寸选择器不支持比例 ${params.aspectRatio}`)
        selector.aspect_ratio = ratios[params.aspectRatio]
      }
      if (settings.width && settings.height) selector.megapixels = settings.width * settings.height / 1048576
      else if (settings.maxPixels) selector.megapixels = settings.maxPixels / 1048576
    } else if (settings.width && settings.height) {
      // Explicit user size is an input override, recorded in the embedded canvas too.
      // Keep the original selector; use a budget/ratio that reproduces the selected dimensions.
      const ratio = Object.keys(ratios).find(r => { const [w, h] = r.split(':').map(Number); return Math.abs(w / h - settings.width! / settings.height!) < 0.001 })
      if (!ratio) throw new Error('三视图原始尺寸选择器不支持此宽高比，请使用 16:9、9:16、1:1、4:3 等原生比例')
      selector.aspect_ratio = ratios[ratio]
      selector.megapixels = settings.width * settings.height / 1048576
    } else if (settings.maxPixels) selector.megapixels = settings.maxPixels / 1048576
    ;[width, height] = selectorSize(selector)
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16 || width > 16384 || height > 16384) throw new Error('ComfyUI 尺寸无效')
  const duration = Number(params.duration ?? 5)
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('ComfyUI 视频时长须为 0–60 秒之间')
  let actualDuration = duration
  if (type === 'video') {
    workflow['132'].inputs.value = duration
    const frames = Math.max(5, Math.round(duration * 24))
    actualDuration = Number(((frames + (5 - frames % 17 + 17) % 17) / 24).toFixed(3))
  }
  if ('reference' in mode) {
    const target = workflow[mode.reference]
    const oldIds = Object.entries(target.inputs).filter(([key]) => key.startsWith(mode.prefix)).map(([, value]) => value[0])
    for (const key of Object.keys(target.inputs)) if (key.startsWith(mode.prefix)) delete target.inputs[key]
    for (const id of oldIds) delete workflow[id]
    if (references.length > mode.maxReferences) throw new Error(`该原始模式最多支持 ${mode.maxReferences} 张参考图`)
    if (model === 'wf-qwen-image' && !references.length) throw new Error('三视图生成编辑需要至少一张参考图，不会使用原工作流中的示例图片')
    references.forEach((image, i) => {
      const id = oldIds[i] || String(Number(workFisherSource.last_node_id) + i + 1)
      workflow[id] = { class_type: 'LoadImage', inputs: { image } }
      target.inputs[`${mode.prefix}${i + mode.start}`] = [id, 0]
    })
  } else if (references.length) throw new Error('该原始模式不支持参考图，请选择三视图生成编辑')
  return { workflow, outputNode: mode.output, duration: actualDuration, width, height, preset: `Work-Fisher · ${mode.group}`, sourceHash: workFisherSourceHash, canvasWorkflow: canvasFor(mode, workflow) }
}
