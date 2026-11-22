import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { apiErrorMessage } from '../app/composables/useApi'

test('API 保留平台返回的具体嵌套错误原因', () => {
  assert.equal(apiErrorMessage({ error: { message: 'LibTV 任务失败：当前账号积分不足' } }, 502), 'LibTV 任务失败：当前账号积分不足')
  assert.equal(apiErrorMessage({ detail: '即梦 任务失败：参考音频无法下载' }, 500), '即梦 任务失败：参考音频无法下载')
  assert.equal(apiErrorMessage({}, 503), '请求失败（HTTP 503）')
})

test('平台已脱敏的具体错误通过通知显示，不被通用映射覆盖', () => {
  const source = readFileSync(new URL('../app/composables/useToast.ts', import.meta.url), 'utf8')
  const module = { exports: {} as { mapError: (message: string) => string } }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, require(name: string) {
      return name === 'vue-sonner' ? { toast: {} } : { i18n: { global: { t: (key: string) => key } } }
    },
  })
  for (const message of ['LibTV 任务失败：积分不足（quota_exceeded）', '即梦 任务失败：参考图审核未通过（image_moderation_failed）']) {
    assert.equal(module.exports.mapError(message), message)
  }
  assert.equal(module.exports.mapError('Failed to fetch'), 'errors.network')
})
