import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-lighting-'))
process.env.STORAGE_PATH = path.join(root, 'static')
const videos = path.join(root, 'static', 'videos')
await fs.mkdir(videos, { recursive: true })
const { compareVideoLightingFrames, extractVideoLightingFrame } = await import('../src/utils/video-lighting-frame.js')
const binary = process.env.FFMPEG_BIN || createRequire(import.meta.url)('ffmpeg-static')
const width = 160, height = 90
const image = (offset: number, sky = false) => {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const value = 25 + (Math.floor(x / 6) * 17 + Math.floor(y / 5) * 13) % 63
    const index = (y * width + x) * 3
    if (sky && y < 18) {
      pixels[index] = 120; pixels[index + 1] = 170; pixels[index + 2] = 245
    } else {
      pixels[index] = value + offset; pixels[index + 1] = value + offset; pixels[index + 2] = value + offset
    }
  }
  return pixels
}

const dark = image(0), bright = image(95), extraSky = image(0, true)
const black = Buffer.alloc(dark.length), white = Buffer.alloc(dark.length, 255)
const repeat = (image: Buffer, count: number) => Array.from({ length: count }, () => image)
const movie = '/static/videos/lighting-test.mp4'
const result = spawnSync(binary, [
  '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', width + 'x' + height,
  '-r', '10', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(videos, 'lighting-test.mp4'),
], { input: Buffer.concat([
  ...repeat(black, 4), ...repeat(dark, 12), ...repeat(white, 4), ...repeat(bright, 20),
  ...repeat(extraSky, 20), ...repeat(black, 15), ...repeat(white, 5),
  ...repeat(dark, 8), ...repeat(image(48), 4), ...repeat(bright, 8),
]) })
assert.equal(result.status, 0, result.stderr?.toString())

test('chooses a stable full-sized frame inside the shot, ignoring fades and white flashes', async () => {
  const [a, duplicate] = await Promise.all([extractVideoLightingFrame(movie, 0, 2), extractVideoLightingFrame(movie.slice(1), 0, 2)])
  assert.match(a || '', /^\/static\/videos\/[a-f\d]{64}_lighting\.jpg$/u)
  assert.equal(a, duplicate)
  const fullPath = path.join(root, a!)
  const before = await fs.stat(fullPath)
  assert.equal((await sharp(fullPath).metadata()).width, width)
  const meanLuma = (await sharp(fullPath).stats()).channels[0].mean
  assert.ok(meanLuma > 48 && meanLuma < 70, 'selected the textured dark frame between the transition frames')
  assert.equal(await extractVideoLightingFrame(movie, 0, 2), a)
  assert.equal((await fs.stat(fullPath)).mtimeMs, before.mtimeMs)
  assert.equal((await fs.readdir(videos)).some(name => name.startsWith('.lighting-')), false)
  assert.equal(await extractVideoLightingFrame(movie, 6, 8), null, 'pure black and white shots provide no reliable baseline')
  const crossfade = await extractVideoLightingFrame(movie, 8, 10)
  assert.ok(crossfade)
  const brightness = (await sharp(path.join(root, crossfade)).stats()).channels[0].mean
  assert.ok(brightness < 70 || brightness > 140, 'the blended midpoint is unsuitable even when it is the median exposure')
})

test('requires a large change away from the sky as well as the whole frame before flagging a join', async () => {
  const a = await extractVideoLightingFrame(movie, 0, 2)
  const b = await extractVideoLightingFrame(movie, 2, 4)
  const sky = await extractVideoLightingFrame(movie, 4, 6)
  assert.ok(a && b && sky)
  assert.equal(await compareVideoLightingFrames(a, b), 'review')
  assert.equal(await compareVideoLightingFrames(b, a), 'review')
  assert.equal(await compareVideoLightingFrames(a, sky), 'similar')
  assert.equal(await compareVideoLightingFrames(a, a), 'similar')
})

test('rejects invalid ranges, remote inputs and symlinks to videos outside storage', async () => {
  await fs.symlink(path.join(root, 'outside.mp4'), path.join(videos, 'link.mp4'))
  await fs.copyFile(path.join(videos, 'lighting-test.mp4'), path.join(root, 'outside.mp4'))
  assert.equal(await extractVideoLightingFrame('/static/videos/link.mp4', 0, 2), null)
  assert.equal(await extractVideoLightingFrame('https://example.org/test.mp4', 0, 2), null)
  assert.equal(await extractVideoLightingFrame(movie, NaN, 2), null)
  assert.equal(await extractVideoLightingFrame(movie, 4, 4), null)
  assert.equal(await extractVideoLightingFrame(movie, 20, 22), null)
  assert.equal(await compareVideoLightingFrames('/static/videos/missing.jpg', movie), 'unknown')
})

after(() => fs.rm(root, { recursive: true, force: true }))
