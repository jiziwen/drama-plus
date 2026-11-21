import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import sharp from 'sharp'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-reference-frame-'))
process.env.STORAGE_PATH = path.join(root, 'static')
const videos = path.join(root, 'static/videos')
await fs.mkdir(videos, { recursive: true })
after(() => fs.rm(root, { recursive: true, force: true }))
const { extractVideoReferenceFrame } = await import('../src/utils/video-reference-frame.js')
const ffmpeg = process.env.FFMPEG_BIN || createRequire(import.meta.url)('ffmpeg-static')
const width = 96, height = 64

function movie(file: string, colors: number[][]) {
  const frames = colors.map(color => Buffer.alloc(width * height * 3, Buffer.from(color)))
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', width + 'x' + height,
    '-r', '10', '-i', 'pipe:0', '-c:v', 'libx264', '-g', '5', '-pix_fmt', 'yuv420p', file], { input: Buffer.concat(frames) })
}

test('保留原画幅，时间点落在两帧之间时采用当时仍在播放的一帧', async () => {
  const url = '/static/videos/manual.mp4'
  const red = [200, 10, 10], blue = [10, 10, 200], last = [0, 0, 0]
  movie(path.join(videos, 'manual.mp4'), [red, red, red, red, red, blue, blue, blue, blue, last])
  const [beforeCut, duplicate, afterCut, final] = await Promise.all([
    extractVideoReferenceFrame(url, .499), extractVideoReferenceFrame(url.slice(1), .4992),
    extractVideoReferenceFrame(url, .5), extractVideoReferenceFrame(url, .999),
  ])
  assert.equal(beforeCut, duplicate)
  assert.notEqual(beforeCut, afterCut)
  for (const [frame, color] of [[beforeCut, red], [afterCut, blue], [final, last]] as const) {
    assert.ok(frame)
    assert.match(frame, /^\/static\/videos\/[a-f\d]{64}_lighting\.jpg$/u)
    const file = path.join(root, frame)
    const { width: outputWidth, height: outputHeight } = await sharp(file).metadata()
    assert.deepEqual([outputWidth, outputHeight], [width, height])
    const { channels } = await sharp(file).stats()
    assert.ok(color.every((value, i) => Math.abs(value - channels[i].mean) < 6))
  }
  const file = path.join(root, beforeCut!)
  const cached = await fs.stat(file)
  assert.equal(await extractVideoReferenceFrame(url, .499), beforeCut)
  assert.equal((await fs.stat(file)).mtimeMs, cached.mtimeMs)
  assert.equal(await extractVideoReferenceFrame(url, 1), null)
  assert.equal(await extractVideoReferenceFrame(url, 3), null)
  assert.ok(!(await fs.readdir(videos)).some(name => name.startsWith('.')))
})

test('同一成片路径内容替换后重新取帧，保留旧任务的已选画面', async () => {
  const url = '/static/videos/replaced.mp4', file = path.join(videos, 'replaced.mp4')
  movie(file, [[200, 10, 10], [200, 10, 10]])
  const first = await extractVideoReferenceFrame(url, 0)
  const replacement = path.join(videos, 'new.mp4')
  movie(replacement, [[10, 200, 10], [10, 200, 10]])
  await fs.rename(replacement, file)
  const second = await extractVideoReferenceFrame(url, 0)
  assert.ok(first && second && first !== second)
  assert.ok((await sharp(path.join(root, first)).stats()).channels[0].mean > 175)
  assert.ok((await sharp(path.join(root, second)).stats()).channels[1].mean > 175)
})

test('拒绝无效时间、远程视频、目录外链接和非视频内容', async () => {
  const outside = path.join(root, 'outside.mp4')
  movie(outside, [[10, 200, 10], [10, 200, 10]])
  await fs.symlink(outside, path.join(videos, 'outside.mp4'))
  await fs.writeFile(path.join(videos, 'broken.mp4'), 'invalid movie')
  for (const url of ['/static/videos/outside.mp4', '/static/videos/broken.mp4', '/static/uploads/other.mp4',
    '/static/videos/../../outside.mp4', 'https://example.invalid/video.mp4']) {
    assert.equal(await extractVideoReferenceFrame(url, 0), null)
  }
  for (const time of [-.0001, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(await extractVideoReferenceFrame('/static/videos/manual.mp4', time), null)
  }
})
