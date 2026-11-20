import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { checkFfmpegSuite, ffmpeg } from './ffmpeg.js'
import { STORAGE_ROOT } from './paths.js'
import { hasJpeg, resolveStoredVideo } from './video-poster.js'

const pending = new Map<string, Promise<string | null>>()
const width = 96, height = 64, samples = 5

type Tone = { shadows: number; median: number; highlights: number; warmth: number }
type Lighting = { whole: Tone; subjectAreas: Tone[]; detail: number }
type PixelRegion = { lumas: number[]; warmth: number }

function tone(region: PixelRegion): Tone {
  const values = region.lumas.sort((a, b) => a - b)
  const percentile = (fraction: number) => values[Math.floor((values.length - 1) * fraction)]
  return { shadows: percentile(.12), median: percentile(.5), highlights: percentile(.85), warmth: region.warmth / values.length }
}

/** Summarize the whole image and three interior regions where subjects can be
 * framed after a reverse angle. These are color statistics, not a face detector. */
async function inspectFrame(file: string): Promise<Lighting | null> {
  const pixels = await sharp(file).resize(width, height, { fit: 'fill' }).toColourspace('srgb').removeAlpha().raw().toBuffer()
  const whole: PixelRegion = { lumas: [], warmth: 0 }
  const areas: PixelRegion[] = Array.from({ length: 3 }, () => ({ lumas: [], warmth: 0 }))
  const lumas = new Uint8Array(width * height)
  let detailSum = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x, offset = index * 3
      const r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2]
      const luma = Math.round(.2126 * r + .7152 * g + .0722 * b)
      lumas[index] = luma
      whole.lumas.push(luma)
      whole.warmth += r - b
      if (x >= 9 && x < 87 && y >= 13 && y < 48) {
        const area = areas[Math.floor((x - 9) / 26)]
        area.lumas.push(luma)
        area.warmth += r - b
      }
      if (x >= 2 && y >= 2) {
        detailSum += Math.abs(luma - 2 * lumas[index - 1] + lumas[index - 2])
          + Math.abs(luma - 2 * lumas[index - width] + lumas[index - 2 * width])
      }
    }
  }
  const detail = detailSum / (2 * (width - 2) * (height - 2))
  const distribution = tone(whole)
  const low = whole.lumas[Math.floor(whole.lumas.length * .02)]
  const high = whole.lumas[Math.floor(whole.lumas.length * .98)]
  if (high < 24 || low > 235 || high - low < 22 || detail < 1.2) return null
  return { whole: distribution, subjectAreas: areas.map(tone), detail }
}

function distance(a: Tone, b: Tone) {
  return Math.abs(a.median - b.median) + Math.abs(a.highlights - b.highlights)
    + Math.abs(a.shadows - b.shadows) + Math.abs(a.warmth - b.warmth)
}

async function sampleShot(input: string, folder: string, start: number, span: number) {
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg(input).seekInput(start)
      .inputOptions(['-protocol_whitelist file', '-format_whitelist mov,mp4,m4a,3gp,3g2,mj2,matroska,webm', `-t ${span}`])
      .outputOptions(['-map 0:V:0', `-vf fps=${samples / span}:eof_action=pass`, `-frames:v ${samples}`, '-q:v 2'])
      .output(path.join(folder, '%02d.jpg'))
    const timer = setTimeout(() => { command.kill('SIGKILL'); reject(new Error('lighting frame extraction timed out')) }, 30_000)
    command.on('end', () => { clearTimeout(timer); resolve() })
      .on('error', error => { clearTimeout(timer); reject(error) }).run()
  })
}

/** Keep the full-resolution stable picture nearest the other usable samples,
 * preferring a sharper candidate when their lighting is essentially identical. */
async function selectFrame(folder: string) {
  const names = (await fs.readdir(folder)).sort()
  const candidates: Array<{ file: string; frame: Lighting; index: number }> = []
  for (const [index, name] of names.entries()) {
    const file = path.join(folder, name)
    const frame = await inspectFrame(file)
    if (frame) candidates.push({ file, frame, index })
  }
  if (!candidates.length) return null
  const details = candidates.map(item => item.frame.detail).sort((a, b) => a - b)
  const minimumDetail = details[Math.floor(details.length / 2)] * .55
  const middle = (names.length - 1) / 2
  const scores = candidates.map(({ file, frame, index }) => {
    const score = candidates.reduce((sum, item) => sum + distance(frame.whole, item.frame.whole), 0) / candidates.length
    // A single crossfade frame can be the mathematical midpoint between two
    // stable shots. Require a nearby sample to corroborate its lighting.
    const adjacentDistances = candidates.filter(item => Math.abs(item.index - index) === 1)
      .map(item => distance(frame.whole, item.frame.whole))
    const adjacent = names.length === 1 ? 0 : Math.min(...adjacentDistances)
    return { file, detail: frame.detail, adjacent, score: score + adjacent - Math.min(12, frame.detail) * .3 + Math.abs(index - middle) * .1 }
  }).filter(item => item.detail >= minimumDetail && item.adjacent <= 75)
  return scores.sort((a, b) => a.score - b.score)[0]?.file ?? null
}

export async function extractVideoLightingFrame(source: string, startSeconds: number, endSeconds: number): Promise<string | null> {
  const start = Math.round(startSeconds * 1000), end = Math.round(endSeconds * 1000)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null
  try {
    const local = await resolveStoredVideo(source)
    if (!local) return null
    const { input, videos, stat } = local
    const key = createHash('sha256').update(JSON.stringify(['lighting-v1', input, stat.ino, stat.size, stat.mtimeMs, start, end])).digest('hex')
    const name = key + '_lighting.jpg', output = path.join(videos, name)
    const cached = pending.get(output)
    if (cached) return cached
    const url = '/static/videos/' + name
    const operation = (async () => {
      if ((await fs.lstat(output).catch(() => null))?.isFile() && await hasJpeg(output)) return url
      if (!(await checkFfmpegSuite()).ffmpeg) return null
      const folder = await fs.mkdtemp(path.join(videos, '.lighting-'))
      try {
        await sampleShot(input, folder, start / 1000, (end - start) / 1000)
        const selected = await selectFrame(folder)
        if (!selected) return null
        await fs.rename(selected, output)
        return url
      } finally { await fs.rm(folder, { recursive: true, force: true }) }
    })().catch(() => null).finally(() => { pending.delete(output) })
    pending.set(output, operation)
    return operation
  } catch { return null }
}

async function inspectStoredFrame(url: string) {
  const name = /^\/?static\/videos\/([a-f\d]{64}_(?:lighting|tail)\.jpg)$/u.exec(url)?.[1]
  if (!name) return null
  const videos = path.join(await fs.realpath(STORAGE_ROOT), 'videos')
  const file = await fs.realpath(path.join(videos, name))
  if (!file.startsWith(videos + path.sep)) return null
  return inspectFrame(file)
}

/** A review hint requires a large change across most of the subject area as
 * well as the whole image. Extra sky/highlights from reframing alone do not qualify. */
export async function compareVideoLightingFrames(referenceUrl: string, shotFrameUrl: string): Promise<'review' | 'similar' | 'unknown'> {
  try {
    const [a, b] = await Promise.all([inspectStoredFrame(referenceUrl), inspectStoredFrame(shotFrameUrl)])
    if (!a || !b) return 'unknown'
    const exposure = b.whole.median - a.whole.median, cast = b.whole.warmth - a.whole.warmth
    const brighterOrDarker = Math.sign(exposure)
    const exposureVotes = a.subjectAreas.filter((area, i) => {
      const next = b.subjectAreas[i]
      return brighterOrDarker * (next.median - area.median) >= 26
        && brighterOrDarker * (next.highlights - area.highlights) >= 24
    }).length
    const castVotes = a.subjectAreas.filter((area, i) =>
      Math.sign(cast) * (b.subjectAreas[i].warmth - area.warmth) >= 26).length
    const exposureShift = Math.abs(exposure) >= 35 && exposureVotes >= 2 && (Math.abs(cast) >= 12 || Math.abs(exposure) >= 48)
    const castShift = Math.abs(cast) >= 40 && castVotes >= 2
    return exposureShift || castShift ? 'review' : 'similar'
  } catch { return 'unknown' }
}
