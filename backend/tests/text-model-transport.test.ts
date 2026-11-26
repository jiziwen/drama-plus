import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const providers = [
  { provider: '302ai', baseUrl: 'https://api.302ai.com', model: 'gpt-4o', endpoint: '/v1/chat/completions' },
  { provider: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-6.1-terra', endpoint: '/v1/responses' },
  { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash', endpoint: '/v1beta/models/gemini-2.5-flash:generateContent' },
  { provider: 'volcengine', baseUrl: 'https://ark.cn-beijing.volces.com', model: 'doubao-seed-1-6-250615', endpoint: '/api/v3/chat/completions' },
]
const reply = '测试回复'

function chatReply(model: string, stream: boolean) {
  const base = { id: 'chat_test', created: 1, model }
  if (!stream) return Response.json({
    ...base, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  })
  const chunk = { ...base, object: 'chat.completion.chunk' }
  const frames = [
    { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: '测试' }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: { content: '回复' }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('text provider transport keeps only interactive assistant replies streaming', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'text-transport-'))
  const oldPath = process.env.SQLITE_PATH
  const oldMysql = process.env.MYSQL_AUTO_IMPORT
  process.env.SQLITE_PATH = join(dir, 'fixture.sqlite3')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  let closeDatabase: (() => void) | undefined
  t.after(async () => {
    closeDatabase?.()
    if (oldPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = oldPath
    if (oldMysql === undefined) delete process.env.MYSQL_AUTO_IMPORT
    else process.env.MYSQL_AUTO_IMPORT = oldMysql
    await rm(dir, { recursive: true, force: true })
  })

  const sent: { endpoint: string; stream?: boolean; query: string }[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const fixture = providers.find(provider => provider.baseUrl === url.origin)
    assert.ok(fixture, 'no provider request may leave the mock')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method === 'GET') return Response.json({ id: fixture.model })
    const body = JSON.parse(String(init?.body))
    sent.push({ endpoint: url.pathname, stream: body.stream, query: url.search })
    assert.equal(url.pathname, fixture.endpoint)
    if (fixture.endpoint.endsWith('/chat/completions')) return chatReply(fixture.model, body.stream === true)
    if (fixture.provider === 'openai') return Response.json({
      id: 'resp_test', object: 'response', created_at: 1, model: fixture.model,
      output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: reply, annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    })
    return Response.json({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: reply }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    })
  })

  const { db, schema } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const [{ Agent }, { resolveScriptVideoTextModel }, { createAiChatRoutes }, { createChatRunner }] = await Promise.all([
    import('@mastra/core/agent'),
    import('../src/agents/index.js'),
    import('../src/routes/ai-chat.js'),
    import('../src/services/ai-chat-service.js'),
  ])
  const timestamp = new Date().toISOString()
  const configs = providers.map(({ provider, baseUrl, model, endpoint }) => {
    const row = db.insert(schema.aiServiceConfigs).values({
      serviceType: 'text', provider, baseUrl, model: JSON.stringify([model]),
      name: provider, isActive: true, apiKey: 'fixture', createdAt: timestamp, updatedAt: timestamp,
    }).returning().get()
    return { provider, model, configId: row.id, endpoint }
  })

  for (const { provider, model, configId, endpoint } of configs) {
    await t.test(provider + ' Agent.generate sends one JSON request', async () => {
      const resolved = await resolveScriptVideoTextModel(model, configId, false)
      const agent = new Agent({ id: 'generate-fixture', name: 'Generate fixture', model: resolved.model, instructions: '写一句回复。' })
      const before = sent.length
      const output = await agent.generate('测试', { maxSteps: 1 })
      assert.equal(output.text, reply)
      assert.equal(sent.length, before + 1)
      const request = sent[before]
      assert.equal(request.endpoint, endpoint)
      assert.equal(request.query, '')
      assert.equal(request.stream, provider === 'gemini' ? undefined : false)
    })
  }

  const { model, configId, endpoint } = configs[0]
  const selection = { model, configId }
  await t.test('chat still streams upstream deltas through its SSE endpoint', async () => {
    const app = createAiChatRoutes()
    const json = (body: unknown) => ({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const created = await app.request('/sessions', json({ model: selection }))
    assert.equal(created.status, 201)
    const { data: session } = await created.json()
    const before = sent.length
    const response = await app.request('/sessions/' + session.id + '/messages', json({ content: '测试' }))
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const events = await response.text()
    assert.match(events, /event: delta\s+data: \{"delta":"测试"\}/u)
    assert.match(events, /event: delta\s+data: \{"delta":"回复"\}/u)
    assert.match(events, /event: done/u)
    assert.deepEqual(sent.slice(before), [{ endpoint, stream: true, query: '' }])
  })

  await t.test('chat context summary uses a JSON request', async () => {
    const runner = await createChatRunner(selection)
    const before = sent.length
    const text = await runner.summarize({ instructions: '总结。', prompt: '测试', maxOutputTokens: 100, signal: new AbortController().signal })
    assert.equal(text, reply)
    assert.deepEqual(sent.slice(before), [{ endpoint, stream: false, query: '' }])
  })
})
