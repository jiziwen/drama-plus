import fs from 'node:fs/promises'
import path from 'node:path'
import { ffmpeg } from './ffmpeg.js'

export type TailShotRange = { shotStartSeconds: number; shotEndSeconds: number }

const width = 48, height = 32, pixelCount = width * height, frameBytes = pixelCount * 3
const maxSampleBytes = 24 * 1024 * 1024
const localVideoOptions = [
  '-protocol_whitelist file', '-format_whitelist mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
]

function isBlank(frame: Buffer) {
  let dark = 0, light = 0
  // Ignore the margins so encoded letterbox bars cannot hide a white flash.
  const insetX = 5, insetY = 5
  for (let y = insetY; y < height - insetY; y++) {
    for (let x = insetX; x < width - insetX; x++) {
      const i = (y * width + x) * 3
      if (Math.max(frame[i], frame[i + 1], frame[i + 2]) < 32) dark++
      if (Math.min(frame[i], frame[i + 1], frame[i + 2]) > 235) light++
    }
  }
  return Math.max(dark, light) >= (width - 2 * insetX) * (height - 2 * insetY) * .98
}

function frameDifference(a: Buffer, b: Buffer) {
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

/** Fade/dissolve colors move consistently toward a new image across several
 * frames. Ordinary motion changes individual pixels in different directions. */
function dissolveStart(frames: Buffer[], end: number) {
  let distance = 0, shift = 0, start = end
  for (; start > 0; start--) {
    const step = frameDifference(frames[start - 1], frames[start])
    if (step < .7 || step > 32) break
    const direct = frameDifference(frames[start - 1], frames[end])
    if (direct < .91 * (distance + step)) break
    distance += step
    shift = direct
  }
  if (end - start < 2 || shift < 22) return undefined
  const a = frames[start], b = frames[end]
  let changed = 0
  for (let i = 0; i < frameBytes; i += 3) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) >= 36) changed++
  }
  return changed >= pixelCount * .55 ? start : undefined
}

function selectLastFrame(pixels: Buffer, sameShot: boolean) {
  const frames: Buffer[] = []
  for (let offset = 0; offset < pixels.length; offset += frameBytes) {
    frames.push(pixels.subarray(offset, offset + frameBytes))
  }
  let end = frames.length - 1
  while (end >= 0 && isBlank(frames[end])) end--
  if (end < 0) return undefined

  // Only the formal final-shot window proves how far we can move backwards.
  if (!sameShot) return end === frames.length - 1 ? end : undefined

  // A brief terminal jump after continuous motion is treated as a transition.
  // A new image held through the ending can itself be a valid final picture.
  const limit = Math.max(2, end - 3)
  for (let i = end; i >= limit; i--) {
    if (!isBlank(frames[i - 1]) && frameDifference(frames[i - 1], frames[i]) > 36 &&
        !isBlank(frames[i - 2]) && frameDifference(frames[i - 2], frames[i - 1]) < 16) {
      end = i - 1
      break
    }
  }

  const next = frames[end + 1]
  let fadeEnd = next && isBlank(next) && frameDifference(frames[end], next) <= 32 ? end + 1 : end
  const holdLimit = Math.max(0, fadeEnd - 3)
  while (fadeEnd > holdLimit && frameDifference(frames[fadeEnd - 1], frames[fadeEnd]) < .7) fadeEnd--
  const fadeStart = dissolveStart(frames, fadeEnd)
  if (fadeStart === undefined) return end
  return fadeStart > 0 && !isBlank(frames[fadeStart]) ? fadeStart : undefined
}

function run(command: ReturnType<typeof ffmpeg>) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('tail frame extraction timed out')) }, 30_000)
    command.on('end', () => { clearTimeout(timer); resolve() })
      .on('error', error => { clearTimeout(timer); reject(error) }).run()
  })
}

/** Analyze every decoded frame in the final shot at thumbnail size, then
 * decode the selected native frame at full size using exactly the same seek. */
export async function writeStableTailFrame(input: string, folder: string, output: string, range?: TailShotRange) {
  const sample = path.join(folder, 'frames.rgb')
  const source = () => {
    const command = ffmpeg(input).inputOptions(localVideoOptions)
    if (range?.shotStartSeconds) command.seekInput(range.shotStartSeconds)
    return command.outputOptions(['-map 0:V:0', '-fps_mode passthrough'])
  }
  await run(source().outputOptions([
    `-vf scale=${width}:${height}:flags=area,format=rgb24`, '-c:v rawvideo', `-fs ${maxSampleBytes}`,
  ]).format('rawvideo').output(sample))
  const pixels = await fs.readFile(sample)
  if (!pixels.length || pixels.length >= maxSampleBytes || pixels.length % frameBytes) return false
  const index = selectLastFrame(pixels, !!range)
  if (index === undefined) return false
  await run(source().outputOptions([`-vf select=eq(n\\,${index})`, '-frames:v 1', '-q:v 2', '-update 1']).output(output))
  return true
}
