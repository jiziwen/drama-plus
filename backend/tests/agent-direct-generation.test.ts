import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { Hono } from 'hono'
import ts from 'typescript'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-direct-storyboard-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
const { storyboardTools } = await import('../src/agents/tools/storyboard-tools.js')
const { success, badRequest } = await import('../src/utils/response.js')
const source = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source.replace(/^import .*$/gm, '').replace('export default app', 'globalThis.route = app'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export \{\};?$/gm, '')
const timestamp = new Date().toISOString()
db.insert(schema.episodes).values({ id: 1, dramaId: 1, episodeNumber: 1, title: 'direct test', scriptContent: '旁白：人物走进屋内，抬头看向窗外。', createdAt: timestamp, updatedAt: timestamp }).run()

function route(generate: (context: any) => Promise<any>) {
  const context: any = {
    Hono, performance, console: { error() {} }, validAgentTypes: ['storyboard_breaker'],
    buildAgentRequestContext, success, badRequest,
    mastra: { getAgent: () => ({ generate: async (_messages: any, options: any) => generate(options.requestContext) }) },
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

after(async () => {
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})
