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
const { extractVideoPoster, extractVideoTailFrame, videoPosterForSources } = await import('../src/utils/video-poster.js')
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

test('continuation extracts the real last picture, including a video with trailing audio only', async () => {
  const video = path.join(root, 'static/videos/color-change.mp4')
  const audioTail = path.join(root, 'static/videos/audio-tail.mp4')
  const run = (args: string[]) => {
    const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true })
    assert.equal(result.status, 0, result.stderr?.toString())
  }
  run([
    '-f', 'lavfi', '-i', 'color=red:s=160x90:r=7:d=2',
    '-f', 'lavfi', '-i', 'color=blue:s=160x90:r=7:d=0.14',
    '-filter_complex', 'concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ])
  run([
    '-i', video, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=7',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', audioTail,
  ])

  const cover = await extractVideoPoster('/static/videos/color-change.mp4')
  const coverColor = await rgb(await fs.readFile(path.join(root, cover!)))
  assert.ok(coverColor[0] > 200 && coverColor[2] < 40, 'the existing poster represents the red opening')
  for (const name of ['color-change', 'audio-tail']) {
    const source = `/static/videos/${name}.mp4`
    const [first, second] = await Promise.all([extractVideoTailFrame(source), extractVideoTailFrame(source.slice(1))])
    assert.match(first || '', /^\/static\/videos\/[a-f0-9]{64}_tail\.jpg$/)
    assert.equal(first, second)
    const file = path.join(root, first!.slice(1))
    const bytes = await fs.readFile(file)
    assert.equal((await sharp(bytes).metadata()).width, 160)
    const color = await rgb(bytes)
    assert.ok(color[2] > 200 && color[0] < 40, `last decoded frame should be blue in ${name}`)
    const before = (await fs.stat(file)).mtimeMs
    await extractVideoTailFrame(source)
    assert.equal((await fs.stat(file)).mtimeMs, before)
  }
  const beforeRemote = remoteCalls
  assert.equal(await extractVideoTailFrame(`${base}/blue.mp4`), null)
  assert.equal(remoteCalls, beforeRemote)
  assert.equal(await extractVideoTailFrame('/static/videos/../../outside.mp4'), null)
})

test('continuation keeps the native last frame or backs up to the nearest stable frame in the last shot', async () => {
  const width = 160, height = 90, fps = 10
  function textured(brightness: number) {
    return Buffer.from(Array.from({ length: width * height * 3 }, (_, index) => {
      const pixel = Math.floor(index / 3)
      return brightness + (pixel % width < 80 ? -13 : 13) + (Math.floor(pixel / width) < 45 ? -7 : 7)
    }))
  }
  const before = textured(90), nearest = textured(102), different = textured(190)
  const dark = Buffer.alloc(before.length), white = Buffer.alloc(before.length, 255)
  const letterboxedFlash = Buffer.from(white)
  letterboxedFlash.fill(0, 0, width * 10 * 3)
  letterboxedFlash.fill(0, width * (height - 10) * 3)
  const lead = Array<Buffer>(8).fill(before)
  const stable = [...lead, nearest, nearest]
  const blend = (other: Buffer, weight: number) => nearest.map((value, i) => Math.round(value * (1 - weight) + other[i] * weight))
  const fixtures = {
    normal: [...lead, nearest],
    'black-end': [...stable, dark, dark],
    'white-flash': [...stable, letterboxedFlash],
    'hard-cut': [...stable, different, different],
    'cut-to-black': [...stable, different, dark, dark],
    'dissolve-end': [...stable, ...[.16, .3, .45, .6].map(weight => blend(different, weight))],
    'fade-to-black': [...stable, ...[.16, .3, .45, .6, .75, .9].map(weight => blend(dark, weight)), dark],
    'blank-final-shot': [...Array<Buffer>(8).fill(different), dark, dark, dark],
  }
  for (const [name, frames] of Object.entries(fixtures)) {
    const encoded = spawnSync(binary, [
      '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24',
      '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, `static/videos/tail-${name}.mp4`),
    ], { input: Buffer.concat(frames), windowsHide: true })
    assert.equal(encoded.status, 0, encoded.stderr?.toString())
    const source = `/static/videos/tail-${name}.mp4`
    const usable = await extractVideoTailFrame(source, {
      shotStartSeconds: name === 'blank-final-shot' ? .8 : .3, shotEndSeconds: frames.length / fps,
    })
    if (name === 'blank-final-shot') {
      assert.equal(usable, null, 'must not cross into the previous shot')
      continue
    }
    assert.ok(usable, name)
    const bytes = await fs.readFile(path.join(root, usable))
    assert.equal((await sharp(bytes).metadata()).width, width)
    const mean = (await sharp(bytes).stats()).channels[0].mean
    assert.ok(Math.abs(mean - 102) <= 3, `${name} should use the nearest stable frame, got ${mean}`)
  }
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
