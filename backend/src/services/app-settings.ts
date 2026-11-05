/**
 * 应用级全局设置（app_settings key-value 表）
 * 内容语言固定为简体中文；保留设置接口兼容旧客户端
 * 层次约束：本模块只依赖 db，严禁反向 import agents/*
 *
 * 注意：刻意做成同步 API（better-sqlite3 驱动的 .get()/.run()），
 * 供 agents/context.ts 的同步 buildAgentRequestContext 内部直接调用
 */
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'

export const CONTENT_LANGUAGES = ['zh'] as const
export type ContentLanguage = 'zh'

/** 旧数据库中的语言设置不再影响内容生成。 */
export function getContentLanguage(): ContentLanguage { return 'zh' }
export function setContentLanguage(lang: ContentLanguage): ContentLanguage {
  if (lang !== 'zh') throw new Error(`Invalid content language: ${lang}`)
  return 'zh'
}

const TOURS_SEEN_KEY = 'tours_seen'
const MAX_TOURS_SEEN = 64

function sanitizeTourIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter(v => typeof v === 'string' && v.length > 0 && v.length <= 100))].slice(0, MAX_TOURS_SEEN)
}

/** 已看过的引导漫游 id 列表（JSON 数组存储）；桌面端端口随启动变化，localStorage 不可靠，故落库 */
export function getToursSeen(): string[] {
  const row = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, TOURS_SEEN_KEY))
    .get()
  try { return sanitizeTourIds(JSON.parse(row?.value || '[]')) } catch { return [] }
}

/** 写入已看过的引导漫游 id 列表（upsert） */
export function setToursSeen(ids: unknown): string[] {
  const clean = sanitizeTourIds(ids)
  const value = JSON.stringify(clean)
  db.insert(schema.appSettings)
    .values({ key: TOURS_SEEN_KEY, value, updatedAt: now() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value, updatedAt: now() },
    })
    .run()
  return clean
}
