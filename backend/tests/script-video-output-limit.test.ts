import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveScriptVideoOutputLimit, resolveTextModelLimits } from '../src/services/script-video-output-limit.js'

const base = { provider: 'openai', baseURL: 'https://gateway.example/v1', model: 'fictional', apiKey: 'test-one' }

test('resolves exact model output metadata once per account even with concurrent calls', async () => {
  let calls = 0
  const fetchDetail: typeof fetch = async (url, init) => {
    calls++
    assert.equal(String(url), 'https://gateway.example/v1/models/fictional')
    assert.equal(init?.method, 'GET')
    assert.equal(init?.redirect, 'error')
    assert.ok(init?.signal instanceof AbortSignal)
    const key = new Headers(init?.headers).get('Authorization')
    return Response.json({ id: 'fictional', max_output_tokens: key === 'Bearer test-one' ? 97000 : 84000, context_length: 1000000 })
  }
  assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => resolveScriptVideoOutputLimit(base, fetchDetail))), [97000, 97000, 97000, 97000])
  assert.equal(await resolveScriptVideoOutputLimit({ ...base, apiKey: 'test-two' }, fetchDetail), 84000)
  assert.equal(calls, 2)
})

test('reads an exact catalog entry if model details are unsupported, constrained by provider output maximum', async () => {
  const paths: string[] = []
  const limit = await resolveScriptVideoOutputLimit({ ...base, model: 'vendor/story' }, async url => {
    paths.push(new URL(String(url)).pathname)
    if (paths.length === 1) return new Response(null, { status: 404 })
    return Response.json({ data: [
      { id: 'vendor/different', max_output_tokens: 1000000 },
      { id: 'vendor/story', context_window: 128000, max_output_tokens: 64000, top_provider: { max_completion_tokens: 48000 } },
    ] })
  })
  assert.deepEqual(paths, ['/v1/models/vendor%2Fstory', '/v1/models'])
  assert.equal(limit, 48000)
})

test('an output ceiling in the catalog wins when the exact model detail contains only its ID', async () => {
  const paths: string[] = []
  const signals: (AbortSignal | null | undefined)[] = []
  const limit = await resolveScriptVideoOutputLimit({ ...base, model: 'detail-missing-limit' }, async (url, init) => {
    const path = new URL(String(url)).pathname
    paths.push(path)
    signals.push(init?.signal)
    const detail = { id: 'detail-missing-limit', context_window: 524288 }
    return Response.json(path.endsWith('/models') ? { data: [{ ...detail, max_output_tokens: 90000 }] } : detail)
  })
  assert.deepEqual(paths, ['/v1/models/detail-missing-limit', '/v1/models'])
  assert.ok(signals[0] instanceof AbortSignal)
  assert.equal(signals[1], signals[0], 'both responses share the same deadline')
  assert.equal(limit, 90000)
})

test('uses Gemini model resource and native outputTokenLimit field', async () => {
  const limit = await resolveScriptVideoOutputLimit({ ...base, baseURL: 'https://gemini.example/v1beta', provider: 'gemini', model: 'models/sample' }, async (url, init) => {
    assert.equal(String(url), 'https://gemini.example/v1beta/models/sample')
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), base.apiKey)
    assert.equal(new Headers(init?.headers).has('Authorization'), false)
    return Response.json({ name: 'models/sample', inputTokenLimit: 500000, outputTokenLimit: 13579 })
  })
  assert.equal(limit, 13579)
})

test('unavailable metadata uses a published exact fallback and leaves other models uncapped', async () => {
  let calls = 0
  const denied: typeof fetch = async () => { calls++; return new Response(null, { status: 403 }) }
  for (const model of ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5']) {
    assert.equal(await resolveScriptVideoOutputLimit({ ...base, model }, denied), 128000)
  }
  for (const model of ['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4-pro']) {
    assert.equal(await resolveScriptVideoOutputLimit({ ...base, model }, denied), 393216)
  }
  for (const model of ['claude-haiku-5-5-custom', 'custom-v1']) {
    for (let i = 0; i < 2; i++)
      assert.equal(await resolveScriptVideoOutputLimit({ ...base, model }, denied), undefined)
  }
  assert.equal(calls, 7)

  const known = { ...base, apiKey: 'test-low-limit', model: 'claude-haiku-5-5' }
  assert.equal(await resolveScriptVideoOutputLimit(known, async () => Response.json({ id: known.model, max_output_tokens: 65536 })), 65536)
})

test('ignores mismatched IDs, malformed metadata and context-only limits', async () => {
  const responses = [
    { id: 'different', max_output_tokens: 98000 },
    { id: 'subject-1', context_length: 1000000, max_input_tokens: 98000, outputTokenLimit: -1 },
    { data: [{ max_output_tokens: 1000000 }] },
    { max_output_tokens: 'large' },
  ]
  for (const [index, response] of responses.entries()) {
    const result = await resolveScriptVideoOutputLimit({ ...base, model: 'subject-' + index }, async () => Response.json(response))
    assert.equal(result, undefined)
  }
})

test('uses OpenRouter catalog metadata without sending credentials to a different provider', async () => {
  const result = await resolveScriptVideoOutputLimit({ ...base, baseURL: 'https://openrouter.ai/api/v1', model: 'vendor/prompt' }, async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/models')
    assert.equal(init?.redirect, 'error')
    return Response.json({ data: [
      { id: 'vendor/prompt', top_provider: { max_completion_tokens: 131072 } },
    ] })
  })
  assert.equal(result, 131072)
})

test('uses gateway input and context limits separately from the public model fallback', async () => {
  const config = { ...base, model: 'gpt-6.2-sol', apiKey: 'metadata-fixture' }
  const limits = await resolveTextModelLimits(config, async url => {
    if (String(url).endsWith('/gpt-6.2-sol')) return Response.json({
      id: config.model, max_input_tokens: 475000, context_window: 500000,
    })
    return Response.json({ data: [{ id: config.model, max_output_tokens: 20000 }] })
  })
  assert.deepEqual(limits, { maxInputTokens: 475000, contextWindow: 500000, maxOutputTokens: 20000 })
  const fallback = await resolveTextModelLimits({ ...config, apiKey: 'no-metadata-fixture' },
    async () => new Response(null, { status: 403 }))
  assert.equal(fallback.maxInputTokens, 922000)
})
