import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { STORAGE_ROOT } from '../utils/paths.js'

// Approximate pixel budgets of Ark's output sizes, independent of reference orientation.
const framePixels: Record<string, number> = {
  '480p': 854 * 480, '720p': 1280 * 720, '1080p': 1920 * 1080, '4k': 3840 * 2160,
}

// libvips reports chromaSubsampling from Cb alone. Ark also checks the Cr
// sampling factor, so inspect all three component descriptors in the SOF header.
async function standardJpegSampling(local: string): Promise<boolean> {
  const file = await fs.open(local)
  const bytes = Buffer.alloc(65536)
  try {
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    let offset = 2
    while (offset + 4 < bytesRead && bytes[offset] === 0xff) {
      while (offset < bytesRead && bytes[offset] === 0xff) offset++
      if (offset + 3 >= bytesRead) break
      const marker = bytes[offset++]
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytesRead) break
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 11) {
        const components = bytes[offset + 7]
        if (components === 1) return true
        return components === 3 && length >= 17 &&
          [0x11, 0x21, 0x22].includes(bytes[offset + 9]) &&
          bytes[offset + 12] === 0x11 && bytes[offset + 15] === 0x11
      }
      if (marker === 0xda) break
      offset += length
    }
    return false
  } finally { await file.close() }
}

/** Keep the original asset and the editor's reference ID. Only the submission copy
 * is resized or encoded with standard JPEG sampling to avoid Ark's decoder issue. */
export async function prepareSeedanceReferenceImage(local: string, originalUrl: string, resolution: string): Promise<string> {
  const image = sharp(local)
  const metadata = await image.metadata()
  const { width, height } = metadata.autoOrient
  if (!width || !height || width / height < 0.4 || width / height > 2.5) {
    throw new Error('参考图宽高比须在 0.4 到 2.5 之间')
  }
  const budget = framePixels[resolution]
  if (!budget) throw new Error('分辨率无效')
  const scale = Math.max(300 / Math.min(width, height), Math.min(1, Math.sqrt(budget / (width * height))))
  const source = await fs.stat(local)
  const extFormat = path.extname(originalUrl).slice(1).toLowerCase().replace(/^jpg$/, 'jpeg')
  if (metadata.format === extFormat && scale === 1 && source.size < 30 * 1024 * 1024 &&
      (metadata.format !== 'jpeg' || await standardJpegSampling(local))) return originalUrl

  const name = createHash('sha256').update(JSON.stringify([originalUrl, source.size, source.mtimeMs, resolution])).digest('hex')
  const ext = metadata.hasAlpha ? 'webp' : 'jpg'
  const relative = `seedance-refs/${name}.${ext}`
  const output = path.join(STORAGE_ROOT, relative)
  if ((await fs.stat(output).catch(() => null))?.size) return '/static/' + relative
  await fs.mkdir(path.dirname(output), { recursive: true })
  const tmp = output + '.' + randomUUID() + '.tmp'
  try {
    const resized = image.autoOrient().resize(Math.round(width * scale), Math.round(height * scale), { fit: 'fill' })
    const encoded = metadata.hasAlpha ? resized.webp({ quality: 94 }) : resized.jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    await encoded.toFile(tmp)
    await fs.rename(tmp, output)
    return '/static/' + relative
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

/** Local voices can go directly to Seedance 2.5 without a publicly hosted audio URL. */
export async function inlineSeedanceVoice(url: string): Promise<string> {
  if (!/^\/?static\/uploads\/[\w-]+\.(?:mp3|wav)$/iu.test(url)) throw new Error('本地声音须是已上传的 MP3 或 WAV')
  const root = await fs.realpath(path.join(STORAGE_ROOT, 'uploads'))
  const local = await fs.realpath(path.join(root, path.basename(url)))
  if (!local.startsWith(root + path.sep)) throw new Error('角色声音文件路径无效')
  const stat = await fs.stat(local)
  if (!stat.isFile() || stat.size <= 0 || stat.size > 15 * 1024 * 1024) throw new Error('角色声音文件大小须在 15 MB 以内')
  const mime = url.toLowerCase().endsWith('.mp3') ? 'audio/mp3' : 'audio/wav'
  return `data:${mime};base64,${(await fs.readFile(local)).toString('base64')}`
}
