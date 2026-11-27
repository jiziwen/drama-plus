/**
 * AI 服务抽象层 — 从数据库配置中获取 provider 和 API key
 */
import { db, schema } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { logTaskProgress, logTaskWarn } from '../utils/task-logger.js'
import { joinProviderUrl } from './adapters/url.js'
import { parseComfySettings, type ComfySettings } from './comfyui.js'

export type ServiceType = 'text' | 'image' | 'video'

export interface AIConfig {
  id?: number
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  videoCliAccountId?: string
  comfyui?: ComfySettings
  /** 采样温度，null 表示不设置（跟随服务商默认）。存于 ai_service_configs.settings JSON */
  temperature?: number | null
}

/** 从 settings JSON 解析 temperature；非法值一律视为未设置 */
export function parseConfigTemperature(settingsRaw: string | null | undefined): number | null {
  if (!settingsRaw) return null
  try {
    const t = JSON.parse(settingsRaw)?.temperature
    return typeof t === 'number' && Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

export const officialProviders: Record<ServiceType, readonly string[]> = {
  text: ['openai', 'gemini', 'volcengine', '302ai'],
  image: ['openai', 'gemini', 'volcengine', 'comfyui', 'midjourney', '302ai'],
  video: ['volcengine', 'minimax', 'aliyun', 'comfyui', 'aicost', 'jimeng', 'libtv', '302ai'],
}

export function isOfficialProvider(serviceType?: string | null, provider?: string | null): boolean {
  const providers = officialProviders[serviceType as ServiceType]
  return !!providers && providers.includes((provider || '').toLowerCase())
}

type ConfigRow = typeof schema.aiServiceConfigs.$inferSelect
export type GlobalModelSelection = { configId: number; model: string }

export function configModels(model: string | null): string[] {
  try {
    const models: unknown = JSON.parse(model || '[]')
    return Array.isArray(models) ? models.filter((item): item is string => typeof item === 'string' && !!item.trim()) : []
  } catch { return [] }
}

/** CLI-only video providers require workflow-specific authorization and inputs. */
export function isGlobalDefaultEligible(row: ConfigRow, type: ServiceType): boolean {
  return row.serviceType === type && !!row.isActive && isOfficialProvider(type, row.provider) &&
    !(type === 'video' && ['jimeng', 'libtv'].includes((row.provider || '').toLowerCase())) &&
    configModels(row.model).length > 0
}

const defaultKey = (type: ServiceType) => `global_default_model:${type}`

/** Resolve a stored choice against current configuration, or fall back deterministically. */
export function getGlobalDefaultModel(type: ServiceType): GlobalModelSelection | null {
  const rows = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.serviceType, type)).all()
    .filter(row => isGlobalDefaultEligible(row, type))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id)
  const stored = db.select({ value: schema.appSettings.value }).from(schema.appSettings)
    .where(eq(schema.appSettings.key, defaultKey(type))).get()
  try {
    const value = JSON.parse(stored?.value || 'null') as Partial<GlobalModelSelection> | null
    const row = rows.find(item => item.id === value?.configId)
    if (row && typeof value?.model === 'string' && configModels(row.model).includes(value.model)) {
      return { configId: row.id, model: value.model }
    }
  } catch { /* unreadable saved choice uses the legacy fallback */ }
  const first = rows[0]
  return first ? { configId: first.id, model: configModels(first.model)[0] } : null
}

/** Set one exact configuration/model pair without changing service priority or model order. */
export function setGlobalDefaultModel(type: ServiceType, selection: GlobalModelSelection): GlobalModelSelection {
  return db.transaction(tx => {
    const row = tx.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, selection.configId)).get()
    if (!row || !isGlobalDefaultEligible(row, type) || !configModels(row.model).includes(selection.model)) {
      throw new Error('所选模型配置不可用或不支持设为全局默认，请重新选择')
    }
    const value = JSON.stringify(selection)
    const updatedAt = new Date().toISOString()
    tx.insert(schema.appSettings).values({ key: defaultKey(type), value, updatedAt })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt } }).run()
    return selection
  }, { behavior: 'immediate' })
}

export function getTextProviderBaseUrl(config: AIConfig) {
  const provider = config.provider.toLowerCase()

  if (provider === 'openai' || provider === '302ai') {
    return joinProviderUrl(config.baseUrl, '/v1', '')
  }

  if (provider === 'gemini') {
    return joinProviderUrl(config.baseUrl, '/v1beta', '')
  }

  if (provider === 'volcengine') {
    return joinProviderUrl(config.baseUrl, '/api/v3', '')
  }

  return config.baseUrl
}

// Agent 多步循环会逐步重复解析同一配置，相同配置只打一次日志避免刷屏
const lastLoggedActiveConfigKey = new Map<string, string>()
const lastLoggedConfigByIdKey = new Map<number, string>()

export async function getActiveConfig(serviceType: ServiceType): Promise<AIConfig | null> {
  const selected = getGlobalDefaultModel(serviceType)
  const active = selected && db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, selected.configId)).get()
  if (!active || !selected) {
    logTaskWarn('AIConfig', 'active-config-missing', { serviceType })
    return null
  }

  const logKey = `${active.id}:${selected.model}`
  if (lastLoggedActiveConfigKey.get(serviceType) !== logKey) {
    lastLoggedActiveConfigKey.set(serviceType, logKey)
    logTaskProgress('AIConfig', 'active-config-selected', {
      serviceType,
      configId: active.id,
      provider: active.provider,
      model: selected.model,
      priority: active.priority,
    })
  }
  return {
    id: active.id,
    provider: active.provider || '',
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: selected.model,
    temperature: parseConfigTemperature(active.settings),
    comfyui: parseComfySettings(active.settings),
  }
}

export async function getTextConfig(): Promise<AIConfig> {
  const config = await getActiveConfig('text')
  if (!config) throw new Error('未配置文本模型，请先到「设置」页添加并启用 AI 服务')
  return config
}

/** 获取指定类型的全局默认配置 ID。 */
export async function getActiveConfigId(serviceType: ServiceType): Promise<number | null> {
  return getGlobalDefaultModel(serviceType)?.configId ?? null
}

export async function getConfigById(id: number): Promise<AIConfig | null> {
  const [row] = await db.select().from(schema.aiServiceConfigs)
    .where(eq(schema.aiServiceConfigs.id, id))
  if (!row || !row.isActive) {
    logTaskWarn('AIConfig', 'config-by-id-missing', { configId: id })
    return null
  }
  if (!isOfficialProvider(row.serviceType as ServiceType, row.provider)) {
    logTaskWarn('AIConfig', 'config-by-id-unsupported-provider', {
      configId: id,
      serviceType: row.serviceType,
      provider: row.provider,
    })
    return null
  }
  const models = configModels(row.model)
  const selected = getGlobalDefaultModel(row.serviceType as ServiceType)
  const model = selected?.configId === id ? selected.model : models[0] || ''
  const logKey = `${row.provider}:${model}:${row.serviceType}`
  if (lastLoggedConfigByIdKey.get(id) !== logKey) {
    lastLoggedConfigByIdKey.set(id, logKey)
    logTaskProgress('AIConfig', 'config-by-id-selected', {
      configId: id,
      provider: row.provider,
      model,
      serviceType: row.serviceType,
    })
  }
  return {
    id: row.id,
    provider: row.provider || '',
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    model,
    videoCliAccountId: row.videoCliAccountId ?? undefined,
    temperature: parseConfigTemperature(row.settings),
    comfyui: parseComfySettings(row.settings),
  }
}
