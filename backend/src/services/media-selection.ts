import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { getActiveConfig, getConfigById, type AIConfig } from './ai.js'

type MediaType = 'image' | 'video'
type Selection = { model?: string | null; configId?: number | null }

/** Explicit choices never fall through to a different provider or billing account. */
export async function resolveMediaConfig(type: MediaType, selection: Selection): Promise<AIConfig> {
  if (selection.model != null && typeof selection.model !== 'string') throw new Error('模型必须为字符串')
  if (selection.configId != null && (!Number.isSafeInteger(selection.configId) || selection.configId <= 0)) throw new Error('模型配置 ID 无效')
  const config = selection.configId != null ? await getConfigById(selection.configId) : await getActiveConfig(type)
  if (!config?.id) throw new Error(selection.configId != null ? '所选模型配置已删除或停用，请重新选择' : `未配置${type === 'image' ? '图片' : '视频'}模型，请先在设置中启用服务`)
  const [row] = await db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, config.id))
  if (row.serviceType !== type) throw new Error(`所选配置不是${type === 'image' ? '图片' : '视频'}服务`)
  let models: unknown
  try { models = JSON.parse(row.model || '[]') } catch { models = [] }
  const model = selection.model?.trim() || config.model
  if (!Array.isArray(models) || !models.includes(model)) throw new Error('所选模型不在该服务配置中，请重新选择')
  return { ...config, model }
}

export function validateReferenceImages(value: unknown, required = false): string[] {
  if (!Array.isArray(value) || value.length > 4 || (required && !value.length)) throw new Error('参考图须为 1–4 张图片（草稿允许清空）')
  return value.map(url => {
    if (typeof url !== 'string' || !url.trim()) throw new Error('参考图地址不能为空')
    const source = url.trim()
    if (!/^(?:https?:\/\/|\/?static\/|data:image\/(?:png|jpeg|webp);base64,)/i.test(source)) throw new Error('参考图必须是项目图片、HTTP(S)图片或图片 data URL')
    if (/^\/?static\//.test(source) && (source.includes('..') || source.includes('\\'))) throw new Error('参考图路径无效')
    return source
  })
}

export function assertImageMode(config: AIConfig, mode: 'text' | 'reference') {
  if (config.provider === 'comfyui') {
    if (config.comfyui?.workflow) {
      if (mode === 'reference' && (!config.comfyui.referenceNode || !config.comfyui.referencePrefix || config.comfyui.maxReferences === 0)) throw new Error('所选自定义工作流未配置参考图输入')
    } else if (mode === 'reference' && !['wf-image', 'wf-qwen-image'].includes(config.model)) {
      throw new Error('所选模型只支持文生图，请选择自动生图或三视图编辑工作流')
    } else if (mode === 'text' && config.model === 'wf-qwen-image') {
      throw new Error('三视图编辑工作流需要参考图，请从「参考图重绘」进入')
    }
  } else if (mode === 'reference' && config.provider === 'volcengine') {
    throw new Error('当前火山图片适配器暂不支持参考图编辑，请选择支持图片编辑的模型')
  } else if (mode === 'reference' && config.provider === 'openai' && /^dall-e/i.test(config.model)) {
    throw new Error('所选 DALL-E 模型不支持此参考图编辑，请选择 GPT Image')
  }
}

type AssetSelection = { imageModel?: string | null; imageConfigId?: number | null; referenceModel?: string | null; referenceConfigId?: number | null }
export async function resolveAssetImageRequest(body: any, asset: AssetSelection, episodeConfigId?: number | null) {
  const mode = body.generation_mode ?? 'text'
  if (mode !== 'text' && mode !== 'reference') throw new Error('generation_mode 必须为 text 或 reference')
  const referenceImages = mode === 'reference' ? validateReferenceImages(body.reference_images, true) : []
  const editPrompt = mode === 'reference' && typeof body.edit_prompt === 'string' ? body.edit_prompt.trim() : ''
  if (mode === 'reference' && !editPrompt) throw new Error('请填写修改描述')
  const model = mode === 'reference' ? asset.referenceModel : asset.imageModel
  const configId = mode === 'reference' ? asset.referenceConfigId : asset.imageConfigId
  const override = !!model || configId != null
  const config = await resolveMediaConfig('image', override
    ? { model, configId }
    : { model: body.model, configId: body.config_id ?? episodeConfigId })
  assertImageMode(config, mode)
  if (mode === 'reference' && config.comfyui?.workflow && referenceImages.length > (config.comfyui.maxReferences ?? 4)) throw new Error('参考图数量超过该工作流限制')
  return { mode, editPrompt, referenceImages, model: config.model, configId: config.id! }
}

/** Sparse PUT: an empty/null model clears the pair; config-only changes validate the retained model. */
export async function mediaSelectionPatch(body: any, current: Record<string, any>, prefix: 'image' | 'reference' | 'video') {
  const modelKey = `${prefix}_model`, configKey = `${prefix}_config_id`
  const camelModel = `${prefix}Model`, camelConfig = `${prefix}ConfigId`
  if (!(modelKey in body) && !(configKey in body)) return {}
  const model = modelKey in body ? body[modelKey] : current[camelModel]
  const configId = configKey in body ? body[configKey] : current[camelConfig]
  if ((modelKey in body && (model == null || model === '')) || (configKey in body && configId == null)) return { [camelModel]: null, [camelConfig]: null }
  if (typeof model !== 'string' || !model.trim() || configId == null) throw new Error('选择模型时须同时提供模型名和所属配置')
  const config = await resolveMediaConfig(prefix === 'video' ? 'video' : 'image', { model, configId })
  if (prefix !== 'video') assertImageMode(config, prefix === 'reference' ? 'reference' : 'text')
  return { [camelModel]: config.model, [camelConfig]: config.id }
}

export async function assetMediaPatch(body: any, current: Record<string, any>) {
  const patch: Record<string, any> = { ...await mediaSelectionPatch(body, current, 'image'), ...await mediaSelectionPatch(body, current, 'reference') }
  if ('reference_images' in body) patch.referenceImages = JSON.stringify(validateReferenceImages(body.reference_images ?? []))
  if ('edit_prompt' in body) {
    if (body.edit_prompt != null && typeof body.edit_prompt !== 'string') throw new Error('修改描述必须为文字')
    patch.editPrompt = body.edit_prompt || null
  }
  return patch
}
