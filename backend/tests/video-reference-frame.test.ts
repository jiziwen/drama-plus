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
  const endpoint = await extractVideoReferenceFrame(url, 1)
  assert.ok(endpoint, '精确结束时刻应保留播放器显示的最后一帧')
  assert.ok((await sharp(path.join(root, endpoint)).stats()).channels.every(channel => channel.mean < 6))
  assert.equal(await extractVideoReferenceFrame(url, 3), null)
  assert.ok(!(await fs.readdir(videos)).some(name => name.startsWith('.')))
})

test('30秒片可截取末端，音频长于视频时仍保留最后视频画面', async () => {
  const base = path.join(videos, 'thirty-seconds.mp4')
  const red = [200, 10, 10], black = [0, 0, 0]
  movie(base, [...Array.from({ length: 299 }, () => red), black])
  const input = path.join(videos, 'audio-tail.mp4')
  execFileSync(ffmpeg, ['-v', 'error', '-i', base, '-f', 'lavfi', '-t', '30.08', '-i',
    'anullsrc=r=48000:cl=mono', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', input])
  for (const [url, times] of [
    ['/static/videos/thirty-seconds.mp4', [29.999, 30]],
    ['/static/videos/audio-tail.mp4', [30, 30.079, 30.08]],
  ] as const) {
    for (const time of times) {
      const frame = await extractVideoReferenceFrame(url, time)
      assert.ok(frame, `${url} 在 ${time} 秒应可截取最后画面`)
      const metadata = await sharp(path.join(root, frame)).metadata()
      assert.deepEqual([metadata.width, metadata.height], [width, height])
      assert.ok((await sharp(path.join(root, frame)).stats()).channels.every(channel => channel.mean < 6), '手选应保留真实黑色末帧，不应后退到稳定红帧')
    }
    assert.equal(await extractVideoReferenceFrame(url, 31), null, '超过可播放时长须拒绝')
  }
})

test('变帧率成片的中间停帧和结束画面分别保持正确', async () => {
  const url = '/static/videos/variable-rate.mp4'
  const red = [200, 10, 10], blue = [10, 10, 200], black = [0, 0, 0]
  const frames = [red, blue, black].map(color => Buffer.alloc(width * height * 3, Buffer.from(color)))
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', width + 'x' + height,
    '-r', '10', '-i', 'pipe:0', '-vf', 'setpts=if(eq(N\\,0)\\,0\\,if(eq(N\\,1)\\,1\\,10))',
    '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(videos, 'variable-rate.mp4')],
  { input: Buffer.concat(frames) })
  const middle = await extractVideoReferenceFrame(url, .5)
  assert.ok(middle)
  assert.ok((await sharp(path.join(root, middle)).stats()).channels[2].mean > 175, '中间长停帧应仍为蓝色，不能跳到末帧')
  for (const time of [1.099, 1.1]) {
    const final = await extractVideoReferenceFrame(url, time)
    assert.ok(final)
    assert.ok((await sharp(path.join(root, final)).stats()).channels.every(channel => channel.mean < 6))
  }
  assert.equal(await extractVideoReferenceFrame(url, 1.101), null)
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
  const outsideDirectory = path.join(root, 'outside')
  await fs.mkdir(outsideDirectory)
  const outside = path.join(outsideDirectory, 'outside.mp4')
  movie(outside, [[10, 200, 10], [10, 200, 10]])
  // Windows 支持普通目录 junction，无需创建文件符号链接的额外权限。
  await fs.symlink(outsideDirectory, path.join(videos, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  await fs.writeFile(path.join(videos, 'broken.mp4'), 'invalid movie')
  for (const url of ['/static/videos/external/outside.mp4', '/static/videos/broken.mp4', '/static/uploads/other.mp4',
    '/static/videos/../../outside.mp4', 'https://example.invalid/video.mp4']) {
    assert.equal(await extractVideoReferenceFrame(url, 0), null)
  }
  for (const time of [-.0001, NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(await extractVideoReferenceFrame('/static/videos/manual.mp4', time), null)
  }
})
