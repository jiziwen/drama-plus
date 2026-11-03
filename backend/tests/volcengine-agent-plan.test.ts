import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinProviderUrl } from '../src/services/adapters/url'
import { VolcEngineVideoAdapter } from '../src/services/adapters/volcengine-video'

const host = 'https://ark.cn-beijing.volces.com'
const tasks = '/contents/generations/tasks'
const adapter = new VolcEngineVideoAdapter()

for (const base of ['/api/plan', '/api/plan/', '/api/plan/v3', '/api/plan/v3/']) {
  test(`Agent Plan submission and polling use the same API root: ${base}`, () => {
    const config = { provider: 'volcengine', baseUrl: host + base, apiKey: 'test-key', model: 'doubao-seedance-2.0-mini' }
    for (const model of ['doubao-seedance-2.0', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0-mini']) {
      const request = adapter.buildGenerateRequest(config, { id: 1, model, prompt: '海边日出' })
      assert.equal(request.url, host + '/api/plan/v3' + tasks)
      assert.equal(request.body.model, model)
      assert.equal(request.method, 'POST')
      assert.equal(request.headers.Authorization, 'Bearer test-key')
    }
    const poll = adapter.buildPollRequest(config, 'task-123')
    assert.equal(poll.url, host + '/api/plan/v3' + tasks + '/task-123')
    assert.equal(poll.method, 'GET')
    // 配置探针、文本和图片调用共用同一 URL 拼接函数。
    for (const path of [tasks, '/chat/completions', '/images/generations']) {
      assert.equal(joinProviderUrl(config.baseUrl, '/api/v3', path), host + '/api/plan/v3' + path)
    }
  })
}

test('standard Ark roots and proxy prefixes retain their existing routes', () => {
  for (const [base, expected] of [
    [host, host + '/api/v3'],
    [host + '/api/v3/', host + '/api/v3'],
    ['https://proxy.example/volcengine', 'https://proxy.example/volcengine/api/v3'],
    ['https://proxy.example/volcengine/api/v3', 'https://proxy.example/volcengine/api/v3'],
  ]) {
    const request = adapter.buildGenerateRequest({ provider: 'volcengine', baseUrl: base, apiKey: 'test', model: 'doubao-seedance-2-0-mini-260615' }, { id: 1, prompt: '海边日出' })
    assert.equal(request.url, expected + tasks)
    assert.equal(joinProviderUrl(base, '/api/v3', ''), expected)
  }
  assert.equal(joinProviderUrl('https://proxy.example/api/plan', '/v1', '/models'), 'https://proxy.example/api/plan/v1/models')
})

test('unrelated video models remain unsupported', () => {
  assert.throws(() => adapter.buildGenerateRequest({ provider: 'volcengine', baseUrl: host + '/api/plan/v3', apiKey: 'test', model: 'unrelated-model' }, { id: 1, prompt: '海边日出' }), /仅支持 Seedance 2.0/)
})
