import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAI } from '@ai-sdk/openai'
process.env.SQLITE_PATH = ':memory:'
const { createDramaTextRunner } = await import('../src/services/downmarket-drama-agent.js')

for (const limit of [128_000, undefined]) {
  test(`下沉剧使用模型能力上限（${limit ?? '未知'}）`, async () => {
    let sent: Record<string, unknown> = {}
    const model = createOpenAI({
      apiKey: 'test', baseURL: 'http://fixture.invalid',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body))
        return Response.json({
          id: 'fixture', object: 'chat.completion', created: 1, model: 'test',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    }).chat('test')
    const runner = await createDramaTextRunner(undefined, async () => ({ model, maxOutputTokens: limit, aicostHaiku55: false }))
    assert.equal(await runner({ instructions: '测试', message: '生成', signal: new AbortController().signal }), '{"ok":true}')
    if (limit) assert.equal(sent.max_tokens, limit)
    else assert.ok(!('max_tokens' in sent) && !('max_completion_tokens' in sent))
  })
}
