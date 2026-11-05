import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-storyboard-tools-'))
process.env.SQLITE_PATH = path.join(root, 'isolated.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { storyboardTools, updateVideoPrompt } = await import('../src/agents/tools/storyboard-tools.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const ts = new Date().toISOString()
after(async () => {
  db.$client.close()
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
  await fs.rm(root, { recursive: true, force: true })
})
let nextEpisode = 500
function fixture() {
  const episodeId = nextEpisode++
  db.insert(schema.episodes).values({ id: episodeId, dramaId: episodeId, episodeNumber: 1, title: '隔离测试', scriptContent: '阿明：你好。\n阿明走进院子。', duration: 5, createdAt: ts, updatedAt: ts }).run()
  const character = db.insert(schema.characters).values({ dramaId: episodeId, name: '阿明', createdAt: ts, updatedAt: ts }).returning().get()
  const old = db.insert(schema.storyboards).values({ episodeId, storyboardNumber: 1, title: '旧分镜', duration: 252, videoUrl: '/static/old.mp4', createdAt: ts, updatedAt: ts }).returning().get()
  db.insert(schema.storyboardCharacters).values({ storyboardId: old.id, characterId: character.id }).run()
  const rc = buildAgentRequestContext({ episodeId, dramaId: episodeId })
  return { episodeId, character, old, rc }
}
const invoke = (tool: keyof typeof storyboardTools, input: unknown, requestContext: any) => (storyboardTools[tool].execute as any)(input, { requestContext })
const rows = (episodeId: number) => db.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all().filter(row => !row.deletedAt)

test('read then save works without a plan, beat ids or timing validation; omitted duration keeps the original default of 10 seconds', async () => {
  const f = fixture()
  assert.equal('planStoryboardTiming' in storyboardTools, false)
  const context = await invoke('readStoryboardContext', {}, f.rc)
  for (const key of ['timing_limits', 'timing_guidance', 'explicit_target_seconds']) assert.equal(key in context, false)
  const result = await invoke('saveStoryboards', { replace_existing: true, storyboards: [
    { shot_number: 1, description: '阿明：' + '完整原文台词。'.repeat(30), video_prompt: '阿明站在院子里，镜头轻轻前推。', character_ids: [f.character.id] },
    { shot_number: 2, duration: 3.5, description: '阿明推门。' },
    { shot_number: 3, duration: 60, description: '阿明走过长廊。' },
  ] }, f.rc)
  assert.ok(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, f.old.id)).get()?.deletedAt)
  assert.ok(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, f.old.id)).get())
  assert.equal(result.count, 3)
  assert.equal(result.total_duration, 73.5)
  assert.deepEqual(rows(f.episodeId).map(row => row.duration), [10, 3.5, 60])
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id, f.episodeId)).get()!.duration, 2)
  const originalId = rows(f.episodeId)[1]!.id
  const repeated = await invoke('saveStoryboards', { storyboards: [{ shot_number: 2, duration: 7.25, description: '阿明继续推门。' }] }, f.rc)
  assert.equal(repeated.total_duration, 77.25)
  assert.equal(rows(f.episodeId).length, 3)
  assert.equal(rows(f.episodeId)[1]!.id, originalId)
})

test('editing duration or prompt works directly without replanning or a required video timeline', async () => {
  const f = fixture()
  const result = await invoke('updateStoryboard', { storyboard_id: f.old.id, duration: 2.5, description: '阿明：' + '保留完整原文。'.repeat(30), video_prompt: '阿明缓步走进院子，回头看向来路。' }, f.rc)
  assert.match(result.message, /updated/)
  assert.equal(rows(f.episodeId)[0]!.duration, 2.5)
  const saved = await (updateVideoPrompt.execute as any)({ storyboard_id: f.old.id, video_prompt: '雨中，阿明靠在屋门边，抬头看向远方。' }, { requestContext: f.rc })
  assert.equal(saved.saved, true)
  assert.equal(rows(f.episodeId)[0]!.duration, 2.5)
  assert.equal(rows(f.episodeId)[0]!.videoUrl, '/static/old.mp4')
})

test('an invalid asset link is checked before replacement and preserves the existing video and bindings', async () => {
  const f = fixture()
  const result = await invoke('saveStoryboards', { replace_existing: true, storyboards: [{ shot_number: 1, character_ids: [999999] }] }, f.rc)
  assert.match(result.error, /不属于当前项目/)
  assert.equal(rows(f.episodeId)[0]!.id, f.old.id)
  assert.equal(rows(f.episodeId)[0]!.videoUrl, '/static/old.mp4')
  assert.equal(db.select().from(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, f.old.id)).all().length, 1)
})

test('replacement rolls back when a database write fails after validation', async () => {
  const f = fixture()
  db.$client.exec("CREATE TRIGGER storyboard_write_failure BEFORE INSERT ON storyboards WHEN NEW.title = '注入故障' BEGIN SELECT RAISE(ABORT, 'controlled failure'); END")
  try {
    const result = await invoke('saveStoryboards', { replace_existing: true, storyboards: [{ shot_number: 1, title: '注入故障' }] }, f.rc)
    assert.match(result.error, /原数据已保留/)
    assert.equal(rows(f.episodeId)[0]!.id, f.old.id)
    assert.equal(rows(f.episodeId)[0]!.videoUrl, '/static/old.mp4')
  } finally { db.$client.exec('DROP TRIGGER storyboard_write_failure') }
})
