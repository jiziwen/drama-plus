import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThreeZeroTwoVideoAdapter } from '../src/services/adapters/302ai-video.ts'

const adapter = new ThreeZeroTwoVideoAdapter()
const config = { provider: '302ai', baseUrl: 'https://api.302ai.com', apiKey: 'test-key', model: 'model-id' }

test('302 video sends documented fields and polls the returned task', async () => {
  const request = await adapter.buildGenerateRequest(config, {
    id: 1, prompt: 'scene', firstFrameUrl: 'https://example.com/start.png', lastFrameUrl: 'https://example.com/end.png', duration: 5, aspectRatio: '16:9', resolution: '720p',
  })
  assert.equal(request.url, 'https://api.302ai.com/302/v2/video/create')
  assert.deepEqual(request.body, { model: 'model-id', prompt: 'scene', image: 'https://example.com/start.png', end_image: 'https://example.com/end.png', duration: 5, aspect_ratio: '16:9', resolution: '720p' })
  assert.deepEqual(adapter.parseGenerateResponse({ task_id: 'abc', status: 'pending' }), { isAsync: true, taskId: 'abc' })
  assert.equal(adapter.buildPollRequest({ ...config, baseUrl: config.baseUrl + '/v1' }, 'abc').url, 'https://api.302ai.com/302/v2/video/fetch/abc')
  assert.deepEqual(adapter.parsePollResponse({ status: 'completed', video_url: 'https://example.com/out.mp4' }), { status: 'completed', videoUrl: 'https://example.com/out.mp4' })
  assert.deepEqual(adapter.parsePollResponse({ status: 'failed', error: 'bad model' }), { status: 'failed', error: 'bad model' })
})

test('302 video rejects inputs without documented mapping instead of discarding them', async () => {
  await assert.rejects(adapter.buildGenerateRequest(config, { id: 1, prompt: 'scene', referenceImageUrls: '["https://example.com/face.png", "https://example.com/other.png"]' }), /仅支持一张/)
  await assert.rejects(adapter.buildGenerateRequest(config, { id: 1, prompt: 'scene', referenceVideoUrls: '["static/videos/local.mp4"]' }), /公网 URL/)
  await assert.rejects(adapter.buildGenerateRequest(config, { id: 1, prompt: 'scene', lastFrameUrl: 'https://example.com/end.png' }), /尾帧/)
  const request = await adapter.buildGenerateRequest(config, { id: 1, prompt: 'scene', referenceVideoUrls: '["https://example.com/video.mp4"]' })
  assert.equal(request.body.video, 'https://example.com/video.mp4')
  const image = await adapter.buildGenerateRequest(config, { id: 1, prompt: 'scene', referenceImageUrls: '["https://example.com/face.png"]' })
  assert.equal(image.body.image, 'https://example.com/face.png')
})
