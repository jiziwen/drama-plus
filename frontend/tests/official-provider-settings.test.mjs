import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

const settingsPage = readFileSync(new URL('../app/components/SettingsContent.vue', import.meta.url), 'utf8')
const useApi = readFileSync(new URL('../app/composables/useApi.ts', import.meta.url), 'utf8')

function providerPresetBlock(serviceType) {
  const presetsStart = settingsPage.indexOf('const providerPresets = {')
  assert.notEqual(presetsStart, -1, 'missing providerPresets')
  const marker = `  ${serviceType}: {`
  const start = settingsPage.indexOf(marker, presetsStart)
  assert.notEqual(start, -1, `missing ${serviceType} provider presets`)
  const end = settingsPage.indexOf('\n  },', start)
  assert.notEqual(end, -1, `unterminated ${serviceType} provider presets`)
  return settingsPage.slice(start, end)
}

test('settings page retains the supported provider templates', () => {
  assert.doesNotMatch(settingsPage, /provider:\s*'chatfire'/i)
  assert.doesNotMatch(settingsPage, /openrouter/i)
  assert.doesNotMatch(settingsPage, /huobaoPreset/i)
  assert.doesNotMatch(settingsPage, /applyHuobaoPreset/i)
  assert.doesNotMatch(settingsPage, /\/huobao-preset/)
  assert.doesNotMatch(useApi, /api\.firemux\.com/i)
  assert.doesNotMatch(useApi, /applyHuobaoPreset/i)
  assert.doesNotMatch(useApi, /openrouter/i)
  assert.doesNotMatch(useApi, /huobaoPreset/i)
  assert.doesNotMatch(useApi, /\/huobao-preset/)

  assert.match(settingsPage, /const providers = \['gemini', 'openai', 'volcengine', 'minimax', 'aliyun', 'comfyui'\]/)
  assert.match(settingsPage, /https:\/\/generativelanguage\.googleapis\.com/)
  assert.match(settingsPage, /https:\/\/api\.openai\.com/)
  assert.match(settingsPage, /https:\/\/ark\.cn-beijing\.volces\.com/)
  assert.match(settingsPage, /https:\/\/\{WorkspaceId\}\.cn-beijing\.maas\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.deepseek\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/dashscope\.aliyuncs\.com/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.vidu\.com/)
  assert.doesNotMatch(settingsPage, /\['ali'|'ali',|, 'ali'\]/)
  assert.doesNotMatch(settingsPage, /applyHuobaoQuickConfig|huobaoQuickConfigs|quick-card/)
  assert.doesNotMatch(settingsPage, /https:\/\/api\.minimax\.io/)
})

test('settings page offers official default model IDs', () => {
  assert.match(settingsPage, /gemini-3\.1-pro-preview/)
  assert.match(settingsPage, /gemini-3\.8-flash/)
  assert.match(settingsPage, /gemini-3-flash-preview/)
  assert.match(settingsPage, /gpt-5\.6-terra/)
  assert.match(settingsPage, /gemini-3-pro-image/)
  assert.match(settingsPage, /gemini-3\.1-flash-image/)
  assert.match(settingsPage, /gpt-image-2/)
  assert.match(settingsPage, /doubao-seedance-2-0-260128/)
  assert.match(settingsPage, /doubao-seedance-2-0-fast-260128/)
  assert.match(settingsPage, /doubao-seedance-2-0-mini-260615/)
  assert.match(settingsPage, /wan3\.0-video-prime/)
  assert.match(settingsPage, /wan3\.0-video/)
  assert.match(settingsPage, /deepseek-v4-pro/)
  assert.doesNotMatch(settingsPage, /gpt-5\.4/)
  assert.doesNotMatch(settingsPage, /doubao-seed-1-6/)
  assert.doesNotMatch(settingsPage, /wan2\.6-t2i/)
  assert.doesNotMatch(settingsPage, /wan2\.6-i2v-flash/)
  assert.doesNotMatch(settingsPage, /viduq3-turbo/)
  assert.doesNotMatch(settingsPage, /viduq3-pro/)
  assert.doesNotMatch(settingsPage, /gemini-2\.5-flash/)
  assert.doesNotMatch(settingsPage, /gpt-4\.1-mini/)
  assert.doesNotMatch(settingsPage, /gpt-image-1/)
  assert.doesNotMatch(settingsPage, /gemini-3-pro-image-preview/)
  assert.doesNotMatch(settingsPage, /gemini-3\.1-flash-image-preview/)
  assert.doesNotMatch(settingsPage, /doubao-seedream/)
  assert.doesNotMatch(settingsPage, /speech-2\.8-hd/)
})

test('CLI video configs expose account details and text, ComfyUI and AICost offer a connection test', () => {
  assert.match(settingsPage, /v-if="isServerVideoCli\(c\.provider\)" class="btn btn-ghost btn-sm" @click="startEditCfg\(c\)">\{\{ t\('settings\.jimeng\.viewAccount'\) \}\}/)
  assert.match(settingsPage, /v-else-if="st\.type === 'text' \|\| \['comfyui', 'aicost'\]\.includes\(c\.provider\)" class="btn btn-ghost btn-sm" @click="testExistingCfg\(c\)">\{\{ t\('settings\.ai\.test'\) \}\}/)
})

test('settings page offers the supported official provider presets', () => {
  assert.match(providerPresetBlock('text'), /deepseek-v4-pro/)
  assert.doesNotMatch(providerPresetBlock('text'), /minimax/i)
  assert.doesNotMatch(providerPresetBlock('image'), /'ali'|minimax/i)
  assert.match(providerPresetBlock('image'), /midjourney:.*https:\/\/api\.hllapi\.vip.*'mj_imagine',\s*'mj_blend'/)
  assert.match(providerPresetBlock('video'), /volcengine/)
  assert.match(providerPresetBlock('video'), /minimax/)
  assert.match(providerPresetBlock('video'), /aliyun/)
  assert.doesNotMatch(providerPresetBlock('video'), /'vidu'/i)
  assert.doesNotMatch(settingsPage, /audio:\s*\{/)
})

test('AICost is offered only for video and its preset starts without models', () => {
  const providers = settingsPage.slice(settingsPage.indexOf('const providers ='), settingsPage.indexOf('const serviceMeta ='))
  const presets = settingsPage.slice(settingsPage.indexOf('const providerPresets ='), settingsPage.indexOf('function byType(t)'))
  const applyPreset = settingsPage.slice(settingsPage.indexOf('function applyProviderPreset('), settingsPage.indexOf('async function loadCfgs('))
  const defaultModel = settingsPage.slice(settingsPage.indexOf('function defaultModelOf('), settingsPage.indexOf('function isDefaultModel('))
  const cfgForm = { models: ['previous-video-model'], service_type: 'video' }
  const cfgs = { value: [
    { id: 1, service_type: 'video', provider: 'aicost', model: [], is_active: true, priority: 5 },
    { id: 2, service_type: 'video', provider: 'volcengine', model: ['previous-video-model'], is_active: true, priority: 1 },
  ] }
  const libtvVideoModels = ['star-video2.5-flash', 'star-video2.5-draft', 'star-video2.5']
  const context = { cfgForm, cfgs, computed: fn => fn, cfgTestResult: { value: null }, comfyConfigError: { value: '' }, libtvVideoModels }
  runInNewContext(`${providers}\n${presets}\n${applyPreset}\n${defaultModel}\nObject.assign(this, { providerSelectOptions, providerPresets, applyProviderPreset, defaultModelOf })`, context)
  assert.equal(context.providerSelectOptions().find(option => option.value === 'aicost')?.label, 'AICost')
  context.applyProviderPreset('video', 'aicost')
  assert.equal(cfgForm.provider, 'aicost')
  assert.equal(cfgForm.base_url, 'https://www.aicost.me')
  assert.equal(cfgForm.models.length, 0)
  assert.equal(context.defaultModelOf('video').configId, 2)
  cfgs.value[0].model.push('user-entered-model')
  assert.equal(context.defaultModelOf('video').model, 'user-entered-model')
  context.applyProviderPreset('video', 'libtv')
  assert.equal(cfgForm.base_url, '')
  assert.deepEqual(Array.from(cfgForm.models), libtvVideoModels)
  for (const type of ['text', 'image']) {
    cfgForm.service_type = type
    assert.ok(!context.providerSelectOptions().some(option => ['aicost', 'libtv'].includes(option.value)))
    assert.equal(context.providerPresets[type].aicost, undefined)
  }
  assert.ok(context.providerSelectOptions().some(option => option.value === 'midjourney'))
  cfgForm.service_type = 'video'
  assert.ok(!context.providerSelectOptions().some(option => option.value === 'midjourney'))
})
