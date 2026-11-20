import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT } from '../utils/paths.js'
import { matchReferenceImageExtension } from '../utils/reference-image-format.js'
import { createSignedReferenceMediaUrl, signedReferenceMediaEnabled } from './signed-reference-media.js'

type PublicMediaKind = 'image' | 'video' | 'audio' | 'file'
type PublicMediaOptions = { matchImageExtension?: boolean }
const mediaLabels: Record<PublicMediaKind, string> = { image: '图片', video: '视频', audio: '音频', file: '文件' }

export function publicMediaBaseUrl(): string | null {
  const raw = process.env.PUBLIC_BASE_URL?.trim()
  if (!raw) return null
  let base: URL
  try { base = new URL(raw) } catch { throw new Error('PUBLIC_BASE_URL 不是有效的公网地址') }
  const host = base.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host === '::1' || host === '::' || /^f[cd][0-9a-f]{0,2}:/iu.test(host) || /^fe[89ab][0-9a-f]:/iu.test(host) ||
    /^(?:127|10|0)\./u.test(host) || /^192\.168\./u.test(host) || /^169\.254\./u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || privateHost) {
    throw new Error('PUBLIC_BASE_URL 必须是无凭据、可从公网访问的 HTTP(S) 地址')
  }
  return base.href.replace(/\/+$/, '')
}

async function imageWithMatchingExtension(root: string, local: string, relative: string, size: number, mtimeMs: number) {
  const extension = path.extname(relative).toLowerCase()
  const actualExtension = await matchReferenceImageExtension(local, extension)
  if (actualExtension === extension) return relative

  const hash = createHash('sha256').update(JSON.stringify([relative, size, mtimeMs])).digest('hex')
  const cached = 'reference-images/' + hash + actualExtension
  const output = path.join(root, cached)
  if ((await fs.stat(output).catch(() => null))?.size === size) return cached
  await fs.mkdir(path.dirname(output), { recursive: true })
  const temporary = output + '.' + randomUUID() + '.tmp'
  try {
    await fs.copyFile(local, temporary)
    await fs.rename(temporary, output)
    return cached
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

/** Publish stored references without downloading any external URLs. */
export async function resolvePublicMediaUrl(value: string | null | undefined, kind: PublicMediaKind, options: PublicMediaOptions = {}): Promise<string | null> {
  const source = String(value || '').trim()
  if (!source) return null
  if (!/^\/?static\//u.test(source)) return source

  const base = publicMediaBaseUrl()
  const label = mediaLabels[kind]
  if (!base) throw new Error(`参考${label}为本地文件，需要配置外网可访问的 PUBLIC_BASE_URL 后重试`)

  let relative = source.replace(/^\/?static\//u, '')
  const parts = relative.split('/')
  if (/[?#%\\\u0000-\u001f]/u.test(relative) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`本地参考${label}路径无效，请重新上传`)
  }
  try {
    const root = await fs.realpath(STORAGE_ROOT)
    const local = await fs.realpath(path.join(root, relative))
    if (!local.startsWith(root + path.sep)) throw new Error('Invalid media path')
    const stat = await fs.stat(local)
    if (!stat.isFile() || !stat.size) throw new Error('Invalid media file')
    // Static HTTP routes infer Content-Type from the served path.
    if (kind === 'image' && options.matchImageExtension)
      relative = await imageWithMatchingExtension(root, local, relative, stat.size, stat.mtimeMs)
  } catch {
    throw new Error(`本地参考${label}不存在或无法读取，请重新上传`)
  }
  if (signedReferenceMediaEnabled()) return createSignedReferenceMediaUrl(base, `/static/${relative}`)
  return `${base}/static/${relative.split('/').map(encodeURIComponent).join('/')}`
}

export async function resolvePublicMediaUrls(refs: readonly string[] | null | undefined, kind: PublicMediaKind, options: PublicMediaOptions = {}): Promise<string[]> {
  if (!Array.isArray(refs) || !refs.length) return []
  const results = await Promise.all(refs.map(ref => resolvePublicMediaUrl(ref, kind, options)))
  return results.filter((item): item is string => item !== null)
}
