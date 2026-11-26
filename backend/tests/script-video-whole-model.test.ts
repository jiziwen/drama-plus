import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { runScriptVideoWholeModel } from '../src/services/script-video-whole-model.js'

const request = {
  instructions: '测试',
  message: '写本集',
  schema: z.object({ production: z.object({}), cards: z.array(z.object({})) }),
}
const timingPlan = { durations: [24, 29] }
const production = { title: '制作规格' }
const card = { title: '括号 } ]、引号" 与反斜线\\', shots: [{ action: '甲起身。' }] }

function completion(message: object, finish = 'tool_calls', usage?: object) {
  return {
    id: 'fixture-studio',
    object: 'chat.completion',
    model: 'test-model',
    created: 1,
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage,
  }
}
function toolCall(args: string, name = 'submit_draft') {
  return { tool_calls: [{ id: 't1', type: 'function', function: { name, arguments: args } }] }
}

/** Exercises the actual OpenAI-compatible SDK without a network connection. */
function localProvider(maxOutputTokens?: number) {
  let requests = 0
  let sent: Record<string, unknown> = {}
  const started = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  const model = createOpenAI({
    apiKey: 'test', baseURL: 'http://fixture.invalid',
    fetch: async (_input, init) => {
      requests++
      sent = JSON.parse(String(init?.body))
      started.resolve()
      return reply.promise
    },
  }).chat('test-model')
  return {
    started: started.promise, reply: reply.resolve,
    resolveModel: async () => ({ model, maxOutputTokens }), requests: () => requests, sent: () => sent,
  }
}

test('a single nonstreaming request checkpoints the timing plan, production, and cards after the full response', async () => {
  const local = localProvider(128_000)
  const saved: unknown[] = []
  const response = runScriptVideoWholeModel({
    ...request,
    onTimingPlan: (value) => { saved.push(value) },
    onProduction: (value) => { saved.push(value) },
    onCard: (value, index) => {
      assert.equal(saved.length - 2, index)
      saved.push(value)
    },
  }, local.resolveModel)
  await local.started
  const draft = { cards: [card, { title: '第二段' }], production, timingPlan }
  const bytes = new TextEncoder().encode(JSON.stringify(completion(toolCall(JSON.stringify(draft)))))
  const body = new TransformStream<Uint8Array, Uint8Array>()
  const writer = body.writable.getWriter()
  local.reply(new Response(body.readable, { headers: { 'Content-Type': 'application/json' } }))
  await writer.write(bytes)
  assert.deepEqual(saved, [])
  await writer.close()
  assert.deepEqual(await response, draft)
  assert.deepEqual(saved, [timingPlan, production, ...draft.cards])
  assert.equal(local.requests(), 1)
  assert.notEqual(local.sent().stream, true)
  assert.equal((local.sent().tools as unknown[]).length, 2)
  assert.equal(local.sent().max_tokens, 128_000)
})

test('a broken JSON response reports the disconnect without invoking callbacks or replaying the request', async () => {
  const local = localProvider()
  const saved: unknown[] = []
  const response = runScriptVideoWholeModel({
    ...request,
    onCard: value => { saved.push(value) },
  }, local.resolveModel)
  const rejected = assert.rejects(response, (error: Error) => {
    assert.match(String(error.cause ?? error), /connection closed/)
    return true
  })
  await local.started
  const bytes = new TextEncoder().encode(JSON.stringify(completion(toolCall(JSON.stringify({ cards: [card] })))))
  const body = new TransformStream<Uint8Array, Uint8Array>()
  const writer = body.writable.getWriter()
  local.reply(new Response(body.readable, { headers: { 'Content-Type': 'application/json' } }))
  await writer.write(bytes.slice(0, -15))
  await writer.abort(new Error('connection closed'))
  await rejected
  assert.deepEqual(saved, [])
  assert.equal(local.requests(), 1)
  assert.notEqual(local.sent().stream, true)
})

test('output token exhaustion keeps completed cards, reports reasoning usage, and never starts another request', async () => {
  const local = localProvider(128_000)
  const saved: unknown[] = []
  const response = runScriptVideoWholeModel({
    ...request,
    onProduction: (value) => { saved.push(value) },
    onCard: (value) => { saved.push(value) },
  }, local.resolveModel)
  const rejected = assert.rejects(response, (error: any) => {
    assert.equal(error.code, 'OUTPUT_TRUNCATED')
    const message = error.message.replaceAll(',', '')
    assert.match(message, /32768/)
    assert.match(message, /32767/)
    return true
  })
  const partial = '{"production":' + JSON.stringify(production) + ',"cards":[' + JSON.stringify(card) + ',{"title":"未完'
  local.reply(Response.json(completion(toolCall(partial), 'length', {
    prompt_tokens: 75804, completion_tokens: 32768, total_tokens: 108572,
    completion_tokens_details: { reasoning_tokens: 32767 },
  })))
  await rejected
  assert.deepEqual(saved, [production, card])
  assert.equal(local.requests(), 1)
})

test('clarification from the single response is surfaced without a tool-return step', async () => {
  const local = localProvider()
  const response = runScriptVideoWholeModel(request, local.resolveModel)
  const rejected = assert.rejects(response, { code: 'USER_INPUT_REQUIRED', message: '选哪个造型？' })
  local.reply(Response.json(completion(toolCall('{"question":"选哪个造型？"}', 'request_clarification'))))
  await rejected
  assert.equal(local.requests(), 1)
})

test('repair and continuity review describe their own submit_draft fields to the provider', async () => {
  for (const [mode, schema, expected] of [
    ['repair', z.object({ patches: z.array(z.object({})) }), /\bpatches\b/u],
    ['continuity_review', z.object({
      passed: z.boolean(), continuityReview: z.string(), issues: z.array(z.object({})),
    }), /\bpassed\b.*\bcontinuityReview\b.*\bissues\b/u],
  ] as const) {
    const local = localProvider()
    const response = runScriptVideoWholeModel({ ...request, mode, schema }, local.resolveModel)
    await local.started
    local.reply(Response.json(completion(toolCall('{}'))))
    await response
    const [tool] = local.sent().tools as Array<{ function: { name: string; description: string } }>
    assert.equal(tool.function.name, 'submit_draft')
    assert.match(tool.function.description, expected)
    assert.doesNotMatch(tool.function.description, /\b(?:timingPlan|cards)\b/u)
  }
})

test('plain JSON output from compatible endpoints also preserves the actual card index', async () => {
  const local = localProvider()
  const saved: number[] = []
  const response = runScriptVideoWholeModel({
    ...request, onCard: (_card, index) => { saved.push(index) },
  }, local.resolveModel)
  local.reply(Response.json(completion({ content: '{"cards":[null,' + JSON.stringify(card) + ']}' }, 'stop')))
  assert.deepEqual(await response, { cards: [null, card] })
  assert.deepEqual(saved, [1])
  assert.equal(local.requests(), 1)
  assert.ok(!('max_tokens' in local.sent()) && !('max_completion_tokens' in local.sent()))
})

test('a provider HTTP 429 is returned after exactly one HTTP request', async () => {
  let count = 0
  const model = createOpenAI({ apiKey: 'test', fetch: async () => {
    count++
    return Response.json({ error: { message: 'rate limited', type: 'rate_limit_error', code: 'rate_limit_error', param: null } }, { status: 429 })
  } }).chat('test-model')
  await assert.rejects(runScriptVideoWholeModel(request, async () => ({ model })), /rate limited/)
  assert.equal(count, 1)
})

test('user cancellation aborts the provider HTTP request and never writes draft checkpoints', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<AbortSignal>()
  let calls = 0
  const model = createOpenAI({ apiKey: 'test', fetch: async (_input, init) => {
    calls++
    const signal = init?.signal
    assert.ok(signal)
    started.resolve(signal)
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  } }).chat('test-model')
  const resolve = async () => ({ model })
  let checkpoints = 0
  const response = runScriptVideoWholeModel({ ...request, signal: controller.signal, onCard: () => { checkpoints++ } }, resolve)
  const rejected = assert.rejects(response, { name: 'AbortError' })
  const fetchSignal = await started.promise
  controller.abort()
  await rejected
  assert.equal(fetchSignal.aborted, true)
  assert.equal(calls, 1)
  assert.equal(checkpoints, 0)
  await assert.rejects(runScriptVideoWholeModel({ ...request, signal: controller.signal }, resolve), { name: 'AbortError' })
  assert.equal(calls, 1)
})
