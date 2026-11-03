import type { Context } from 'hono'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { STORAGE_ROOT } from '../utils/paths.js'
import { videoPosterForSources } from '../utils/video-poster.js'

export async function videoPosterResponse(c: Context, sources: (string | null | undefined)[]) {
  const poster = await videoPosterForSources(sources)
  if (poster) {
    try {
      const bytes = await fs.readFile(path.join(STORAGE_ROOT, poster.slice('static/'.length)))
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`
      const headers = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-cache', ETag: etag }
      if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers)
      return c.body(new Uint8Array(bytes), 200, headers)
    } catch { /* respond with a path-free 404 */ }
  }
  return c.json({ code: 404, message: '视频封面暂不可用' }, 404, { 'Cache-Control': 'no-store' })
}
