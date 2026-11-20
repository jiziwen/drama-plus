import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { Hono } from 'hono'
import { getMimeType } from 'hono/utils/mime'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'

export const SIGNED_REFERENCE_MEDIA_PATH = '/reference-media'
const URL_PREFIX = '/api/v1' + SIGNED_REFERENCE_MEDIA_PATH
const TTL_SECONDS = 24 * 60 * 60
const KEY_FILE = path.join(DATA_ROOT, '.reference-media-signing-key')
const referenceMimeTypes: Record<string, string> = {
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac',
  '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.md': 'text/markdown; charset=utf-8',
}
let cachedKey: Buffer | undefined

export function signedReferenceMediaEnabled(): boolean {
  return process.env.PUBLIC_MEDIA_SIGNED_URLS?.trim().toLowerCase() === 'true'
}

function signingKey(create: boolean): Buffer {
  if (cachedKey) return cachedKey
  try {
    const key = readFileSync(KEY_FILE)
    if (key.length !== 32) throw new Error('参考素材签名密钥文件无效')
    return cachedKey = key
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  mkdirSync(DATA_ROOT, { recursive: true })
  const temporary = `${KEY_FILE}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx' })
    // Publishing a complete file without replacing a competing process's key.
    try { linkSync(temporary, KEY_FILE) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  } finally {
    rmSync(temporary, { force: true })
  }
  return signingKey(false)
}

function checkedPath(value: string): string {
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment.startsWith('.') || /[\\:%?#\x00-\x1f\x7f]/u.test(segment))) {
    throw new Error('参考素材路径无效')
  }
  return segments.join('/')
}

function existingPath(relative: string): string {
  const root = realpathSync(STORAGE_ROOT)
  const file = realpathSync(path.join(root, relative))
  const resolved = path.relative(root, file)
  if (!resolved || resolved === '..' || resolved.startsWith(`..${path.sep}`) || path.isAbsolute(resolved)) {
    throw new Error('参考素材路径超出存储目录')
  }
  checkedPath(resolved.split(path.sep).join('/'))
  if (!statSync(file).isFile()) throw new Error('参考素材文件不存在')
  return file
}

function signature(relative: string, expires: number, create: boolean): Buffer {
  return createHmac('sha256', signingKey(create)).update(`${expires}\n${relative}`).digest()
}

export function createSignedReferenceMediaUrl(baseUrl: string, staticPath: string): string {
  if (!/^\/?static\//u.test(staticPath)) throw new Error('参考素材需要项目内的静态文件')
  const relative = checkedPath(staticPath.replace(/^\/?static\//u, ''))
  existingPath(relative)
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS
  const url = new URL(baseUrl)
  const encoded = relative.split('/').map(encodeURIComponent).join('/')
  url.pathname = url.pathname.replace(/\/+$/u, '') + URL_PREFIX + '/' + encoded
  url.search = new URLSearchParams({ expires: String(expires), signature: signature(relative, expires, true).toString('hex') }).toString()
  return url.toString()
}

function authorizedPath(requestUrl: string): string {
  const url = new URL(requestUrl)
  if (!url.pathname.startsWith(URL_PREFIX + '/')) throw new Error('参考素材路径无效')
  const relative = checkedPath(decodeURIComponent(url.pathname.slice(URL_PREFIX.length + 1)))
  const expires = Number(url.searchParams.get('expires'))
  const signed = url.searchParams.get('signature') || ''
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + TTL_SECONDS || !/^[\da-f]{64}$/u.test(signed)) throw new Error('无效的参考素材签名')
  if (!timingSafeEqual(Buffer.from(signed, 'hex'), signature(relative, expires, false))) throw new Error('无效的参考素材签名')
  return existingPath(relative)
}

function readRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  const first = Number(match[1]), last = Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return null
  const start = match[1] ? first : Math.max(0, size - last)
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1
  return start <= end ? { start, end } : null
}

export const signedReferenceMediaRoutes = new Hono()
signedReferenceMediaRoutes.get('/*', async c => {
  if (!signedReferenceMediaEnabled()) return c.notFound()
  let local: string
  let file: Awaited<ReturnType<typeof open>>
  try {
    local = authorizedPath(c.req.url)
    file = await open(local, 'r')
  } catch { return c.notFound() }
  let streaming = false
  try {
    const stat = await file.stat()
    if (!stat.isFile()) return c.notFound()
    c.header('Content-Type', referenceMimeTypes[path.extname(local).toLowerCase()] || getMimeType(local) || 'application/octet-stream')
    c.header('Cache-Control', 'private, no-store')
    c.header('Content-Security-Policy', 'sandbox')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Accept-Ranges', 'bytes')
    const range = c.req.method === 'GET' ? c.req.header('Range') : undefined
    const part = range ? readRange(range, stat.size) : null
    if (range && !part) {
      c.header('Content-Range', `bytes */${stat.size}`)
      return c.body(null, 416)
    }
    if (part) c.header('Content-Range', `bytes ${part.start}-${part.end}/${stat.size}`)
    c.header('Content-Length', String(part ? part.end - part.start + 1 : stat.size))
    if (c.req.method === 'HEAD' || stat.size === 0) return c.body(null, 200)
    const stream = Readable.toWeb(file.createReadStream(part || undefined)) as ReadableStream<Uint8Array>
    streaming = true
    return c.body(stream, part ? 206 : 200)
  } finally {
    // The returned stream owns its descriptor. All other paths close it here.
    if (!streaming) await file.close()
  }
})
