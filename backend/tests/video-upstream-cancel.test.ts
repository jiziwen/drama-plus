import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { cancelUpstreamVideo } from '../src/services/video-upstream-cancel.js'

test('DashScope requests cancellation only for the exact pending task and requires provider acknowledgement', async t => {
  const calls: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    calls.push(`${request.method} ${url.pathname}`)
    assert.equal(request.headers.authorization, 'Bearer test-key')
    assert.equal(url.searchParams.get('workspace'), 'test')
    const taskId = url.pathname.split('/')[4]
    response.setHeader('Content-Type', 'application/json')
    if (request.method === 'POST') {
      if (taskId === 'reject') {
        response.statusCode = 409
        response.end(JSON.stringify({ code: 'UnsupportedOperation' }))
      } else if (taskId === 'error-in-envelope') {
        response.end(JSON.stringify({ code: 'UnsupportedOperation', request_id: 'error' }))
      } else {
        response.end(JSON.stringify({ request_id: 'cancelled-request' }))
      }
      return
    }
    if (taskId === 'redirect') {
      response.writeHead(307, { Location: '/elsewhere' }).end()
      return
    }
    const statuses: Record<string, string> = { running: 'RUNNING', succeeded: 'SUCCEEDED', canceled: 'CANCELED' }
    const status = statuses[taskId] || 'PENDING'
    response.end(JSON.stringify({
      request_id: 'status-request', output: { task_id: taskId === 'mismatch' ? 'other-task' : taskId, task_status: status },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const config = {
    provider: 'aliyun',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1?workspace=test`,
    apiKey: 'test-key',
    model: 'wan3.0-video',
  }
  for (const id of ['running', 'succeeded', 'mismatch', 'redirect', '../other-task', 'reject', 'error-in-envelope']) {
    assert.equal(await cancelUpstreamVideo(config, id), false, id)
  }
  assert.equal(await cancelUpstreamVideo(config, 'canceled'), true)
  assert.equal(await cancelUpstreamVideo(config, 'pending'), true)
  assert.equal(await cancelUpstreamVideo({ ...config, provider: 'volcengine' }, 'ark-task'), false)
  assert.equal(await cancelUpstreamVideo({ ...config, provider: 'jimeng' }, 'jimeng-task'), false)
  assert.equal(await cancelUpstreamVideo({ ...config, provider: 'libtv' }, 'libtv-task'), false)
  assert.deepEqual(calls, [
    'GET /api/v1/tasks/running',
    'GET /api/v1/tasks/succeeded',
    'GET /api/v1/tasks/mismatch',
    'GET /api/v1/tasks/redirect',
    'GET /api/v1/tasks/reject', 'POST /api/v1/tasks/reject/cancel',
    'GET /api/v1/tasks/error-in-envelope', 'POST /api/v1/tasks/error-in-envelope/cancel',
    'GET /api/v1/tasks/canceled',
    'GET /api/v1/tasks/pending', 'POST /api/v1/tasks/pending/cancel',
  ])
})
