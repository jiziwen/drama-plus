import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../app/components/SettingsContent.vue', import.meta.url), 'utf8')

test('Agent Plan preset fills a distinct endpoint and aliases while retaining the video provider', () => {
  const presets = source.slice(source.indexOf('const providerPresets = {'), source.indexOf('function byType(t)'))
  const functions = source.slice(source.indexOf('function presetsByType('), source.indexOf('async function loadCfgs('))
  const context = { cfgForm: {}, cfgTestResult: { value: { status: 404 } }, comfyConfigError: { value: '' } }
  runInNewContext(`${presets}\n${functions}\nthis.presets = presetsByType('video'); applyProviderPreset('video', 'agentPlan')`, context)
  assert.equal(new Set(context.presets.map(p => p.key)).size, context.presets.length)
  assert.equal(context.cfgForm.provider, 'volcengine')
  assert.equal(context.cfgForm.base_url, 'https://ark.cn-beijing.volces.com/api/plan/v3')
  assert.deepEqual(Array.from(context.cfgForm.models), ['doubao-seedance-2.0-mini', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0'])
  assert.match(context.cfgForm.name, /Agent Plan/)
  assert.equal(context.cfgTestResult.value, null)
  runInNewContext("applyProviderPreset('video', 'volcengine')", context)
  assert.equal(context.cfgForm.base_url, 'https://ark.cn-beijing.volces.com')
  assert.equal(context.cfgForm.models[0], 'doubao-seedance-2-0-mini-260615')
})
