import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-export-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
const require = createRequire(import.meta.url)
const ffmpeg = process.env.FFMPEG_BIN || require('ffmpeg-static') as string
const ffprobe = process.env.FFPROBE_BIN || require('ffprobe-static').path as string
const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
const store = new ScriptVideoStore(path.join(root, 'projects'))
const routes = createScriptVideoRoutes(store)
after(() => fs.rm(root, { recursive: true, force: true }))

function card(id: string, status: string, videoUrl?: string) {
  return { id, title: id, status, videoUrl, duration: 1, summary: '', prompt: '', shots: [], assetIds: [], version: 1 }
}
type ExportState = { id: number; status: string; videoUrl?: string; error?: string }
async function readExport(url: string) {
  const response = await routes.request(url)
  return ((await response.json()) as { data: { merge: ExportState | null } }).data.merge
}
async function finishExport(url: string, id: number) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await readExport(`${url}?id=${id}`)
    if (state?.status !== 'processing') return state
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error('等待视频拼接超时')
}

test('video export joins current and previous renders in episode order and refuses unavailable files', { timeout: 30_000 }, async () => {
  const videos = path.join(root, 'static/videos')
  await fs.mkdir(videos, { recursive: true })
  await fs.writeFile(path.join(videos, 'broken.mp4'), 'Truncated file')
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=128x72:r=24:d=1',
    '-c:v', 'libx264', path.join(videos, 'first.mp4')])
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=72x128:r=25:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', path.join(videos, 'second.mp4')])
  const project = await store.create('合成测试')
  const episode = project.episodes[0]
  await store.mutate(project.id, ({ project }) => {
    const target = project.episodes[0]
    target.cards = [
      card('first', 'ready', '/static/videos/first.mp4'),
      card('pending', 'draft'),
      card('second', 'draft', '/static/videos/first.mp4'),
      card('legacy', 'draft', '/static/videos/first.mp4'),
      card('missing', 'ready', '/static/videos/missing.mp4'),
      card('outside', 'draft', '/static/videos/first.mp4'),
      card('broken', 'ready', '/static/videos/broken.mp4'),
    ]
    target.tasks = [
      { id: 'first-history', cardId: 'first', status: 'completed', videoUrl: '/static/videos/second.mp4' },
      { id: 'second-old', cardId: 'second', status: 'completed', videoUrl: '/static/videos/first.mp4' },
      { id: 'second-history', cardId: 'second', status: 'completed', videoUrl: '/static/videos/second.mp4', staleResult: true },
      { id: 'second-active', cardId: 'second', status: 'processing' },
      { id: 'pending-active', cardId: 'pending', status: 'processing' },
      { id: 'outside-history', cardId: 'outside', status: 'completed', videoUrl: '/static/uploads/first.mp4' },
    ]
    return { result: null, documentChanged: true }
  })
  const url = `/projects/${project.id}/episodes/${episode.id}/video-export`
  const submit = (cardIds: string[]) => routes.request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardIds }),
  })
  assert.equal(await readExport(url), null)
  for (const invalid of [[], ['pending'], ['missing'], ['outside'], ['first', 'first']])
    assert.equal((await submit(invalid)).status, 400)
  assert.equal((await submit(['unknown'])).status, 409)
  const started = await submit(['second', 'first'])
  assert.equal(started.status, 201)
  const { data: { id } } = await started.json() as { data: { id: number } }
  const state = await finishExport(url, id)
  assert.equal(state?.status, 'completed', state?.error)
  assert.match(state?.videoUrl || '', /^\/static\/merged\/[a-f\d-]+\.mp4$/)
  const output = path.join(root, state!.videoUrl!.slice(1))
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }))
  assert.deepEqual(info.streams.map((stream: { codec_type: string }) => stream.codec_type), ['video', 'audio'])
  assert.ok(Number(info.format.duration) >= 1.95 && Number(info.format.duration) <= 2.2)
  const sample = (timestamp: string) => execFileSync(ffmpeg, ['-v', 'error', '-ss', timestamp, '-i', output,
    '-vf', 'crop=2:2:64:36,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'])
  const first = sample('0.4')
  const second = sample('1.4')
  assert.ok(first[0]! > 200 && first[2]! < 60, 'first selected file follows episode order')
  assert.ok(second[2]! > 200 && second[0]! < 60, 'second clip follows first')

  const legacy = await submit(['legacy'])
  assert.equal(legacy.status, 201)
  const { data: { id: legacyId } } = await legacy.json() as { data: { id: number } }
  const legacyExport = await finishExport(url, legacyId)
  assert.equal(legacyExport?.status, 'completed', legacyExport?.error)
  assert.deepEqual(await fs.readFile(path.join(root, legacyExport!.videoUrl!.slice(1))), await fs.readFile(path.join(videos, 'first.mp4')))

  const later = await submit(['broken'])
  assert.equal(later.status, 201)
  const { data: { id: brokenId } } = await later.json() as { data: { id: number } }
  assert.equal((await finishExport(url, brokenId))?.status, 'failed')
  assert.equal((await readExport(url))?.id, brokenId)
  assert.equal((await readExport(`${url}?id=${id}`))?.videoUrl, state!.videoUrl)
})

test('deleting a segment removes its task row, while an active render blocks deletion', async () => {
  const project = await store.create('删除测试')
  await store.mutate(project.id, ({ project }) => {
    const episode = project.episodes[0]
    episode.cards = [card('keep', 'draft'), card('remove', 'draft'), card('running', 'draft')]
    episode.tasks = [
      { id: 'finished-task', cardId: 'remove', status: 'completed' },
      { id: 'active-task', cardId: 'running', status: 'processing' },
    ]
    return { result: null, documentChanged: true }
  })
  const next = await store.get(project.id)
  next.episodes[0].cards = [card('keep', 'draft')]
  await assert.rejects(store.update(project.id, next, next.revision), { code: 'VIDEO_RUNNING' })
  next.episodes[0].cards.push(card('running', 'draft'))
  const saved = await store.update(project.id, next, next.revision)
  assert.deepEqual(saved.episodes[0].tasks.map((task: { id: string }) => task.id), ['active-task'])
})
