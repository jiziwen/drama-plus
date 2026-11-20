import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'

export const libtvProjectIdPattern = /^[\da-f]{32}$|^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu
const defaultCanvasName = '小李短剧 · 剧本转视频'

interface Canvas {
  id: string
  name?: string
}

const preparingCanvases = new Map<string, Promise<Canvas>>()
const unsavedCanvases = new Map<string, Canvas>()

export function configuredLibTVCanvas(): Canvas | undefined {
  const id = process.env.LIBTV_PROJECT_ID?.trim()
  if (id && libtvProjectIdPattern.test(id)) return { id }
}

function savedLibTVCanvas(file: string): Canvas | undefined {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<Canvas> | null
    if (saved && typeof saved.id === 'string' && libtvProjectIdPattern.test(saved.id)) {
      return { id: saved.id, name: typeof saved.name === 'string' ? saved.name : undefined }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function accountCanvasFile(accountId: string) {
  const hash = createHash('sha256').update(accountId).digest('hex')
  return path.join(DATA_ROOT, 'libtv', `drama-canvas-${hash}.json`)
}

export function activeLibTVCanvas(accountId: string): Canvas | undefined {
  return configuredLibTVCanvas() ?? savedLibTVCanvas(accountCanvasFile(accountId))
}

export function libtvAccountIdentifier(accountInfo: Record<string, unknown>) {
  const user = accountInfo.user
  if (!user || typeof user !== 'object') return
  const { uuid, id } = user as { uuid?: unknown; id?: unknown }
  if (typeof uuid === 'string' && uuid.trim()) return uuid.trim()
  if (typeof id === 'string' && id.trim()) return id.trim()
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id)
}

async function saveCanvas(canvasFile: string, canvas: Canvas) {
  await mkdir(path.dirname(canvasFile), { recursive: true, mode: 0o700 })
  const temporaryPath = `${canvasFile}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, JSON.stringify(canvas), { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, canvasFile)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

type Invoke = (args: string[]) => Promise<Record<string, unknown>>

async function findLibTVCanvas(invoke: Invoke): Promise<Canvas | undefined> {
  const result = await invoke(['project', 'list', '--name', defaultCanvasName, '--team-id', '0', '--workspace', '0'])
  if (!Array.isArray(result.projectMetaList)) throw new Error('LibTV 未返回可用的画布列表')
  const match = result.projectMetaList.find(item => item && item.name === defaultCanvasName &&
    typeof item.uuid === 'string' && libtvProjectIdPattern.test(item.uuid))
  if (match) return { id: match.uuid, name: defaultCanvasName }
}

async function prepareLibTVCanvas(invoke: Invoke): Promise<Canvas> {
  const existing = await findLibTVCanvas(invoke)
  if (existing) return existing
  try {
    const result = await invoke(['project', 'create', defaultCanvasName, '--team-id', '0', '--workspace', '0'])
    const id = result.uuid ?? result.projectUuid
    if (typeof id === 'string' && libtvProjectIdPattern.test(id)) {
      return { id, name: defaultCanvasName }
    }
  } catch (error) {
    // The request may have reached LibTV even if the CLI did not return a result.
    const recovered = await findLibTVCanvas(invoke).catch(() => undefined)
    if (recovered) return recovered
    throw error
  }
  const created = await findLibTVCanvas(invoke)
  if (!created) throw new Error('LibTV 没有返回可用的画布编号')
  return created
}

/** Provision once per account after official browser authorization completes. */
export async function ensureLibTVCanvas(
  accountId: string,
  invoke: Invoke,
): Promise<Canvas> {
  const existing = activeLibTVCanvas(accountId)
  if (existing) return existing
  const file = accountCanvasFile(accountId)
  const pending = preparingCanvases.get(file)
  if (pending) return pending
  const prepare = (async () => {
    let canvas = unsavedCanvases.get(file)
    if (!canvas) {
      canvas = await prepareLibTVCanvas(invoke)
      unsavedCanvases.set(file, canvas)
    }
    await saveCanvas(file, canvas)
    unsavedCanvases.delete(file)
    return canvas
  })().finally(() => { preparingCanvases.delete(file) })
  preparingCanvases.set(file, prepare)
  return prepare
}
