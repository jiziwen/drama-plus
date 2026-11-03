import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAI } from '@ai-sdk/openai'
import { adaptOfficialOpenAIFetch, selectAgentOpenAIModel } from '../src/agents/openai-model.js'

test('official agent serializes tool calls and results using Responses', async () => {
  const requests: { url: string; body: any }[] = []
  const provider = createOpenAI({
    apiKey: 'test-key', baseURL: 'https://api.openai.com/v1',
    fetch: adaptOfficialOpenAIFetch(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return Response.json({
        id: 'resp_test', object: 'response', created_at: 1, model: 'gpt-6.1-terra',
        output: requests.length === 1
          ? [{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'read_script', arguments: '{}' }]
          : [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    }),
  })
  const model = selectAgentOpenAIModel(provider, 'gpt-6.1-terra', 'https://api.openai.com/v1')
  const prompt: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Read script' }] }]
  const first = await model.doGenerate({ prompt, temperature: 0, tools: [{ type: 'function', name: 'read_script', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })
  const call = first.content.find(item => item.type === 'tool-call')
  assert.ok(call && call.type === 'tool-call')
  prompt.push({ role: 'assistant', content: [call] })
  prompt.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: 'script content' } }] })
  const second = await model.doGenerate({ prompt })
  assert.ok(requests.every(r => r.url === 'https://api.openai.com/v1/responses'))
  assert.equal(requests[0].body.tools[0].type, 'function')
  assert.equal('temperature' in requests[0].body, false)
  assert.ok(requests[1].body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'call_test'))
  assert.ok(second.content.some(item => item.type === 'text' && item.text === 'done'))
})

test('compatible endpoints keep Chat Completions', () => {
  const provider = createOpenAI({ apiKey: 'test-key' })
  assert.equal(selectAgentOpenAIModel(provider, 'model', 'https://example.com/v1').provider, 'openai.chat')
  assert.equal(selectAgentOpenAIModel(provider, 'model', 'https://api.openai.com.example.com/v1').provider, 'openai.chat')
})
