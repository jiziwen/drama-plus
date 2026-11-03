/**
 * 风格预设服务 — 读取项目绑定的视觉风格提示词
 * dramas.style 存 style_presets.value；查不到/已停用时返回空串（调用方走兜底）
 */
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

/** 系统／用户配置的风格描述原样拼接，英文风格词无需翻译或中文校验。 */
export async function getDramaStylePrompt(dramaId: number | null | undefined): Promise<string> {
  if (!dramaId) return ''
  const [drama] = await db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId))
  if (!drama?.style) return ''
  const [preset] = await db.select().from(schema.stylePresets)
    .where(and(eq(schema.stylePresets.value, drama.style), eq(schema.stylePresets.isActive, true)))
  return preset?.prompt || ''
}
