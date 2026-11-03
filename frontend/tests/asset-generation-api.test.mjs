import { test } from 'node:test'
import assert from 'node:assert/strict'
import { characterAPI, sceneAPI, propAPI, taskAPI } from '../app/composables/useApi.ts'

test('asset generation forwards selected model, explicit editing instructions and ordered references', async () => {
  const requests = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, json: async () => ({ data: { image_generation_id: 10 } }) }
  }
  try {
    for (const api of [characterAPI, sceneAPI, propAPI]) {
      await api.generateImage(9, 2, 'wf-qwen-image', 7, undefined, undefined, { generation_mode: 'reference', reference_images: ['static/main.png', 'static/side.png'], edit_prompt: 'Change the coat' })
    }
    assert.deepEqual(requests.map(r => r.url), ['/api/v1/characters/9/generate-image', '/api/v1/scenes/9/generate-image', '/api/v1/props/9/generate-image'])
    for (const request of requests) assert.deepEqual(request.body, { episode_id: 2, model: 'wf-qwen-image', config_id: 7, generation_mode: 'reference', reference_images: ['static/main.png', 'static/side.png'], edit_prompt: 'Change the coat' })
    await characterAPI.generateImage(9, 2, 'wf-image', 7)
    assert.equal('reference_images' in requests.at(-1).body, false)
    assert.equal('edit_prompt' in requests.at(-1).body, false)
    await taskAPI.list({ type: 'image', drama_id: 1, scene_id: 9 })
    assert.equal(requests.at(-1).url, '/api/v1/tasks?type=image&drama_id=1&scene_id=9')
  } finally { globalThis.fetch = originalFetch }
})
