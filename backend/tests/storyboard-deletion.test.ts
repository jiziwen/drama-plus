import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-trash-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { default: storyboards } = await import('../src/routes/storyboards.js')
const { default: episodes } = await import('../src/routes/episodes.js')
const { recoverVideoTask } = await import('../src/services/generation.js')
const ts = new Date().toISOString()
const shot = (number: number) => db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: number, description: `镜头${number}`, videoUrl: 'static/videos/test.mp4', createdAt: ts, updatedAt: ts }).returning().get()
const request = (url: string, method = 'GET') => storyboards.request(url, { method })
test('删除进入回收站，保留关联与视频文件，恢复到原位置', async () => {
  const dir = path.join(root, 'static', 'videos'); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'test.mp4'), 'video')
  const a = shot(1), b = shot(2), c = shot(3)
  db.insert(schema.storyboardCharacters).values({ storyboardId: b.id, characterId: 5 }).run()
  const task = db.insert(schema.sysTask).values({ storyboardId: b.id, type: 'video', status: 'completed', localPath: 'static/videos/test.mp4', createdAt: ts, updatedAt: ts }).returning().get()
  assert.equal((await request(`/${b.id}`, 'DELETE')).status, 200)
  assert.ok(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,b.id)).get()?.deletedAt)
  assert.ok(db.select().from(schema.sysTask).where(eq(schema.sysTask.id,task.id)).get())
  assert.ok(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId,b.id)).get())
  await fs.access(path.join(dir,'test.mp4'))
  const trash:any = await (await request('/trash?episode_id=1')).json(); assert.deepEqual(trash.data.map((r:any)=>r.id),[b.id])
  const list:any = await (await episodes.request('/1/storyboards')).json(); assert.deepEqual(list.data.map((r:any)=>r.id),[a.id,c.id])
  assert.equal((await request(`/${b.id}/restore`, 'POST')).status, 200)
  const restored:any = await (await episodes.request('/1/storyboards')).json(); assert.deepEqual(restored.data.map((r:any)=>r.id),[a.id,b.id,c.id])
  assert.deepEqual(restored.data.map((r:any)=>r.storyboard_number),[1,2,3])
  assert.equal((await request(`/${b.id}/restore`, 'POST')).status,400)
})
test('运行中的生成任务阻止删除', async () => {
  const s = shot(4); db.insert(schema.sysTask).values({ storyboardId:s.id,type:'video',status:'processing',createdAt:ts,updatedAt:ts }).run()
  assert.equal((await request(`/${s.id}`,'DELETE')).status,400)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,s.id)).get()?.deletedAt,null)
})

test('回收站中的分镜不能恢复生成任务', async () => {
  const s = shot(5)
  const task = db.insert(schema.sysTask).values({ storyboardId:s.id,type:'video',status:'failed',resultUrl:'https://example.com/video.mp4',createdAt:ts,updatedAt:ts }).returning().get()
  assert.equal((await request(`/${s.id}`,'DELETE')).status,200)
  await assert.rejects(recoverVideoTask(task.id), /回收站恢复/)
})
