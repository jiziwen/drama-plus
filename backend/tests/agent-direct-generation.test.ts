import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import ts from 'typescript'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-direct-storyboard-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.js')
const { scriptTools } = await import('../src/agents/tools/script-tools.js')
const { success, badRequest, now } = await import('../src/utils/response.js')
const source = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .*$/gm, '').replace('export default app', 'globalThis.route = app'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export \{\};?$/gm, '')
const timestamp = new Date().toISOString()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'direct test', scriptContent: '旁白：人物走进屋内，抬头看向窗外。', createdAt: timestamp, updatedAt: timestamp }).run()

function route(generate: (context: any, messages: any[]) => Promise<any>) {
  const context: any = {
    Hono, performance, console: { error() {} }, validAgentTypes: ['storyboard_breaker', 'script_rewriter'],
    and, eq, isNull, db, schema, buildAgentRequestContext, success, badRequest, now,
    mastra: { getAgent: () => ({ generate: async (messages: any[], options: any) => generate(options.requestContext, messages) }) },
    logTaskStart() {}, logTaskPayload() {}, logTaskError() {}, logTaskProgress() {}, logTaskSuccess() {},
  }
  runInNewContext(compiled, context)
  return context.route
}

test('the actual route reads and saves directly without any timing plan, word count or timeline gate', async () => {
  let generations = 0
  const app = route(async requestContext => {
    generations++
    const context = { requestContext }
    const read = await (storyboardTools.readStoryboardContext.execute as any)({}, context)
    assert.equal(read.script.includes('走进屋内'), true)
    assert.equal('timing_guidance' in read, false)
    const saved = await (storyboardTools.saveStoryboards.execute as any)({ replace_existing: true, storyboards: [
      { shot_number: 1, duration: 30, description: '旁白：' + '人物走进屋内，抬头看向窗外。'.repeat(20), video_prompt: '人物走进屋内，镜头跟随人物，自然光从窗外照入。' },
      { shot_number: 2, duration: 110, description: '人物转身离开，结束本场戏。' },
    ] }, context)
    assert.equal(saved.total_duration, 140, JSON.stringify(saved))
    return { text: 'saved', toolCalls: [], toolResults: [] }
  })
  const response = await app.request('/storyboard_breaker/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '直接拆分保存', drama_id: 1, episode_id: 1, target_duration_seconds: 1 }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.equal(result.data.type, 'done')
  assert.equal(generations, 1)
})

test('real upstream failures still return an error without automatic extra generation requests', async () => {
  let generations = 0
  const app = route(async () => {
    generations++
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })
  })
  const response = await app.request('/storyboard_breaker/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'split', drama_id: 1, episode_id: 1 }),
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).message, /文字接口请求超时/)
  assert.equal(generations, 1)
})

test('custom revision reads the current editor draft and commits only the complete submitted screenplay', async () => {
  const saved = '当前保存的剧本'
  const draft = '包含未保存编辑的剧本'
  const output = '按要求修改后的完整剧本'
  db.insert(schema.episodes).values({ id: 2, dramaId: 1, episodeNumber: 2, title: 'revision', content: '原文', scriptContent: saved, createdAt: timestamp, updatedAt: timestamp }).run()
  const app = route(async (requestContext, messages) => {
    assert.match(messages[0].content, /缩短对白/)
    const context = { requestContext }
    const read = await (scriptTools.readEpisodeScript.execute as any)({}, context)
    const rewrite = await (scriptTools.rewriteToScreenplay.execute as any)({}, context)
    assert.equal(read.content, draft)
    assert.equal(rewrite.source_content, draft)
    await (scriptTools.saveScript.execute as any)({ content: output }, context)
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, 2)).get()!
    assert.equal(episode.scriptContent, saved)
    return { finishReason: 'stop' }
  })
  const response = await app.request('/script_rewriter/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drama_id: 1, episode_id: 2, rewrite_instructions: '缩短对白', script_content: draft }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, JSON.stringify(result))
  assert.equal(result.data.script_content, output)
  const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, 2)).get()!
  assert.equal(episode.scriptContent, output)
  assert.equal(episode.content, '原文')
})

test('custom revision preserves the saved screenplay when the model fails, skips saving or overlaps a newer edit', async () => {
  const saved = '已保存剧本'
  db.insert(schema.episodes).values({ id: 3, dramaId: 1, episodeNumber: 3, title: 'revision error', content: '原文', scriptContent: saved, createdAt: timestamp, updatedAt: timestamp }).run()
  const episodeWhere = eq(schema.episodes.id, 3)
  const request = {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drama_id: 1, episode_id: 3, rewrite_instructions: '缩短对白' }),
  }
  const failed = route(async requestContext => {
    const context = { requestContext }
    const read = await (scriptTools.readEpisodeScript.execute as any)({}, context)
    assert.equal(read.content, saved)
    await (scriptTools.saveScript.execute as any)({ content: '暂存结果' }, context)
    throw new Error('API failure')
  })
  assert.equal((await failed.request('/script_rewriter/chat', request)).status, 400)
  assert.equal(db.select().from(schema.episodes).where(episodeWhere).get()!.scriptContent, saved)
  const unsaved = route(async () => ({ text: 'Agent text without tool submission', finishReason: 'stop' }))
  assert.equal((await unsaved.request('/script_rewriter/chat', request)).status, 400)
  assert.equal(db.select().from(schema.episodes).where(episodeWhere).get()!.scriptContent, saved)
  const overlapping = route(async requestContext => {
    await (scriptTools.saveScript.execute as any)({ content: '暂存结果' }, { requestContext })
    db.update(schema.episodes).set({ scriptContent: '改写期间的编辑' }).where(episodeWhere).run()
    return { finishReason: 'stop' }
  })
  const conflict = await overlapping.request('/script_rewriter/chat', request)
  assert.equal(conflict.status, 400)
  assert.match((await conflict.json()).message, /剧本已更新/)
  assert.equal(db.select().from(schema.episodes).where(episodeWhere).get()!.scriptContent, '改写期间的编辑')
})

test('ordinary screenplay rewrite still reads the raw source and saves through its existing tool', async () => {
  db.insert(schema.episodes).values({ id: 4, dramaId: 1, episodeNumber: 4, title: 'original rewrite', content: '原始素材', scriptContent: '先前的剧本', createdAt: timestamp, updatedAt: timestamp }).run()
  const app = route(async (requestContext, messages) => {
    assert.equal(messages[0].content, '请格式化原文')
    const context = { requestContext }
    const read = await (scriptTools.readEpisodeScript.execute as any)({}, context)
    assert.equal(read.content, '原始素材')
    await (scriptTools.saveScript.execute as any)({ content: '格式化后的原文' }, context)
    return { finishReason: 'stop' }
  })
  const response = await app.request('/script_rewriter/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '请格式化原文', drama_id: 1, episode_id: 4 }),
  })
  assert.equal(response.status, 200)
  assert.equal(db.select().from(schema.episodes).where(eq(schema.episodes.id, 4)).get()!.scriptContent, '格式化后的原文')
})

after(async () => {
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
