/**
 * 文件存储工具 — 下载远程文件到本地
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { v4 as uuid } from 'uuid'
import { STORAGE_ROOT } from './paths.js'
import { recordedFetch as fetch } from '../services/api-call-log.js'

/** 响应头和完整图片共用下载时限。 */
export async function downloadImage(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {})
    throw new Error(`Download failed: ${resp.status}`)
  }
  return Buffer.from(await resp.arrayBuffer())
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
 * 为已落盘图片生成列表页缩略图（宽 400 WebP，与原图同目录）。
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
  return sharp(source).rotate().resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 })
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
