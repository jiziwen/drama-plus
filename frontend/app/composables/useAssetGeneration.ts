export type AssetGenerationMode = 'text' | 'reference'
export interface AssetModelOption { key: string; model: string; configId: number; provider: string; configName: string }

function models(config: any): string[] {
  if (Array.isArray(config.model)) return config.model.filter((x: unknown) => typeof x === 'string' && x)
  try { const value = JSON.parse(config.model); return Array.isArray(value) ? value : [value] } catch { return config.model ? [config.model] : [] }
}

export function assetModelOptions(configs: any[], mode: AssetGenerationMode = 'text', withReferences = false): AssetModelOption[] {
  const needsReferences = mode === 'reference' || withReferences
  return [...configs].filter(c => c.is_active ?? c.isActive).sort((a, b) => (b.priority || 0) - (a.priority || 0)).flatMap(config =>
    models(config).filter(model => {
      if (config.provider !== 'comfyui') return !needsReferences || (['openai', 'gemini'].includes(config.provider) && !/^dall-e/i.test(model))
      const settings = config.comfyui || {}
      if (settings.workflow) return !needsReferences || !!(settings.referenceNode && settings.referencePrefix && settings.maxReferences !== 0)
      if (mode === 'text' && withReferences) return model === 'wf-image'
      return mode === 'reference' ? ['wf-image', 'wf-qwen-image'].includes(model) : ['wf-image', 'wf-z-image', 'wf-z-scene'].includes(model)
    }).map(model => ({ key: `${config.id}/${model}`, model, configId: Number(config.id), provider: config.provider, configName: config.name || config.provider })))
}

function fields(mode: AssetGenerationMode) { return mode === 'reference' ? ['reference_model', 'reference_config_id', 'referenceModel', 'referenceConfigId'] : ['image_model', 'image_config_id', 'imageModel', 'imageConfigId'] }

export function assetModelKey(item: any, mode: AssetGenerationMode, options: AssetModelOption[] = []): string {
  const [modelField, configField, camelModel, camelConfig] = fields(mode)
  const model = item && modelField in item ? item[modelField] : item?.[camelModel]
  const configId = item && configField in item ? item[configField] : item?.[camelConfig]
  if (!model && !configId) return ''
  return `${configId || 0}/${model || ''}`
}

export function assetModelPatch(key: string, mode: AssetGenerationMode, options: AssetModelOption[]) {
  const [modelField, configField] = fields(mode)
  if (!key) return { [modelField]: null, [configField]: null }
  const option = options.find(o => o.key === key)
  if (!option) throw new Error('已选模型不可用，请重新选择')
  return { [modelField]: option.model, [configField]: option.configId }
}

export function resolveAssetModel(item: any, mode: AssetGenerationMode, options: AssetModelOption[], inheritedKey = ''): { model?: string; configId?: number } {
  const saved = assetModelKey(item, mode, options)
  const key = saved || inheritedKey
  if (!key) return {}
  let option = options.find(o => o.key === key)
  // The top bar historically persisted provider[:configId]/model keys.
  if (!saved && !option) {
    const slash = key.indexOf('/')
    const prefix = key.slice(0, slash)
    const model = slash < 0 ? key : key.slice(slash + 1)
    const matches = options.filter(o => o.model === model && (slash < 0 || prefix === o.provider || prefix === `${o.provider}:${o.configId}`))
    if (matches.length === 1) option = matches[0]
  }
  if (!option) throw new Error('已选模型不支持当前生成方式或已停用，请重新选择')
  return { model: option.model, configId: option.configId }
}

export function assetReferences(item: any): string[] {
  const value = item && 'reference_images' in item ? item.reference_images : item?.referenceImages
  try { const refs = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(refs) ? uniqueAssetReferences(refs).slice(0, 4) : [] } catch { return [] }
}

export function canonicalAssetReference(source: string): string {
  return source.trim().replace(/^\/(?=static\/)/, '')
}

export function uniqueAssetReferences(sources: unknown[]): string[] {
  return [...new Set(sources.filter((source): source is string => typeof source === 'string' && !!source.trim()).map(canonicalAssetReference))]
}

export function assetReferenceSrc(source: string): string {
  return /^(https?:|data:|blob:|\/)/.test(source) ? source : `/${source}`
}
