import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-video-poster-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
const require = createRequire(import.meta.url)
const binary = process.env.FFMPEG_BIN || require('ffmpeg-static')
await fs.mkdir(path.join(root, 'static/videos'), { recursive: true })
function clip(name: string, color: string, duration: number) {
  const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=${duration}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', path.join(root, `static/videos/${name}.mp4`)], { windowsHide: true })
  assert.equal(result.status, 0, result.stderr?.toString())
}
clip('short-red', 'red', 0.12)
clip('blue', 'blue', 1)
const { extractVideoPoster, videoPosterForSources } = await import('../src/utils/video-poster.js')
const { db, schema } = await import('../src/db/index.js')
const { default: tasks } = await import('../src/routes/tasks.js')
const { default: storyboards } = await import('../src/routes/storyboards.js')
const ts = new Date().toISOString()
let remoteCalls = 0
const server = http.createServer(async (req, res) => {
  remoteCalls++
  if (req.url === '/blue.mp4') { res.setHeader('content-type', 'video/mp4'); res.end(await fs.readFile(path.join(root, 'static/videos/blue.mp4'))) }
  else { res.statusCode = 404; res.end('missing') }
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
async function rgb(bytes: Buffer) {
  return sharp(bytes).resize(1, 1).removeAlpha().raw().toBuffer()
}

test('short videos fall back to frame zero, return a real JPEG and reuse the cache', async () => {
  const result = await extractVideoPoster('/static/videos/short-red.mp4')
  assert.equal(result, 'static/videos/short-red_poster.jpg')
  const poster = path.join(root, result!)
  const bytes = await fs.readFile(poster)
  assert.equal((await sharp(bytes).metadata()).width, 640)
  const color = await rgb(bytes)
  assert.ok(color[0] > 200 && color[2] < 40)
  const before = (await fs.stat(poster)).mtimeMs
  await extractVideoPoster('static/videos/short-red.mp4')
  assert.equal((await fs.stat(poster)).mtimeMs, before)
})

test('task poster prefers local video, uses current shot video, and returns no paths on missing media', async () => {
  const shot = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, videoUrl: 'static/videos/short-red.mp4', createdAt: ts, updatedAt: ts }).returning().get()
  const old = db.insert(schema.sysTask).values({ type: 'video', storyboardId: shot.id, localPath: 'static/videos/short-red.mp4', resultUrl: `${base}/missing`, status: 'completed', createdAt: ts, updatedAt: ts }).returning().get()
  db.insert(schema.sysTask).values({ type: 'video', storyboardId: shot.id, localPath: 'static/videos/blue.mp4', status: 'completed', createdAt: ts, updatedAt: ts }).run()
  const before = remoteCalls
  const taskResponse = await tasks.request(`/${old.id}/poster`)
  assert.equal(taskResponse.status, 200)
  assert.equal(taskResponse.headers.get('content-type'), 'image/jpeg')
  assert.equal(remoteCalls, before)
  const shotResponse = await storyboards.request(`/${shot.id}/poster`)
  const color = await rgb(Buffer.from(await shotResponse.arrayBuffer()))
  assert.ok(color[0] > 200 && color[2] < 40, 'older selected video must not use newest history poster')
  const etag = shotResponse.headers.get('etag')!
  assert.equal((await storyboards.request(`/${shot.id}/poster`, { headers: { 'If-None-Match': etag } })).status, 304)
  db.update(schema.storyboards).set({ videoUrl: 'static/videos/blue.mp4' }).where(eq(schema.storyboards.id, shot.id)).run()
  const changed = await storyboards.request(`/${shot.id}/poster`, { headers: { 'If-None-Match': etag } })
  assert.equal(changed.status, 200)
  assert.notEqual(changed.headers.get('etag'), etag)
  const invalid = db.insert(schema.sysTask).values({ type: 'video', localPath: 'static/videos/missing.mp4', status: 'completed', createdAt: ts, updatedAt: ts }).returning().get()
  const missing = await tasks.request(`/${invalid.id}/poster`)
  assert.equal(missing.status, 404)
  const body = await missing.json() as any
  assert.deepEqual(body, { code: 404, message: '视频封面暂不可用' })
  assert.equal(missing.headers.get('cache-control'), 'no-store')
  assert.equal((await tasks.request('/99999/poster')).status, 404)
})

test('remote-only history downloads once for concurrent viewers and serves the cached real frame', async () => {
  const task = db.insert(schema.sysTask).values({ type: 'video', resultUrl: `${base}/blue.mp4`, status: 'completed', createdAt: ts, updatedAt: ts }).returning().get()
  const before = remoteCalls
  const responses = await Promise.all(Array.from({ length: 4 }, () => tasks.request(`/${task.id}/poster`)))
  for (const response of responses) {
    assert.equal(response.status, 200)
    const color = await rgb(Buffer.from(await response.arrayBuffer()))
    assert.ok(color[2] > 200 && color[0] < 40)
  }
  assert.equal(remoteCalls, before + 1)
  await tasks.request(`/${task.id}/poster`)
  assert.equal(remoteCalls, before + 1)
  assert.equal(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, task.id)).get()!.localPath, null, 'poster reads do not change video task state')
  assert.equal(await videoPosterForSources(['file:///secret', 'static/../../outside.mp4']), null)
})

after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.$client.close() })
