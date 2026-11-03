/**
 * 视频海报帧提取 — 供 <video poster> 使用，避免列表页为显示首帧而缓冲整个视频
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { STORAGE_ROOT } from './paths.js'
import { ffmpeg, checkFfmpegSuite } from './ffmpeg.js'
import { downloadVideo } from '../services/video-download.js'

/** 由视频相对路径推导海报帧路径：static/videos/x.mp4 → static/videos/x_poster.jpg */
export function posterPathFor(relativePath: string): string {
  return relativePath.replace(/[?#].*$/, '').replace(/\.[^./]+$/, '_poster.jpg')
}

const extracting = new Map<string, Promise<string | null>>()

function localVideoPath(source: string): { relative: string; absolute: string } | null {
  const clean = source.replace(/[?#].*$/, '').replace(/^\/+/, '')
  if (!clean.startsWith('static/') || !/\.(mp4|webm|mov|m4v)$/i.test(clean)) return null
  const absolute = path.resolve(STORAGE_ROOT, clean.slice('static/'.length))
  const rel = path.relative(path.resolve(STORAGE_ROOT), absolute)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return { relative: `static/${rel.split(path.sep).join('/')}`, absolute }
}

async function hasJpeg(file: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(file)
    return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
  } catch { return false }
}

async function extractFrame(input: string, output: string, seek: number) {
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg(input).seekInput(seek).frames(1)
      .outputOptions(['-vf', 'scale=640:-2', '-q:v', '3']).output(output)
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('poster extraction timed out')) }, 30_000)
    command.on('end', () => { clearTimeout(timer); resolve() })
      .on('error', error => { clearTimeout(timer); reject(error) }).run()
  })
}

/** Existing videos get their poster on demand. Source is always a stored task/shot URL. */
export async function extractVideoPoster(source: string): Promise<string | null> {
  const local = localVideoPath(source)
  const remote = /^https?:\/\//i.test(source)
  if (!local && !remote) return null
  const hash = createHash('sha256').update(source).digest('hex')
  const posterRel = local ? posterPathFor(local.relative) : `static/posters/${hash}_poster.jpg`
  const posterAbs = path.resolve(STORAGE_ROOT, posterRel.slice('static/'.length))
  const pending = extracting.get(posterAbs)
  if (pending) return pending
  const operation = (async () => {
    let downloaded: string | undefined
    const temporary = path.join(path.dirname(posterAbs), `${randomUUID()}_poster.tmp.jpg`)
    try {
      if (await hasJpeg(posterAbs)) return posterRel
      const { ffmpeg: ffmpegOk } = await checkFfmpegSuite()
      if (!ffmpegOk) return null
      let input = local?.absolute
      if (!input) {
        // Reuse the bounded streaming downloader and container validation; never
        // pass arbitrary remote protocols/playlists directly to ffmpeg.
        const cacheRoot = path.join(STORAGE_ROOT, '.poster-cache', hash)
        const downloadedRel = await downloadVideo(source, 0, { root: cacheRoot, attempts: 1, timeoutMs: 45_000 })
        input = path.join(cacheRoot, downloadedRel.slice('static/'.length))
        downloaded = input
      }
      const stat = await fs.stat(input)
      if (!stat.isFile() || !stat.size) return null
      await fs.mkdir(path.dirname(posterAbs), { recursive: true })
      // Very short clips have no frame at 0.5 s; fall back to the first frame.
      for (const seek of [0.5, 0]) {
        try { await extractFrame(input, temporary, seek) } catch { /* try first frame */ }
        if (await hasJpeg(temporary)) {
          await fs.rename(temporary, posterAbs)
          return posterRel
        }
      }
      return null
    } catch {
      console.warn('[video-poster] 视频封面暂不可用')
      return null
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {})
      if (downloaded) await fs.rm(downloaded, { force: true }).catch(() => {})
    }
  })().finally(() => { extracting.delete(posterAbs) })
  extracting.set(posterAbs, operation)
  return operation
}

/** Prefer every local candidate before attempting a stored remote result URL. */
export async function videoPosterForSources(sources: (string | null | undefined)[]): Promise<string | null> {
  const unique = [...new Set(sources.filter((s): s is string => !!s))]
  const ordered = [...unique.filter(s => !!localVideoPath(s)), ...unique.filter(s => /^https?:\/\//i.test(s))]
  for (const source of ordered) {
    const result = await extractVideoPoster(source)
    if (result) return result
  }
  return null
}
