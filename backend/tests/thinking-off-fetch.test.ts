import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/agents/index.ts', import.meta.url), 'utf8')
const helpers = source.slice(source.indexOf('const thinkingOffEnabled'), source.indexOf('function createTemperatureFetch'))

function adapter(baseURL: string, env: Record<string, string> = {}) {
  const requests: any[] = []
  const context: any = {
    URL, process: { env },
    fetch: async (_input: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)))
      return Response.json({ ok: true })
    },
  }
  runInNewContext(ts.transpileModule(helpers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { fetch: context.createThinkingOffFetch('openai', baseURL) as typeof fetch | undefined, requests }
}

for (const baseURL of ['https://www.aicost.me/v1', 'https://aicost.me/v1']) {
  test(`AICost accepts the injected thinking-off value at ${baseURL}`, async () => {
    const client = adapter(baseURL)
    await client.fetch!(`${baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'OK' }] }),
    })
    assert.equal(client.requests[0].reasoning_effort, 'off')
    assert.deepEqual(client.requests[0].thinking, { type: 'disabled' })
    assert.equal(client.requests[0].enable_thinking, false)
    assert.equal(client.requests[0].model, 'deepseek-v4.1-flash')
  })
}

for (const baseURL of ['https://example.com/v1', 'https://www.aicost.me.example.com/v1']) {
  test(`other hosts keep the existing reasoning value at ${baseURL}`, async () => {
    const client = adapter(baseURL)
    await client.fetch!(`${baseURL}/chat/completions`, { body: JSON.stringify({ messages: [] }) })
    assert.equal(client.requests[0].reasoning_effort, 'none')
  })
}

test('an explicit thinking-off patch takes precedence over the host default', async () => {
  const client = adapter('https://www.aicost.me/v1', { AI_THINKING_OFF_PATCH: '{"reasoning_effort":"low"}' })
  await client.fetch!('https://www.aicost.me/v1/chat/completions', { body: JSON.stringify({ messages: [] }) })
  assert.equal(client.requests[0].reasoning_effort, 'low')
  assert.equal(client.requests[0].thinking, undefined)
})

test('official hosts and disabled injection continue to bypass the patch', () => {
  assert.equal(adapter('https://api.openai.com/v1').fetch, undefined)
  assert.equal(adapter('https://www.aicost.me/v1', { AI_DISABLE_THINKING: 'false' }).fetch, undefined)
})
