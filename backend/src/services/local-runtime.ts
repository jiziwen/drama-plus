import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { DATA_ROOT } from '../utils/paths.js'

const dir = path.join(DATA_ROOT, 'local-runtime')
export const localRuntimeSupported = process.env.HUOBAO_LOCAL_RUNTIME_ENABLED === 'true'
const key = 'comfyui_auto_start'
export function localRuntimeEnabled() {
  const setting = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()
  return localRuntimeSupported && setting?.value !== 'false'
}
export function configureLocalRuntime(enabled: boolean) {
  db.insert(schema.appSettings).values({ key, value: String(enabled), updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: String(enabled), updatedAt: new Date().toISOString() } }).run()
}
export async function localRuntimeStatus(): Promise<Record<string, any>> {
  try {
    const state = JSON.parse(await fs.readFile(path.join(dir, 'status.json'), 'utf8'))
    return { ...state, available: Date.now() - Date.parse(state.updatedAt) < 20_000 }
  } catch { return { available: false, status: 'offline' } }
}
export async function requestComfyStartup(): Promise<Record<string, any>> {
  if (!localRuntimeEnabled()) return { started: false, enabled: false }
  const state = await localRuntimeStatus()
  if (!state.available) return { started: false, available: false, message: '本机启动助手未运行，请使用“小李短剧”快捷方式打开' }
  if (state.status === 'ready' || state.status === 'starting') return { started: state.status === 'starting', ...state }
  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'request.json')
  try {
    const previous = JSON.parse(await fs.readFile(target, 'utf8'))
    if (Date.now() - Date.parse(previous.createdAt) < 30_000) return { started: true, status: 'starting' }
  } catch {}
  const temporary = path.join(dir, `request-${randomUUID()}.tmp`)
  await fs.writeFile(temporary, JSON.stringify({ id: randomUUID(), action: 'start-comfyui', createdAt: new Date().toISOString() }))
  await fs.rename(temporary, target)
  return { started: true, status: 'starting' }
}

export async function waitForLocalComfy(baseUrl: string) {
  if (!localRuntimeEnabled()) return
  const url = new URL(baseUrl)
  if (!['host.docker.internal', '127.0.0.1', 'localhost'].includes(url.hostname)) return
  const state = await localRuntimeStatus()
  if (Number(url.port || 80) !== Number(state.port || 8188)) return
  const requested = await requestComfyStartup()
  if (requested.available === false) throw new Error(requested.message)
  if (requested.status === 'ready') return
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const current = await localRuntimeStatus()
    if (!current.available) throw new Error('本机启动助手离线，请使用桌面小李快捷方式重新打开')
    if (current.status === 'ready') return
    if (current.status === 'error') throw new Error(`ComfyUI 启动失败：${current.error || '请检查整合包日志'}`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  throw new Error('等待 ComfyUI 启动超时，请查看设置 → 通用 → 本地 ComfyUI 联动启动')
}
