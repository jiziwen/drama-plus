import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import { buildAgentRequestContext } from '../src/agents/context.js'

// Execute the real batch service with in-memory collaborators; no app DB, model call or network is used.
const source = readFileSync(new URL('../src/services/video-prompts.ts', import.meta.url), 'utf8')
const script = ts.transpileModule(source.replace(/^import .*$/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^export /gm, '')

test('batch prompt generation keeps each shot duration, honors its model label and only requests variable-timeline prompt updates', async () => {
  const shots = [
    { id: 101, episodeId: 7, storyboardNumber: 1, duration: 4, videoPrompt: '', videoModel: 'wf-minimax-h3', videoConfigId: 9 },
    { id: 102, episodeId: 7, storyboardNumber: 2, duration: 7.5, videoPrompt: '', videoModel: null, videoConfigId: null },
  ]
  const configs = [{ id: 8, name: 'episode default', provider: 'cloud' }, { id: 9, name: 'local', provider: 'comfyui' }]
  const requests: any[] = []
  let rejectShot: number | undefined
  const schema = {
    storyboards: { table: 'storyboards', id: 'id', episodeId: 'episodeId', storyboardNumber: 'storyboardNumber' },
    episodes: { table: 'episodes', id: 'id' }, aiServiceConfigs: { table: 'configs', id: 'id' },
  }
  const rows: Record<string, any[]> = { storyboards: shots, episodes: [{ id: 7, videoConfigId: 8 }], configs }
  const context: any = {
    schema, eq: (field: string, value: any) => ({ field, value }),
    db: { select: () => ({ from: (table: any) => {
      let result = rows[table.table]
      const query = {
        where: (condition: any) => { result = result.filter(row => row[condition.field] === condition.value); return query },
        orderBy: () => query,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      }
      return query
    } }) },
    mastra: { getAgent: () => ({ generate: async (messages: any[], options: any) => {
      requests.push({ messages, options })
      const id = Number(messages[0].content.match(/\(ID:(\d+)\)/)[1])
      if (id === rejectShot) {
        throw new Error('upstream unavailable')
      }
      shots.find(shot => shot.id === id)!.videoPrompt = 'generated'
    } }) },
    buildAgentRequestContext,
    logTaskError() {}, logTaskProgress() {}, logTaskStart() {}, logTaskSuccess() {},
  }
  runInNewContext(script, context)
  const result = await context.startVideoPromptBatch(7, 5, { model: 'writer', configId: 3 })
  assert.equal(result.started, true)
  assert.equal(result.total, 2)
  for (let attempts = 0; context.getVideoPromptBatchStatus(7).status === 'running' && attempts < 50; attempts++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.getVideoPromptBatchStatus(7).status, 'done')
  assert.equal(context.getVideoPromptBatchStatus(7).completed, 2)
  assert.deepEqual(shots.map(shot => shot.duration), [4, 7.5])
  assert.equal(requests.length, 2)
  assert.match(requests[0].messages[0].content, /视频模型:wf-minimax-h3 · local \(comfyui\)/)
  assert.match(requests[1].messages[0].content, /视频模型:episode default \(cloud\)/)
  for (const request of requests) {
    assert.equal(request.options.requestContext.get('modelOverride'), 'writer')
    assert.equal(request.options.requestContext.get('textConfigId'), 3)
    const message = request.messages[0].content
    assert.match(message, /贴合已有 duration/)
    assert.match(message, /参数只传 storyboard_id 和 video_prompt 两个键/)
    assert.doesNotMatch(message, /plan_storyboard_timing|beat_id|budget_seconds/)
    assert.doesNotMatch(message, /按\s*3\s*秒|8\s*[-–]\s*15/)
  }
  rejectShot = 101
  await context.startVideoPromptBatch(7, 5, {}, [101, 102])
  for (let attempts = 0; context.getVideoPromptBatchStatus(7).status === 'running' && attempts < 50; attempts++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.getVideoPromptBatchStatus(7).failed, 1, 'an old non-empty prompt must not hide an upstream failure')
  assert.equal(context.getVideoPromptBatchStatus(7).completed, 1, 'one shot error must not carry over into the next shot')
  assert.notEqual(requests[2].options.requestContext, requests[3].options.requestContext)
})
