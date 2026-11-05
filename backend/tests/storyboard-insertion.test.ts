import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-insert-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { default: storyboards } = await import('../src/routes/storyboards.js')
const ts = new Date().toISOString()
db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
for (const id of [1, 2]) db.insert(schema.episodes).values({ id, dramaId: 1, episodeNumber: id, title: 'test', createdAt: ts, updatedAt: ts }).run()
const create = async (body: object) => {
  const res = await storyboards.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as any }
}
const rows = (episodeId = 1) => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).orderBy(schema.storyboards.storyboardNumber, schema.storyboards.id).all()

test('insert at any list position, append by default, and preserve existing references', async () => {
  const first = await create({ episode_id: 1 })
  assert.equal(first.status, 201)
  const firstId = first.body.data.id
  db.update(schema.storyboards).set({ storyboardNumber: 7, videoUrl: 'static/video.mp4' }).where(eq(schema.storyboards.id, firstId)).run()
  db.insert(schema.storyboardCharacters).values({ storyboardId: firstId, characterId: 9 }).run()
  const old = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 7, createdAt: ts, updatedAt: ts }).returning().get()
  const other = db.insert(schema.storyboards).values({ episodeId: 2, storyboardNumber: 42, createdAt: ts, updatedAt: ts }).returning().get()
  const middle = await create({ episode_id: 1, insert_position: 2 })
  assert.equal(middle.status, 201)
  assert.deepEqual(rows().map(s => [s.id, s.storyboardNumber]), [[firstId, 1], [middle.body.data.id, 2], [old.id, 3]])
  assert.equal(rows()[0].videoUrl, 'static/video.mp4')
  assert.equal(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, firstId)).get()?.characterId, 9)
  assert.equal(rows(2)[0].storyboardNumber, 42)
  const head = await create({ episode_id: 1, insert_position: 1 })
  const tail = await create({ episode_id: 1 })
  assert.deepEqual(rows().map(s => s.id), [head.body.data.id, firstId, middle.body.data.id, old.id, tail.body.data.id])
  assert.deepEqual(rows().map(s => s.storyboardNumber), [1, 2, 3, 4, 5])
  assert.equal(rows(2)[0].id, other.id)
  for (const position of [0, 7, 1.5, '2']) assert.equal((await create({ episode_id: 1, insert_position: position })).status, 400)
  assert.equal(rows().length, 5)
  db.run(sql`CREATE TRIGGER reject_new_storyboard BEFORE INSERT ON storyboards BEGIN SELECT RAISE(ABORT, 'test failure'); END`)
  const failed = await storyboards.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episode_id: 1, insert_position: 1 }) })
  assert.equal(failed.status, 500)
  assert.deepEqual(rows().map(s => s.storyboardNumber), [1, 2, 3, 4, 5])
})
