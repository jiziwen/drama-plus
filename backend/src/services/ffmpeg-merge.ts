/**
 * FFmpeg 多镜头拼接 — 将所有生成后的镜头视频拼接为一集
 */
import fs from 'fs'
import path from 'path'
import { v4 as uuid } from 'uuid'
import { db, getInsertId, schema } from '../db/index.js'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { FfprobeData, FfmpegCommand } from 'fluent-ffmpeg'
import { now } from '../utils/response.js'
import { logTaskError, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { extractVideoPoster } from '../utils/video-poster.js'
import { ffmpeg, checkFfmpegSuite } from '../utils/ffmpeg.js'
import { DATA_ROOT, STORAGE_ROOT } from '../utils/paths.js'

function toAbsPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) return relativePath
  if (relativePath.startsWith('static/')) return path.join(DATA_ROOT, relativePath)
  return path.join(STORAGE_ROOT, relativePath)
}

type MergeTarget = { episodeId: number; dramaId: number } | { scriptVideoEpisode: string }
const activeScriptMerges = new Set<number>()

/**
 * 拼接一集的镜头视频。
 * 优先使用视频生成产物，兼容历史的 composedVideoUrl 数据。
 * 传入 storyboardIds 时只拼接所选镜头（仍按镜号顺序）。
 */
export async function mergeEpisodeVideos(episodeId: number, dramaId: number, storyboardIds?: number[]): Promise<number> {
  let storyboards = await db.select().from(schema.storyboards)
    .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
    .orderBy(schema.storyboards.storyboardNumber)

  if (storyboardIds?.length) {
    const allow = new Set(storyboardIds.map(Number))
    storyboards = storyboards.filter(sb => allow.has(sb.id))
  }

  // 允许部分拼接:按镜号顺序拼接已生成的镜头,未生成的跳过
  const clips = storyboards
    .map(sb => ({ sb, url: sb.videoUrl || sb.composedVideoUrl }))
    .filter(c => Boolean(c.url)) as { sb: typeof storyboards[number]; url: string }[]

  if (clips.length === 0) throw new Error('所选镜头还没有可拼接的视频')

  // 校验视频文件真实存在:DB 里的 video_url 可能指向已被清理的文件,
  // 直接拼会得到 ffmpeg 的 "No such file or directory" 晦涩报错
  const missing = clips.filter(c => !fs.existsSync(toAbsPath(c.url)))
  if (missing.length > 0) {
    const nums = missing.map(c => `S${c.sb.storyboardNumber}`).join('、')
    throw new Error(`镜头 ${nums} 的视频文件已丢失（本地文件不存在），请重新生成这些镜头的视频，或在拼接时取消勾选`)
  }

  return queueVideoMerge(clips.map(c => c.url), { episodeId, dramaId })
}

export function getScriptVideoMerge(scriptVideoEpisode: string, id?: number) {
  const merge = db.select().from(schema.videoMerges)
    .where(and(eq(schema.videoMerges.taskId, scriptVideoEpisode), isNull(schema.videoMerges.deletedAt),
      id === undefined ? undefined : eq(schema.videoMerges.id, id)))
    .orderBy(desc(schema.videoMerges.id)).get()
  if (!merge) return null
  if (merge.status === 'processing' && !activeScriptMerges.has(merge.id)) {
    return { ...merge, status: 'failed', errorMsg: '拼接已中断，请重新导出。' }
  }
  return merge
}

export async function mergeScriptVideoClips(scriptVideoEpisode: string, videos: string[]) {
  return queueVideoMerge(videos, { scriptVideoEpisode })
}

async function queueVideoMerge(videos: string[], target: MergeTarget) {
  // Probe before invoking fluent-ffmpeg, which may throw on a broken executable.
  const suite = await checkFfmpegSuite()
  if (!suite.ffmpeg || !suite.ffprobe) {
    throw new Error('本机 ffmpeg 不可用，无法拼接视频。请确认 ffmpeg 与 ffprobe 已安装，或设置 FFMPEG_BIN 指向有效的可执行文件后重启服务。')
  }
  const scope = 'scriptVideoEpisode' in target ? target.scriptVideoEpisode : undefined
  const episode = 'episodeId' in target ? target : undefined
  if (scope) {
    const active = getScriptVideoMerge(scope)
    if (active?.status === 'processing') {
      if (active.scenes === JSON.stringify(videos)) return active.id
      throw new Error('该分集正在拼接，请等待当前导出完成。')
    }
  }
  const res = db.insert(schema.videoMerges).values({
    episodeId: episode?.episodeId,
    dramaId: episode?.dramaId,
    taskId: scope,
    title: episode ? `Episode ${episode.episodeId} Merge` : '剧本转视频成片',
    provider: 'ffmpeg',
    model: 'ffmpeg-concat-h264-aac',
    status: 'processing',
    scenes: JSON.stringify(videos),
    createdAt: now(),
  }).run()
  const mergeId = getInsertId(res)
  if (scope) activeScriptMerges.add(mergeId)
  logTaskStart('MergeTask', 'episode-merge', { mergeId, episodeId: episode?.episodeId, clips: videos.length })

  void doMerge(mergeId, videos, target).catch(async err => {
    logTaskError('MergeTask', 'episode-merge', { mergeId, episodeId: episode?.episodeId, error: err.message })
    await db.update(schema.videoMerges)
      .set({ status: 'failed', errorMsg: scope ? '视频拼接失败，请检查所选视频文件后重试。' : err.message })
      .where(eq(schema.videoMerges.id, mergeId))
  }).finally(() => activeScriptMerges.delete(mergeId)).catch(err => console.error('[Merge] Failed to write status', err))

  return mergeId
}

async function doMerge(mergeId: number, videos: string[], target: MergeTarget) {
  const tempRoot = path.join(STORAGE_ROOT, 'temp')
  const outputDir = path.join(STORAGE_ROOT, 'merged')
  await fs.promises.mkdir(outputDir, { recursive: true })
  await fs.promises.mkdir(tempRoot, { recursive: true })
  const workDir = await fs.promises.mkdtemp(path.join(tempRoot, 'merge-'))
  const outputFilename = `${uuid()}.mp4`
  const outputPath = path.join(outputDir, outputFilename)
  const scriptVideo = 'scriptVideoEpisode' in target
  const inputs = videos.map(toAbsPath)
  try {
    if (scriptVideo && inputs.length === 1 && path.extname(inputs[0]!) === '.mp4') {
      const metadata = await probeVideo(inputs[0]!)
      if (!(metadata.format.duration && metadata.format.duration > 0) ||
          !metadata.streams.some(stream => stream.codec_type === 'video' && stream.width && stream.height)) {
        throw new Error('视频文件缺少可播放的画面')
      }
      await fs.promises.copyFile(inputs[0]!, outputPath)
    } else {
      const sources = scriptVideo ? await normalizeClips(inputs, workDir) : inputs
      const listPath = path.join(workDir, 'clips.txt')
      const list = sources.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n')
      await fs.promises.writeFile(listPath, list)
      const command = ffmpeg().input(listPath).inputOptions(['-f concat', '-safe 0'])
      await encode(command.outputOptions(scriptVideo ? ['-c copy', '-movflags +faststart'] : [
        '-fflags +genpts', '-c:v libx264', '-preset medium', '-crf 23',
        '-c:a aac', '-ar 48000', '-b:a 192k', '-movflags +faststart',
      ]), outputPath)
    }
  } catch (error) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {})
  }

  // 获取时长
  const duration = await getVideoDuration(outputPath)

  const mergedRelative = `static/merged/${outputFilename}`

  // 成片海报帧（导出页封面用）
  await extractVideoPoster(mergedRelative)

  // 更新 merge 记录
  await db.update(schema.videoMerges)
    .set({ status: 'completed', mergedUrl: mergedRelative, duration, completedAt: now() })
    .where(eq(schema.videoMerges.id, mergeId))

  // 更新 episode
  const episodeId = 'episodeId' in target ? target.episodeId : undefined
  if (episodeId !== undefined) await db.update(schema.episodes)
    .set({ videoUrl: mergedRelative, updatedAt: now() })
    .where(eq(schema.episodes.id, episodeId))

  logTaskSuccess('MergeTask', 'episode-merge', { mergeId, episodeId, output: mergedRelative, duration, clips: videos.length })
}

async function normalizeClips(inputs: string[], workDir: string) {
  const first = await probeVideo(inputs[0]!)
  const picture = first.streams.find(stream => stream.codec_type === 'video')
  if (!picture?.width || !picture.height) throw new Error('缺少视频画面')
  const width = Math.ceil(picture.width / 2) * 2
  const height = Math.ceil(picture.height / 2) * 2
  const clips: string[] = []
  for (const [index, input] of inputs.entries()) {
    const metadata = index === 0 ? first : await probeVideo(input)
    const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio')
    const output = path.join(workDir, `clip-${index}.mp4`)
    const command = ffmpeg(input)
    if (!hasAudio) command.complexFilter('anullsrc=r=48000:cl=stereo[silence]')
    await encode(command.videoFilters([
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      'setsar=1', 'fps=30',
    ]).outputOptions([
      '-map 0:v:0', hasAudio ? '-map 0:a:0' : '-map [silence]',
      '-c:v libx264', '-preset veryfast', '-crf 23', '-pix_fmt yuv420p',
      '-c:a aac', '-ar 48000', '-ac 2', '-b:a 192k',
      ...(hasAudio ? ['-af apad'] : []), '-shortest',
    ]), output)
    clips.push(output)
  }
  return clips
}

function encode(command: FfmpegCommand, output: string) {
  return new Promise<void>((resolve, reject) => {
    command.output(output).on('end', () => resolve()).on('error', reject).run()
  })
}

function probeVideo(filePath: string) {
  return new Promise<FfprobeData>((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (error, metadata) => error ? reject(error) : resolve(metadata))
  })
}

function getVideoDuration(filePath: string): Promise<number> {
  return probeVideo(filePath).then(metadata => Math.round(metadata.format.duration || 0), () => 0)
}
