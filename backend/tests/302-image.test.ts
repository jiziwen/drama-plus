import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getImageAdapter } from '../src/services/adapters/registry.js'

const config = { provider: '302ai', baseUrl: 'https://api.302ai.com/v1', apiKey: 'key', model: 'gpt-image-2' }
const image = 'data:image/png;base64,aGVsbG8='

test('302 GPT Image uses documented generation and multipart editing endpoints', () => {
  const adapter = getImageAdapter(config)
  const generation = adapter.buildGenerateRequest(config, { id: 1, prompt: 'test' })
  assert.equal(generation.url, 'https://api.302ai.com/v1/images/generations')
  assert.equal(generation.headers.Authorization, 'Bearer key')
  assert.equal(generation.body.model, 'gpt-image-2')
  assert.equal(adapter.parseGenerateResponse({ data: [{ url: 'https://file.302.ai/image.png' }] }).imageUrl, 'https://file.302.ai/image.png')

  const edit = adapter.buildGenerateRequest(config, { id: 2, prompt: 'edit', referenceImages: JSON.stringify([image]) })
  assert.equal(edit.url, 'https://api.302ai.com/v1/images/edits')
  assert.ok(edit.body instanceof FormData)
  assert.ok(edit.body.get('image') instanceof Blob)
  assert.equal(edit.body.get('image[]'), null)
  assert.throws(() => adapter.buildGenerateRequest(config, { id: 3, referenceImages: JSON.stringify([image, image]) }), /一张参考图/)
  assert.throws(() => adapter.buildGenerateRequest({ ...config, model: 'other-image' }, { id: 4 }), /GPT Image/)
})
