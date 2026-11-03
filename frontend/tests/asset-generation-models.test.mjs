import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assetModelOptions, assetModelKey, assetModelPatch, resolveAssetModel, assetReferences } from '../app/composables/useAssetGeneration.ts'

const configs = [
  { id: 1, is_active: true, provider: 'comfyui', model: ['wf-image', 'wf-z-image', 'wf-qwen-image'] },
  { id: 2, is_active: true, provider: 'openai', model: ['gpt-image-2', 'dall-e-3'] },
  { id: 3, is_active: true, provider: 'openai', model: ['gpt-image-2'] },
  { id: 4, is_active: false, provider: 'openai', model: ['disabled'] },
  { id: 5, is_active: true, provider: 'volcengine', model: ['seedream'] },
]
test('mode filters unsupported workflows and providers before submission', () => {
  assert.deepEqual(assetModelOptions(configs, 'reference').map(o => o.key), ['1/wf-image', '1/wf-qwen-image', '2/gpt-image-2', '3/gpt-image-2'])
  assert.equal(assetModelOptions(configs, 'text').some(o => o.model === 'wf-qwen-image'), false)
})
test('custom workflows must have an enabled reference input', () => {
  const custom = { id: 7, is_active: true, provider: 'comfyui', model: ['custom'], comfyui: { workflow: {}, referenceNode: '1', referencePrefix: 'image', maxReferences: 0 } }
  assert.equal(assetModelOptions([custom], 'reference').length, 0)
  custom.comfyui.maxReferences = 4
  assert.equal(assetModelOptions([custom], 'reference').length, 1)
})
test('same model from separate service configs retains exact owner', () => {
  const options = assetModelOptions(configs)
  assert.deepEqual(assetModelPatch('3/gpt-image-2', 'text', options), { image_model: 'gpt-image-2', image_config_id: 3 })
  assert.deepEqual(resolveAssetModel({ imageModel: 'gpt-image-2', imageConfigId: 3 }, 'text', options, '1/wf-image'), { model: 'gpt-image-2', configId: 3 })
  assert.throws(() => resolveAssetModel({}, 'text', options, 'openai/gpt-image-2'), /重新选择/)
})
test('text and reference overrides are independent and clearing restores inheritance', () => {
  const item = { image_model: 'wf-z-image', image_config_id: 1, reference_model: 'gpt-image-2', reference_config_id: 2 }
  const refOptions = assetModelOptions(configs, 'reference')
  assert.equal(assetModelKey(item, 'reference'), '2/gpt-image-2')
  Object.assign(item, assetModelPatch('', 'reference', refOptions))
  assert.equal(assetModelKey(item, 'reference'), '')
  assert.equal(assetModelKey(item, 'text'), '1/wf-z-image')
  assert.deepEqual(resolveAssetModel(item, 'reference', refOptions, 'comfyui:1/wf-image'), { model: 'wf-image', configId: 1 })
})
test('invalid stored override never silently falls back to another provider', () => {
  assert.throws(() => resolveAssetModel({ referenceModel: 'wf-z-image', referenceConfigId: 1 }, 'reference', assetModelOptions(configs, 'reference'), '2/gpt-image-2'), /重新选择/)
  assert.equal(assetModelKey({ imageModel: 'removed', imageConfigId: 99 }, 'text'), '99/removed')
})
test('explicit clearing supersedes a prior camelCase API value', () => {
  const item = { imageModel: 'gpt-image-2', imageConfigId: 2, image_model: null, image_config_id: null }
  assert.equal(assetModelKey(item, 'text'), '')
  assert.deepEqual(resolveAssetModel(item, 'text', assetModelOptions(configs), '1/wf-image'), { model: 'wf-image', configId: 1 })
})
test('reference parsing preserves main-first order for API and JSON database forms', () => {
  assert.deepEqual(assetReferences({ reference_images: '["static/main.png","static/secondary.png"]' }), ['static/main.png', 'static/secondary.png'])
  assert.deepEqual(assetReferences({ referenceImages: ['static/other.png', 'static/main.png'] }), ['static/other.png', 'static/main.png'])
  assert.deepEqual(assetReferences({ referenceImages: 'invalid' }), [])
})
