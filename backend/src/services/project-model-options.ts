import { and, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from '../db/index.js'
import { isMidjourneyImagine } from './adapters/midjourney-image.js'
import { getGlobalDefaultModel, isOfficialProvider } from './ai.js'
import { parseComfySettings } from './comfyui.js'
import { assertImageMode } from './media-selection.js'

export const projectModelKind = z.enum(['text', 'image'])
export const projectModelSelection = z.object({
  configId: z.number().int().positive(), model: z.string().min(1).max(500),
})
export type ProjectModelKind = z.infer<typeof projectModelKind>
export type ProjectModelSelection = z.infer<typeof projectModelSelection>
export type ProjectModelOption = ProjectModelSelection & { kind: ProjectModelKind; configName: string }

export function projectModelOptions(filters: { configId?: number; imageMode?: 'text' | 'reference'; midjourneyImagineOnly?: boolean } = {}): ProjectModelOption[] {
  const configs = schema.aiServiceConfigs
  const rows = db.select({
    id: configs.id, name: configs.name, serviceType: configs.serviceType,
    provider: configs.provider, baseUrl: configs.baseUrl, model: configs.model, settings: configs.settings,
  }).from(configs).where(and(eq(configs.isActive, true), inArray(configs.serviceType, projectModelKind.options),
    filters.configId === undefined ? undefined : eq(configs.id, filters.configId)))
    .orderBy(desc(configs.priority), configs.id).all()

  const options = rows.flatMap(row => {
    const kind = row.serviceType as ProjectModelKind
    const provider = row.provider || ''
    if (!isOfficialProvider(kind, provider) || (filters.midjourneyImagineOnly && kind !== 'image')) return []
    let models: unknown
    try { models = JSON.parse(row.model ?? '[]') } catch { return [] }
    if (!Array.isArray(models)) return []
    const comfyui = kind === 'image' && filters.imageMode ? parseComfySettings(row.settings) : undefined
    return [...new Set(models)].flatMap(model => {
      if (typeof model !== 'string' || !model.trim()) return []
      if (filters.midjourneyImagineOnly && !isMidjourneyImagine({ provider, baseUrl: row.baseUrl, model })) return []
      if (kind === 'image' && filters.imageMode) {
        try { assertImageMode({ provider, baseUrl: row.baseUrl, model, comfyui }, filters.imageMode) }
        catch { return [] }
      }
      return [{ kind, configId: row.id, model, configName: row.name }]
    })
  })
  const defaults = { text: getGlobalDefaultModel('text'), image: getGlobalDefaultModel('image') }
  const isDefault = (option: ProjectModelOption) => defaults[option.kind]?.configId === option.configId && defaults[option.kind]?.model === option.model
  // If a default is not eligible for a filtered view, preserve the view's existing order.
  return options.sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)))
}
