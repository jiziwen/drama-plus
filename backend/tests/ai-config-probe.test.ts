import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { joinProviderUrl } from '../src/services/adapters/url'

const source = readFileSync(new URL('../src/routes/aiConfigs.ts', import.meta.url), 'utf8')
const helpers = source.slice(source.indexOf('function bearerHeaders('), source.indexOf('// GET /ai-configs?'))
const route = source.slice(source.indexOf("app.post('/test',"), source.indexOf('// GET /ai-configs/:id'))

async function probe(status: number, response = '') {
  let handler: any
  let request: any
  const context = {
    URL, joinProviderUrl,
    app: { post: (_path: string, fn: any) => { handler = fn } },
    isOfficialProvider: () => true,
    redactUrl: (url: string) => url,
    logTaskProgress: () => {}, logTaskSuccess: () => {}, logTaskError: () => {},
    success: (_c: any, payload: any) => payload,
    fetch: async (url: string, options: any) => {
      request = { url, ...options }
      return { ok: status >= 200 && status < 300, status, statusText: String(status), text: async () => response }
    },
  }
  runInNewContext(ts.transpileModule(helpers + route, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  const result = await handler({ req: { json: async () => ({ service_type: 'video', provider: 'volcengine', base_url: 'https://ark.cn-beijing.volces.com/api/plan/v3', model: ['doubao-seedance-2.0-mini'], api_key: 'test-key' }) } })
  return { result, request }
}

test('video probe validates auth with a read-only request and hides historical media', async () => {
  const { result, request } = await probe(200, '{"items":[{"video_url":"private-history"}]}')
  assert.equal(request.method, 'GET')
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks?page_size=1')
  assert.equal(request.headers.Authorization, 'Bearer test-key')
  assert.equal(request.body, undefined)
  assert.equal(result.ok, true)
  assert.equal(result.response_preview, '')
  assert.match(result.message, /未生成视频/)
  assert.match(result.message, /模型生成权限尚未验证/)
})

for (const [status, message] of [[400, /请求被拒绝/], [401, /认证失败/], [403, /访问被拒绝/], [404, /测试未通过/], [429, /测试未通过/]] as const) {
  test(`HTTP ${status} is not a successful configuration test`, async () => {
    const { result } = await probe(status, '{"error":{"message":"upstream error"}}')
    assert.equal(result.ok, false)
    assert.match(result.message, message)
    assert.match(result.response_preview, /upstream error/)
  })
}
