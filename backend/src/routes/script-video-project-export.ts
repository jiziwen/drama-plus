import { randomUUID } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import type { Context, Hono } from 'hono'
import { ZipFile } from 'yazl'
import type { ScriptVideoCard } from '../services/script-video-types.js'
import { latestScriptVideoTaskUrls, selectScriptVideoPlayback } from '../services/script-video-versions.js'
import { ScriptVideoStoreError, type ScriptVideoProject, type ScriptVideoStore } from '../services/script-video-store.js'
import { created, success } from '../utils/response.js'
import { resolveStoredVideo } from '../utils/video-poster.js'

type SourceVideo = NonNullable<Awaited<ReturnType<typeof resolveStoredVideo>>>
type ArchiveFile = { name: string; source: SourceVideo }
type PendingArchive = { projectId: string; filename: string; files: ArchiveFile[]; expiresAt: number }

function archiveName(value: unknown) {
  if (typeof value !== 'string') return ''
  const cleaned = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\ud800-\udfff]/gu, '-').trim()
  return [...cleaned].slice(0, 70).join('').replace(/[. ]+$/u, '')
}

async function availableClips(episode: ScriptVideoProject['episodes'][number], selected?: Set<string>) {
  const completed = latestScriptVideoTaskUrls(episode.tasks)
  const cards: ScriptVideoCard[] = episode.cards
  const clips = await Promise.all(cards.map(async (card, index) => {
    if (selected && !selected.has(card.id)) return
    const playback = selectScriptVideoPlayback(card, completed.get(card.id))
    if (!playback) return
    const source = await resolveStoredVideo(playback.url).catch(() => null)
    if (!source) return
    return { id: card.id, title: card.title, index: index + 1, kind: playback.kind, source }
  }))
  return clips.filter(clip => clip !== undefined)
}

function selectedEpisodes(input: unknown, project: ScriptVideoProject) {
  if (!Array.isArray(input) || !input.length || input.length > project.episodes.length) {
    throw new ScriptVideoStoreError('请选择要导出的分集和视频。')
  }
  const selected = new Map<string, Set<string>>()
  for (const item of input) {
    if (!item || typeof item.episodeId !== 'string' || selected.has(item.episodeId) ||
        !Array.isArray(item.cardIds) || !item.cardIds.length || item.cardIds.some((id: unknown) => typeof id !== 'string') ||
        new Set(item.cardIds).size !== item.cardIds.length) {
      throw new ScriptVideoStoreError('所选视频参数无效，请重新选择。')
    }
    selected.set(item.episodeId, new Set(item.cardIds))
  }
  return selected
}

async function archiveFiles(project: ScriptVideoProject, selected: Map<string, Set<string>>) {
  const files: ArchiveFile[] = []
  const folderNames = new Set<string>()
  for (const [index, episode] of project.episodes.entries()) {
    const cardIds = selected.get(episode.id)
    if (!cardIds) continue
    selected.delete(episode.id)
    const number = `第${episodeNumber(episode, index)}集`, title = archiveName(episode.title)
    const label = title ? `${number}-${title}` : number
    let folder = label
    for (let suffix = 2; folderNames.has(folder.toLowerCase()); suffix++) folder = `${label}-${suffix}`
    folderNames.add(folder.toLowerCase())
    for (const clip of await availableClips(episode, cardIds)) {
      cardIds.delete(clip.id)
      const name = `片段${String(clip.index).padStart(2, '0')}`, title = archiveName(clip.title)
      files.push({ name: `${folder}/${title ? `${name}-${title}` : name}${extname(clip.source.input).toLowerCase()}`, source: clip.source })
    }
    if (cardIds.size) throw new ScriptVideoStoreError(`${number}的所选视频已变更或无法读取，请重新选择。`, 409, 'CLIPS_CHANGED')
  }
  if (selected.size) throw new ScriptVideoStoreError('所选分集已变更，请重新选择。', 409, 'CLIPS_CHANGED')
  return files
}

function episodeNumber(episode: ScriptVideoProject['episodes'][number], index: number) {
  return Number.isSafeInteger(episode.number) && episode.number > 0 ? episode.number : index + 1
}

async function streamArchive({ filename, files }: PendingArchive) {
  const zip = new ZipFile()
  const output = zip.outputStream as Readable
  let active: ReadStream | undefined
  output.once('close', () => active?.destroy())
  zip.on('error', (error: Error) => output.destroy(error))
  const stream = Readable.toWeb(output, { strategy: { highWaterMark: 128 * 1024, size: (chunk: Uint8Array) => chunk.byteLength } })
  for (const { name, source } of files) {
    zip.addReadStreamLazy(name, { size: source.stat.size, mtime: source.stat.mtime, compress: false }, ready => {
      if (output.destroyed) return
      const input = createReadStream(source.input)
      active = input
      input.once('error', error => output.destroy(error))
      ready(null, input)
    })
  }
  const size = await new Promise<number>(resolve => zip.end(undefined, (total = -1) => resolve(total)))
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return new Response(stream as ReadableStream<Uint8Array>, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="videos.zip"; filename*=UTF-8''${encoded}`,
      ...(size >= 0 && { 'Content-Length': String(size) }),
    },
  })
}

export function registerScriptVideoProjectExportRoutes(
  app: Hono,
  store: ScriptVideoStore,
  respondError: (c: Context, error: unknown) => Response,
) {
  const pending = new Map<string, PendingArchive>()

  app.get('/projects/:id/video-archive', async c => {
    try {
      const project = await store.get(c.req.param('id'))
      const episodes = []
      for (const [index, episode] of project.episodes.entries()) {
        const { id, title } = episode
        const clips = await availableClips(episode)
        episodes.push({ id, number: episodeNumber(episode, index), title, clips: clips.map(({ source: _source, ...clip }) => clip) })
      }
      c.header('Cache-Control', 'no-store')
      return success(c, { episodes })
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.post('/projects/:id/video-archive', async c => {
    try {
      const project = await store.get(c.req.param('id'))
      const body = await c.req.json().catch(() => null)
      const files = await archiveFiles(project, selectedEpisodes(body?.episodes, project))
      const now = Date.now()
      for (const [token, entry] of pending) if (entry.expiresAt <= now) pending.delete(token)
      if (pending.size >= 64) pending.delete(pending.keys().next().value!)
      const token = randomUUID()
      pending.set(token, {
        projectId: project.id, files, expiresAt: now + 5 * 60_000,
        filename: `${archiveName(project.title) || '项目'}-视频.zip`,
      })
      return created(c, { token })
    } catch (error) {
      return respondError(c, error)
    }
  })

  app.get('/projects/:id/video-archive/:token', async c => {
    const { id, token } = c.req.param()
    try {
      const archive = pending.get(token)
      if (!archive || archive.projectId !== id || archive.expiresAt <= Date.now()) {
        throw new ScriptVideoStoreError('该下载已失效，请重新导出。', 404, 'NOT_FOUND')
      }
      return await streamArchive(archive)
    } catch (error) {
      return respondError(c, error)
    }
  })
}
