import assert from 'node:assert/strict'
import { test } from 'node:test'
import { videoCliFailure } from '../src/services/video-cli-errors.js'

test('即梦官方新版 diagnostics 保留具体错误原因并脱敏', () => {
  const message = videoCliFailure('jimeng', {
    code: 40018, diagnostics: [{ detail: '当前账号积分不足，还需 30 积分 token=private-diagnostic-token' }],
  }, '即梦请求失败')
  assert.match(message, /当前账号积分不足，还需 30 积分/u)
  assert.match(message, /40018/u)
  assert.ok(!message.includes('private-diagnostic-token'))
})

test('保留平台给出的失败原因、错误码和可定位的请求编号', () => {
  const message = videoCliFailure('jimeng', {
    code: 40018, reason: 'insufficient_credits', message: '积分不足，还需要 30 积分', request_id: 'req-123',
  }, '即梦请求失败')
  assert.match(message, /积分不足，还需要 30 积分/u)
  assert.match(message, /40018/u)
  assert.match(message, /insufficient_credits/u)
  assert.match(message, /req-123/u)
})

test('读取画布节点及嵌套错误的具体原因', () => {
  assert.match(videoCliFailure('libtv', { node: { data: { failedReason: '参考音频超过时长限制' } } }, '生成失败'), /参考音频超过时长限制/u)
  assert.match(videoCliFailure('jimeng', { error: { details: { message: '模型目前只允许会员使用' } } }, '生成失败'), /模型目前只允许会员使用/u)
  assert.equal(videoCliFailure('libtv', {}, '未返回失败原因'), '未返回失败原因')
})

test('诊断不携带认证材料、命令参数或个人联系方式', () => {
  const message = videoCliFailure('libtv', {
    failedReason: '请求被拒绝 token=abc-secret cookie=session-secret Authorization: Bearer bear-secret；手机号 13812345678；https://example.com/?signature=url-secret',
    code: 403,
  }, '失败')
  for (const secret of ['abc-secret', 'session-secret', 'bear-secret', '13812345678', 'url-secret']) assert.ok(!message.includes(secret), secret)
  assert.match(message, /请求被拒绝/u)
  assert.match(message, /403/u)
  assert.equal(videoCliFailure('jimeng', { message: 'Command failed: dreamina --device-code=hidden --prompt=private' }, '即梦请求失败'), '即梦请求失败')
})

test('去重、限制长度并忽略任意对象及原始命令输出', () => {
  const circular: Record<string, unknown> = { message: '同一个原因', error: { message: '同一个原因' }, secret: 'hidden' }
  circular.cause = circular
  assert.equal(videoCliFailure('jimeng', circular, '失败'), '即梦：同一个原因')
  assert.ok(videoCliFailure('libtv', { message: '原因'.repeat(2000) }, '失败').length <= 600)
  assert.equal(videoCliFailure('libtv', 'Command failed: libtv --token=hidden', '调用失败'), '调用失败')
  assert.equal(videoCliFailure('libtv', 'must-not-be-returned', '调用失败'), '调用失败')
  const stderr = videoCliFailure('libtv', JSON.stringify({ error: { message: '账号并发额度已满', code: 429 }, credentialsPath: 'hidden-path' }), '调用失败')
  assert.match(stderr, /账号并发额度已满/u)
  assert.match(stderr, /429/u)
  assert.ok(!stderr.includes('hidden-path'))
})
