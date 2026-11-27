import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { extractVideoAudio } from '../src/utils/video-audio.js'
import { ffmpegPath, ffprobePath } from '../src/utils/ffmpeg.js'

const execFile = promisify(execFileCallback)

test('extracts a bounded MP3 and reports missing audio without leaving an output', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'video-audio-test-'))
  try {
    const video = path.join(dir, 'source.mp4'), silent = path.join(dir, 'silent.mp4'), result = path.join(dir, 'result.mp3')
    await execFile(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:size=16x16:rate=1', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'mpeg4', '-c:a', 'aac', video])
    await execFile(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:size=16x16:rate=1', '-t', '1', '-c:v', 'mpeg4', silent])
    await extractVideoAudio(video, result)
    const metadata = JSON.parse((await execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', result])).stdout)
    assert.equal(metadata.streams[0].codec_name, 'mp3')
    assert.ok(Number(metadata.format.duration) <= 10)
    assert.ok((await stat(result)).size < 128 * 1024)
    const noAudio = path.join(dir, 'empty.mp3')
    await assert.rejects(extractVideoAudio(silent, noAudio), /没有音频轨道/)
    await assert.rejects(stat(noAudio), { code: 'ENOENT' })
    const existing = path.join(dir, 'existing.mp3')
    await writeFile(existing, 'existing')
    await assert.rejects(extractVideoAudio(video, existing), { code: 'EEXIST' })
    assert.equal(await readFile(existing, 'utf8'), 'existing')
    await assert.rejects(extractVideoAudio('relative.mp4', result), /绝对路径/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
