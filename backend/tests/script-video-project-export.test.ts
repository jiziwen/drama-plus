import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { crc32 } from 'node:zlib'

function readZip(bytes: Buffer) {
  const end = bytes.length - 22
  assert.equal(bytes.readUInt32LE(end), 0x06054b50)
  const count = bytes.readUInt16LE(end + 10)
  let offset = bytes.readUInt32LE(end + 16)
  const files = new Map<string, string>()
  for (let i = 0; i < count; ++i) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50)
    assert.equal(bytes.readUInt16LE(offset + 10), 0, 'already-encoded video is stored without recompression')
    const nameLength = bytes.readUInt16LE(offset + 28)
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)
    const local = bytes.readUInt32LE(offset + 42)
    assert.equal(bytes.readUInt32LE(local), 0x04034b50)
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    const data = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20))
    assert.equal(bytes.readUInt32LE(offset + 16), crc32(data), 'archive checksum matches file contents')
    files.set(name, data.toString())
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32)
  }
  assert.equal(offset, end)
  return files
}

test('项目按集和片段导出可读的当前及历史成片，ZIP 中重名分集独立保存', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-project-export-'))
  process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
  process.env.STORAGE_PATH = path.join(root, 'static')
  process.env.HUOBAO_DATA_DIR = root
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const stores = new Set<InstanceType<typeof ScriptVideoStore>>()
  const getQueue = Object.getOwnPropertyDescriptor(ScriptVideoStore.prototype, 'queue')!.get!
  t.mock.getter(ScriptVideoStore.prototype, 'queue', function (this: InstanceType<typeof ScriptVideoStore>) {
    stores.add(this)
    return getQueue.call(this)
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const { db } = await import('../src/db/index.js')
  const store = new ScriptVideoStore(path.join(root, 'projects'))
  const app = createScriptVideoRoutes(store)
  t.after(async () => {
    await Promise.all([...stores].map(item => item.close()))
    db.$client.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const videos = path.join(root, 'static/videos')
  await fs.mkdir(videos, { recursive: true })
  for (const file of ['official.mp4', 'selected.mp4', 'newer.mp4', 'other.webm', 'omitted.mp4']) await fs.writeFile(path.join(videos, file), file)
  const project = await store.create('导出/测试')
  const firstId = project.episodeId
  const secondId = 'second-episode', emptyId = 'empty-episode'
  const video = (name: string) => `/static/videos/${name}`
  const card = (id: string, title: string, status: string, videoUrl?: string) =>
    ({ id, title, status, videoUrl, duration: 1, summary: '', prompt: '', shots: [], assetIds: [], version: 1 })
  await store.mutate(project.id, ({ project }) => {
    const first = project.episodes[0]
    first.title = '同/一集'
    first.cards = [
      card('first', '门/外', 'ready', video('official.mp4')),
      { ...card('previous', '门内', 'draft', video('selected.mp4')), videoVersions: [{ url: video('selected.mp4') }] },
      card('missing', '已丢失', 'ready', video('missing.mp4')),
      card('outside', '非生成视频', 'ready', '/static/uploads/official.mp4'),
      card('pending', '未完成', 'draft'),
    ]
    first.tasks = [{ id: 'history', cardId: 'previous', status: 'completed', videoUrl: video('newer.mp4') }]
    project.episodes.push(
      { ...first, id: secondId, tasks: [], cards: [card('first', '叫门', 'ready', video('other.webm')), card('omitted', '留空', 'ready', video('omitted.mp4'))] },
      { ...first, id: emptyId, number: 3, title: '未制作', tasks: [], cards: [card('draft', '待做', 'draft')] },
    )
    return { result: null, documentChanged: true }
  })

  const url = `/projects/${project.id}/video-archive`
  const listing = await app.request(url)
  assert.equal(listing.status, 200)
  const { data: { episodes } } = await listing.json() as { data: { episodes: { id: string; clips: { id: string; kind: string }[] }[] } }
  assert.deepEqual(episodes.map(ep => [ep.id, ep.clips.map(clip => [clip.id, clip.kind])]), [
    [firstId, [['first', 'current'], ['previous', 'previous']]],
    [secondId, [['first', 'current'], ['omitted', 'current']]],
    [emptyId, []],
  ])

  const submit = (episodes: unknown[]) => app.request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodes }),
  })
  assert.equal((await submit([])).status, 400)
  assert.equal((await submit([{ episodeId: secondId, cardIds: ['first', 'first'] }])).status, 400)
  assert.equal((await submit([{ episodeId: firstId, cardIds: ['pending'] }])).status, 409)
  assert.equal((await submit([{ episodeId: firstId, cardIds: ['missing'] }])).status, 409)
  const saved = await submit([{ episodeId: secondId, cardIds: ['first'] }, { episodeId: firstId, cardIds: ['previous', 'first'] }])
  assert.equal(saved.status, 201)
  const { data: { token } } = await saved.json() as { data: { token: string } }
  assert.equal((await app.request(`/projects/another-project/video-archive/${token}`)).status, 404)
  const download = await app.request(`${url}/${token}`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('Content-Type'), 'application/zip')
  assert.match(decodeURIComponent(download.headers.get('Content-Disposition') || ''), /导出-测试-视频\.zip$/u)
  const bytes = Buffer.from(await download.arrayBuffer())
  assert.equal(Number(download.headers.get('Content-Length')), bytes.length)
  assert.deepEqual([...readZip(bytes)], [
    ['第1集-同-一集/片段01-门-外.mp4', 'official.mp4'],
    ['第1集-同-一集/片段02-门内.mp4', 'selected.mp4'],
    ['第1集-同-一集-2/片段01-叫门.webm', 'other.webm'],
  ])
})
