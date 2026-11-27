import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { checkFfmpegSuite, ffmpegPath } from './ffmpeg.js'

const maxBytes = 128 * 1024
const formats = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm'

/** Extract a short mono MP3 from a downloaded local video. The output must be a new file. */
export async function extractVideoAudio(inputPath: string, outputPath: string): Promise<void> {
  if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputPath) || path.resolve(inputPath) === path.resolve(outputPath)) {
    throw new Error('视频和音频路径必须是不同的本地绝对路径')
  }
  const input = await fs.lstat(inputPath)
  if (!input.isFile()) throw new Error('视频文件无效')
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg) throw new Error('本机 FFmpeg 不可用，无法提取视频音频')

  // Reserve the target before starting FFmpeg. Never overwrite a caller's existing file.
  const output = await fs.open(outputPath, 'wx', 0o600)
  await output.close()
  let complete = false
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(ffmpegPath, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', formats,
        '-i', inputPath, '-map', '0:a:0', '-t', '9.9', '-vn', '-ac', '1', '-ar', '24000',
        '-c:a', 'libmp3lame', '-b:a', '64k', '-fs', String(maxBytes), '-f', 'mp3', '-y', outputPath],
      { timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, windowsHide: true }, (error, _stdout, stderr) => {
        if (!error) return resolve()
        if (/matches no streams|does not contain any stream/i.test(stderr)) return reject(new Error('视频没有音频轨道，无法提取音频'))
        if (error.killed || error.signal === 'SIGKILL') return reject(new Error('提取视频音频超时'))
        return reject(new Error('提取视频音频失败，请确认视频文件有效'))
      })
    })
    const result = await fs.stat(outputPath)
    if (!result.isFile() || result.size === 0 || result.size >= maxBytes) throw new Error('提取的视频音频无效或过大')
    complete = true
  } finally {
    if (!complete) await fs.rm(outputPath, { force: true })
  }
}
