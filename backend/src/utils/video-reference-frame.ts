import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { checkFfmpegSuite, ffmpeg } from './ffmpeg.js'
import { hasJpeg, resolveStoredVideo } from './video-poster.js'

const pending = new Map<string, Promise<string | null>>()
const allowedFormats = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm'
const localInputOptions = ['-protocol_whitelist file', `-format_whitelist ${allowedFormats}`]

function probePlaybackEnd(input: string): Promise<{ duration: number; videoEnd?: number } | null> {
  let executable = process.env.FFPROBE_BIN
  if (!executable) {
    try { executable = createRequire(import.meta.url)('ffprobe-static').path } catch { return Promise.resolve(null) }
  }
  if (!executable) return Promise.resolve(null)
  return new Promise(resolve => {
    execFile(executable, ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', allowedFormats,
      '-show_entries', 'format=duration:stream=codec_type,start_time,duration', '-of', 'json', input],
    { timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null)
      try {
        const metadata = JSON.parse(stdout)
        const duration = Number(metadata.format?.duration)
        const video = metadata.streams?.find((stream: { codec_type?: string }) => stream.codec_type === 'video')
        const videoDuration = Number(video?.duration), start = Number(video?.start_time ?? 0)
        if (!video || !Number.isFinite(duration) || duration <= 0) return resolve(null)
        const videoEnd = Number.isFinite(videoDuration) && videoDuration > 0 && Number.isFinite(start)
          ? Math.min(duration, start + videoDuration) : undefined
        resolve({ duration, ...(videoEnd !== undefined && { videoEnd }) })
      } catch { resolve(null) }
    })
  })
}

function runFrameCommand(command: ReturnType<typeof ffmpeg>) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('Reference frame extraction timed out')) }, 30_000)
    command.on('end', () => { clearTimeout(timer); resolve() })
      .on('error', error => { clearTimeout(timer); reject(error) }).run()
  })
}

function renderFrame(input: string, output: string, milliseconds: number) {
  // Keep frames from the preceding keyframe. Relative to the requested seek,
  // the frame displayed at time zero is the last frame with a nonpositive PTS.
  // Rounding timestamps up on a millisecond grid keeps a later frame out.
  const command = ffmpeg(input).seekInput(milliseconds / 1000)
    .inputOptions(['-noaccurate_seek', ...localInputOptions])
    .outputOptions(['-map 0:V:0', '-vf fps=1000:start_time=0:round=up:eof_action=pass', '-frames:v 1', '-q:v 2', '-update 1'])
    .output(output)
  return runFrameCommand(command)
}

async function renderPlaybackEnd(input: string, output: string, milliseconds: number) {
  const playback = await probePlaybackEnd(input)
  if (!playback || milliseconds > Math.round(playback.duration * 1000)) return
  // A browser holds the final video picture through an audio-only tail and at
  // the exact media endpoint. Decode native frames through EOF, overwriting the
  // JPEG so the real final picture wins, including a deliberately black frame.
  // Do not infer the last timestamp from a nominal FPS: VFR clips need decoding.
  const requested = milliseconds / 1000
  const seek = playback.videoEnd === undefined ? 0 : Math.max(0, Math.min(requested, playback.videoEnd) - 1)
  await runFrameCommand(ffmpeg(input).seekInput(seek)
    .inputOptions(['-noaccurate_seek', ...localInputOptions])
    .outputOptions(['-map 0:V:0', `-vf select=lte(t\\,${requested - seek})`,
      '-fps_mode passthrough', '-q:v 2', '-update 1']).output(output))
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
        if (!await hasJpeg(temporary)) await renderPlaybackEnd(input, temporary, milliseconds)
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
