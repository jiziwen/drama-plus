import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-duration-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { default: app } = await import('../src/routes/storyboards.js')
const ts = new Date().toISOString()
db.insert(schema.dramas).values({ id: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'test', createdAt: ts, updatedAt: ts }).run()

const send = (url: string, method: string, body: object) => app.request(url, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

test('手动设置分镜时长只接受整数，但不改变已保存的实际视频时长', async () => {
  assert.equal((await send('/', 'POST', { episode_id: 1, duration: 12.25 })).status, 400)
  const created = await send('/', 'POST', { episode_id: 1, duration: 12 })
  assert.equal(created.status, 201)
  const { data } = await created.json() as any
  db.update(schema.storyboards).set({ duration: 12.25 }).where(eq(schema.storyboards.id, data.id)).run()
  assert.equal((await send(`/${data.id}`, 'PUT', { description: '新描述' })).status, 200)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, data.id)).get()?.duration, 12.25)
  for (const duration of [12.25, '12', null]) {
    assert.equal((await send(`/${data.id}`, 'PUT', { duration })).status, 400)
    assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, data.id)).get()?.duration, 12.25)
  }
  assert.equal((await send(`/${data.id}`, 'PUT', { duration: 13 })).status, 200)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, data.id)).get()?.duration, 13)
})
