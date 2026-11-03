import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { eq } from 'drizzle-orm'
process.env.SQLITE_PATH = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-prompt-tools-')), 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { updateVideoPrompt } = await import('../src/agents/tools/storyboard-tools.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const ts = new Date().toISOString()
const board = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, sceneId: 9, description: '保持原描述', duration: 5, createdAt: ts, updatedAt: ts }).returning().get()
const invoke = updateVideoPrompt.execute as any
test('prompt generator can only update Chinese video_prompt and preserves bindings and other columns', async () => {
  const requestContext = buildAgentRequestContext({ episodeId: 1, dramaId: 1, language: 'en' })
  const result = await invoke({ storyboard_id: board.id, video_prompt: '柔和日光中，茶壶冒出细细蒸汽，镜头固定。', scene_id: null, duration: null }, { requestContext })
  assert.equal(result.saved, true)
  const row = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, board.id)).get()!
  assert.equal(row.sceneId, 9)
  assert.equal(row.duration, 5)
  assert.equal(row.description, '保持原描述')
  assert.match(row.videoPrompt!, /茶壶/)
  assert.match((await invoke({ storyboard_id: board.id, video_prompt: 'A red teapot on a table.' }, { requestContext })).error, /简体中文/)
  const forbidden = await invoke({ storyboard_id: board.id, video_prompt: '中文提示词' }, { requestContext: buildAgentRequestContext({ episodeId: 2, dramaId: 1 }) })
  assert.match(forbidden.error, /不属于当前集/)
})
