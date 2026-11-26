import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAI } from '@ai-sdk/openai'
import { adaptAicostTextFetch, adaptOfficialOpenAIFetch, selectAgentOpenAIModel } from '../src/agents/openai-model.js'

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
  assert.equal(selectAgentOpenAIModel(provider, 'model', 'https://api.302.ai/v1').provider, 'openai.chat')
  assert.equal(selectAgentOpenAIModel(provider, 'model', 'https://api.302ai.com/v1').provider, 'openai.chat')
  assert.equal(selectAgentOpenAIModel(provider, 'model', 'https://api.openai.com.example.com/v1').provider, 'openai.chat')
})

test('302 chat sends the selected model and bearer key to the chat completions endpoint', async () => {
  let request: { url: string; headers: Headers; body: any } | undefined
  const provider = createOpenAI({
    apiKey: 'test-key', baseURL: 'https://api.302ai.com/v1',
    fetch: async (url, init) => {
      request = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
      return Response.json({ id: 'test', object: 'chat.completion', created: 1, model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    },
  })
  const model = selectAgentOpenAIModel(provider, 'gpt-4o', 'https://api.302ai.com/v1')
  await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
  assert.equal(request?.url, 'https://api.302ai.com/v1/chat/completions')
  assert.equal(request?.headers.get('authorization'), 'Bearer test-key')
  assert.equal(request?.body.model, 'gpt-4o')
  assert.equal(request?.body.messages[0].content, 'hello')
})

test('only Haiku 5.5 on AICost uses the provider sampling defaults', async () => {
  for (const [host, model, stripsSampling] of [
    ['aicost.me', 'claude-haiku-5-5', true],
    ['www.aicost.me', 'anthropic/claude-haiku-5.5', true],
    ['www.aicost.me', 'anthropic.claude-haiku-5-5', true],
    ['www.aicost.me', 'claude-haiku-5-5-custom', false],
    ['www.aicost.me', 'deepseek-v4.1-flash', false],
    ['api.302ai.com', 'claude-haiku-5-5', false],
    ['www.aicost.me.example.com', 'claude-haiku-5-5', false],
  ] as const) {
    const baseURL = 'https://' + host + '/v1'
    const payload = {
      model,
      stream: false,
      max_tokens: 128_000,
      messages: [{ role: 'user', content: '读取剧本' }],
      tool_choice: { type: 'function', function: { name: 'submit_draft' } },
    }
    const sampling = { temperature: 0, top_p: 0.6, top_k: 32 }
    const fetch = adaptAicostTextFetch(async (url, init) => {
      assert.equal(String(url), baseURL + '/chat/completions')
      assert.deepEqual(Object.fromEntries(new Headers(init?.headers)), { 'content-type': 'application/json' })
      assert.deepEqual(JSON.parse(String(init?.body)), stripsSampling ? payload : { ...payload, ...sampling })
      return Response.json({ ok: true })
    }, baseURL)
    const result = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, ...sampling }),
    })
    assert.deepEqual(await result.json(), { ok: true })
  }
})
