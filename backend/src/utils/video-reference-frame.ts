import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkFfmpegSuite, ffmpeg } from './ffmpeg.js'
import { hasJpeg, resolveStoredVideo } from './video-poster.js'

const pending = new Map<string, Promise<string | null>>()

function renderFrame(input: string, output: string, milliseconds: number) {
  // Keep frames from the preceding keyframe. Relative to the requested seek,
  // the frame displayed at time zero is the last frame with a nonpositive PTS.
  // Rounding timestamps up on a millisecond grid keeps a later frame out.
  const command = ffmpeg(input).seekInput(milliseconds / 1000)
    .inputOptions(['-noaccurate_seek', '-protocol_whitelist file', '-format_whitelist mov,mp4,m4a,3gp,3g2,mj2,matroska,webm'])
    .outputOptions(['-map 0:V:0', '-vf fps=1000:start_time=0:round=up:eof_action=pass', '-frames:v 1', '-q:v 2', '-update 1'])
    .output(output)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Reference frame extraction timed out')) }, 30_000)
    command.on('end', () => { clearTimeout(timer); resolve() })
      .on('error', error => { clearTimeout(timer); reject(error) }).run()
  })
}

/** Extract the full-size frame actually displayed at the selected time. */
export async function extractVideoReferenceFrame(videoUrl: string, seconds: number): Promise<string | null> {
  const milliseconds = Math.round(seconds * 1000)
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(milliseconds)) return null
  try {
    const local = await resolveStoredVideo(videoUrl)
    if (!local) return null
    const { input, stat, videos } = local
    const key = createHash('sha256').update(JSON.stringify([
      'manual-time-v1', input, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, milliseconds,
    ])).digest('hex')
    const name = key + '_lighting.jpg', output = path.join(videos, name)
    const existing = pending.get(output)
    if (existing) return existing
    const url = '/static/videos/' + name
    const operation = (async () => {
      if ((await fs.lstat(output).catch(() => null))?.isFile() && await hasJpeg(output)) return url
      if (!(await checkFfmpegSuite()).ffmpeg) return null
      const temporary = path.join(videos, '.' + randomUUID() + '.jpg')
      try {
        await renderFrame(input, temporary, milliseconds)
        if (!await hasJpeg(temporary)) return null
        const now = await fs.stat(input)
        if (now.ino !== stat.ino || now.dev !== stat.dev || now.size !== stat.size ||
            now.mtimeMs !== stat.mtimeMs || now.ctimeMs !== stat.ctimeMs) return null
        await fs.rename(temporary, output)
        return url
      } finally { await fs.rm(temporary, { force: true }) }
    })().catch(() => null).finally(() => { pending.delete(output) })
    pending.set(output, operation)
    return operation
  } catch { return null }
}
