/**
 * 文件存储工具 — 下载远程文件到本地
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { Agent } from 'undici'
import { v4 as uuid } from 'uuid'
import { STORAGE_ROOT } from './paths.js'
import { recordedFetch as fetch } from '../services/api-call-log.js'

const IMAGE_DOWNLOAD_TIMEOUT_MS = 120_000
const DIRECT_IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000
const MJ_RESULT_CDN = 'https://mjcn-midjourney.googlec.cc'
const proxyTransportErrors = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND',
  'ERR_SSL_UNEXPECTED_EOF_WHILE_READING', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])
let directImageDispatcher: Agent | undefined

function canRetryMidjourneyResultDirectly(url: string): boolean {
  const result = URL.parse(url)
  if (result?.origin !== MJ_RESULT_CDN || result.username || result.password) return false
  const proxyFlag = [...(process.env.NODE_OPTIONS || '').split(/\s+/u), ...process.execArgv]
    .filter(flag => flag === '--use-env-proxy' || flag === '--no-use-env-proxy').at(-1)
  if (!(proxyFlag ? proxyFlag === '--use-env-proxy' : process.env.NODE_USE_ENV_PROXY === '1')) return false
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY
  if (!httpsProxy && !httpProxy) return false

  const noProxy = (process.env.no_proxy ?? process.env.NO_PROXY ?? '').trim().toLowerCase()
  return noProxy !== '*' && !noProxy.split(/[,\s]+/u).some(entry => {
    const host = entry.match(/^(?:\*?\.)?([^:]+)(?::443)?$/u)?.[1]
    return host && (result.hostname === host || result.hostname.endsWith('.' + host))
  })
}

function isProxyTransportError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth === 5) return false
  const { name, code, cause } = error as { name?: string; code?: string; cause?: unknown }
  return name === 'TimeoutError' || name === 'AbortError' || proxyTransportErrors.has(code || '') ||
    (error instanceof AggregateError && error.errors.some(item => isProxyTransportError(item, depth + 1))) ||
    isProxyTransportError(cause, depth + 1)
}

/** 响应头和完整图片共用下载时限。 */
export async function downloadImage(url: string, options: { headers?: Record<string, string>; midjourneyResult?: boolean } = {}): Promise<Buffer> {
  const retryDirect = options.midjourneyResult && !options.headers && canRetryMidjourneyResultDirectly(url)
  async function download(timeoutMs: number, dispatcher?: Agent) {
    const request = { headers: options.headers, signal: AbortSignal.timeout(timeoutMs),
      ...(dispatcher && { dispatcher, redirect: 'error' as const }) }
    const resp = await fetch(url, request)
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => {})
      throw new Error(`Download failed: ${resp.status}`)
    }
    return Buffer.from(await resp.arrayBuffer())
  }

  try {
    return await download(IMAGE_DOWNLOAD_TIMEOUT_MS - (retryDirect ? DIRECT_IMAGE_DOWNLOAD_TIMEOUT_MS : 0))
  } catch (error) {
    if (!retryDirect || !isProxyTransportError(error)) throw error
    // Keep the direct attempt on the original public CDN; redirects use the normal proxy path only.
    directImageDispatcher ??= new Agent({ connect: { timeout: 8_000 }, autoSelectFamily: true })
    return download(DIRECT_IMAGE_DOWNLOAD_TIMEOUT_MS, directImageDispatcher)
  }
}

/**
 * 保存上传的文件
 */
export async function saveUploadedFile(data: ArrayBuffer | Buffer, subDir: string, originalName: string): Promise<string> {
  const dir = path.join(STORAGE_ROOT, subDir)
  await fs.promises.mkdir(dir, { recursive: true })

  const ext = path.extname(originalName) || '.bin'
  const filename = `${uuid()}${ext}`
  const filePath = path.join(dir, filename)

  try {
    await fs.promises.writeFile(filePath, Buffer.isBuffer(data) ? data : Buffer.from(data))
  } catch (error) {
    await fs.promises.rm(filePath, { force: true }).catch(() => {})
    throw error
  }
  return `static/${subDir}/${filename}`
}

/**
 * 获取本地文件的绝对路径
 */
export function getAbsolutePath(relativePath: string): string {
  if (relativePath.startsWith('static/')) {
    return path.join(STORAGE_ROOT, '..', relativePath)
  }
  return path.join(STORAGE_ROOT, relativePath)
}

/** 由图片相对路径推导缩略图路径：static/images/x.png → static/images/x_thumb.webp */
export function thumbPathFor(relativePath: string): string {
  return relativePath.replace(/\.[^./]+$/, '_thumb.webp')
}

/**
 * 为已落盘图片生成列表页缩略图（最长边 400 的 WebP，与原图同目录）。
 * 失败（文件损坏/格式异常等）返回 null，不阻断主流程。
 */
export async function generateImageThumb(relativePath: string, thumbnail?: Buffer): Promise<string | null> {
  try {
    const thumbRel = thumbPathFor(relativePath)
    const destination = getAbsolutePath(thumbRel)
    if (thumbnail) await fs.promises.writeFile(destination, thumbnail)
    else await imageThumbnail(getAbsolutePath(relativePath)).toFile(destination)
    return thumbRel
  } catch (err) {
    console.warn(`[storage] 缩略图生成失败 ${relativePath}:`, (err as Error).message)
    return null
  }
}

export function imageThumbnail(source: string | Buffer) {
  return sharp(source).rotate().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 })
}

const thumbnailJobs = new Map<string, Promise<Buffer>>()

/** Resolve a stored image and fill in missing derivatives without returning the original. */
export async function readStoredImageThumbnail(urlPath: string): Promise<Buffer | null> {
  const relative = urlPath.match(/^\/?static\/(.+)$/u)?.[1]
  if (!relative || /_thumb\.webp$/iu.test(relative) || !/\.(?:avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/iu.test(relative) ||
      /[\\\u0000-\u001f]/u.test(relative) || relative.split('/').some(part => !part || part.startsWith('.'))) return null

  try {
    const root = await fs.promises.realpath(STORAGE_ROOT)
    const source = await fs.promises.realpath(path.join(root, relative))
    if (!source.startsWith(root + path.sep)) return null
    const original = await fs.promises.stat(source)
    if (!original.isFile()) return null

    const destination = thumbPathFor(source)
    const cached = await fs.promises.lstat(destination).catch(() => null)
    if (cached?.isFile() && cached.size && cached.mtimeMs >= original.mtimeMs) {
      return await fs.promises.readFile(destination)
    }

    const active = thumbnailJobs.get(destination)
    if (active) return await active
    const work = (async () => {
      const thumbnail = await imageThumbnail(source).toBuffer()
      const temp = `${destination}.${uuid()}.tmp`
      try {
        await fs.promises.writeFile(temp, thumbnail, { flag: 'wx' })
        await fs.promises.rename(temp, destination)
      } catch {
        // Return the generated preview even if the disk cache is unavailable.
        await fs.promises.rm(temp, { force: true }).catch(() => {})
      }
      return thumbnail
    })().finally(() => thumbnailJobs.delete(destination))
    thumbnailJobs.set(destination, work)
    return await work
  } catch {
    return null
  }
}

export function readImageAsDataUrl(relativePath: string): string {
  const filePath = getAbsolutePath(relativePath)
  const buffer = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()
  const mimeType = extToMimeType(ext)
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

export async function readImageAsCompressedDataUrl(
  relativePath: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  return compressImageAsDataUrl(getAbsolutePath(relativePath), options)
}

/**
 * 下载远程图片并压缩为 data URL（远程参考图归一化，供 multipart/base64 上传类厂商使用）
 */
export async function fetchImageAsCompressedDataUrl(
  url: string,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!resp.ok) throw new Error(`下载参考图失败: HTTP ${resp.status}`)
  return compressImageAsDataUrl(Buffer.from(await resp.arrayBuffer()), options)
}

/** sharp 输入 → 压缩 JPEG data URL（本地路径与远程下载共享同一压缩管线） */
async function compressImageAsDataUrl(
  input: string | Buffer,
  options: {
    maxWidth?: number
    maxHeight?: number
    quality?: number
  } = {},
): Promise<string> {
  const maxWidth = options.maxWidth ?? 768
  const maxHeight = options.maxHeight ?? 768
  const quality = options.quality ?? 68

  const resized = sharp(input).rotate().resize({
    width: maxWidth,
    height: maxHeight,
    fit: 'inside',
    withoutEnlargement: true,
  })
  const metadata = await resized.metadata()
  const output = metadata.hasAlpha
    ? await resized.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
    : await resized.jpeg({ quality, mozjpeg: true }).toBuffer()
  const mimeType = 'image/jpeg'
  return `data:${mimeType};base64,${output.toString('base64')}`
}

export function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  return {
    mimeType: match[1],
    data: match[2],
  }
}

function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  }
  return map[ext] || 'image/png'
}
