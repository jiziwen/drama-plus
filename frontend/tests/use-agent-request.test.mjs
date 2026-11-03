import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ref } from 'vue'
import ts from 'typescript'

// Run the real composable and HTTP wrapper together. Only the network and UI are mocked.
const compile = path => ts.transpileModule(
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/^import .*$/gm, ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
).outputText.replace(/^export /gm, '')
const script = `${compile('../app/composables/useApi.ts')}\n${compile('../app/composables/useAgent.ts')}\nthis.agent = useAgent()`

function setup(response = { ok: true, status: 200, body: { data: { text: 'done' } } }) {
  const requests = [], successes = [], errors = [], warnings = []
  let releaseResponse
  const responseReady = new Promise(resolve => { releaseResponse = resolve })
  const context = {
    ref, performance: { now: () => 0 }, console: { log() {} },
    i18n: { global: { t: key => key } },
    toast: { success: value => successes.push(value), warning: value => warnings.push(value) },
    toastError: error => errors.push(error),
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: JSON.parse(options.body) })
      await responseReady
      return { ok: response.ok, status: response.status, json: async () => response.body }
    },
  }
  runInNewContext(script, context)
  return { agent: context.agent, requests, successes, errors, warnings, releaseResponse }
}

test('useAgent sends the original direct generation request and calls onDone only after success', async () => {
  const { agent, requests, successes, errors, releaseResponse } = setup()
  let completed = 0
  const pending = agent.run('storyboard_breaker', 'generate directly', 4, 5, () => completed++, 'writer', 8)
  assert.equal(agent.running.value, true)
  assert.equal(agent.runningType.value, 'storyboard_breaker')
  assert.equal(completed, 0)
  assert.deepEqual(requests, [{
    url: '/api/v1/agent/storyboard_breaker/chat', method: 'POST',
    body: { message: 'generate directly', drama_id: 4, episode_id: 5, model: 'writer', config_id: 8 },
  }])
  releaseResponse()
  await pending
  assert.equal(completed, 1)
  assert.equal(successes.length, 1)
  assert.deepEqual(errors, [])
  assert.equal(agent.running.value, false)
  assert.equal(agent.runningType.value, null)
})

test('ordinary prompt requests keep their existing model request shape', async () => {
  const { agent, requests, releaseResponse } = setup()
  const pending = agent.run('prompt_generator', 'prompt only', 4, 5, undefined, 'writer', 8)
  releaseResponse()
  await pending
  assert.deepEqual(requests, [{
    url: '/api/v1/agent/prompt_generator/chat', method: 'POST',
    body: { message: 'prompt only', drama_id: 4, episode_id: 5, model: 'writer', config_id: 8 },
  }])
})

for (const response of [
  { label: 'HTTP rejection', ok: false, status: 502, body: { message: 'upstream unavailable' } },
  { label: 'business error envelope', ok: true, status: 200, body: { code: 400, message: 'generation failed' } },
]) {
  test(`${response.label} reports an error, resets running state and never calls onDone`, async () => {
    const { agent, successes, errors, releaseResponse } = setup(response)
    let completed = 0
    const pending = agent.run('storyboard_breaker', 'generate directly', 4, 5, () => completed++, 'writer', 8)
    releaseResponse()
    await pending
    assert.equal(completed, 0)
    assert.deepEqual(successes, [])
    assert.equal(errors.length, 1)
    assert.equal(errors[0].message, response.body.message)
    assert.equal(agent.running.value, false)
    assert.equal(agent.runningType.value, null)
  })
}
