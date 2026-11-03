import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { assetReferenceSrc, canonicalAssetReference, uniqueAssetReferences } from '../app/composables/useAssetGeneration.ts'

const component = readFileSync(new URL('../app/components/AssetReferenceEditor.vue', import.meta.url), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
const script = ts.transpileModule(component.replace(/^import .*$/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
function setup(uploadImage = async () => ({ path: 'static/uploaded.png' })) {
  const events = [], props = { modelValue: [], disabled: false, history: [], currentImage: '' }
  let unmount
  const context = {
    defineProps: () => props, withDefaults: props => props,
    defineEmits: () => (event, value) => { events.push([event, value]); if (event === 'update:modelValue') props.modelValue = value },
    useI18n: () => ({ t: value => value }),
    ref: value => ({ value }), computed: getter => ({ get value() { return getter() } }),
    onBeforeUnmount: callback => { unmount = callback }, uploadAPI: { image: uploadImage },
    assetReferenceSrc, canonicalAssetReference, uniqueAssetReferences,
  }
  runInNewContext(script + '\nglobalThis.actions = { add, hasReference, makeMain, upload }', context)
  return { ...context.actions, props, events, unmount: () => unmount() }
}
const file = (name = 'reference.png') => ({ name, type: 'image/png', size: 123 })

test('current image and history aliases cannot consume duplicate reference slots', () => {
  const editor = setup()
  editor.add('/static/main.png')
  editor.add('static/main.png')
  assert.equal(editor.props.modelValue.length, 1)
  assert.equal(editor.hasReference('/static/main.png'), true)
  editor.add('static/side.png')
  editor.makeMain(1)
  assert.deepEqual(Array.from(editor.props.modelValue), ['static/side.png', 'static/main.png'])
  assert.deepEqual(uniqueAssetReferences(['/static/main.png', 'static/main.png']), ['static/main.png'])
})
test('oversized selection is rejected before uploading', async () => {
  let calls = 0
  const editor = setup(async () => { calls++; return { path: '' } })
  await editor.upload({ target: { files: Array.from({ length: 5 }, () => file()), value: 'selected' } })
  assert.equal(calls, 0)
  assert.deepEqual(editor.events.at(-1), ['error', 'assetGeneration.maxReferences'])
})
test('upload completion after the editor closes cannot modify another asset', async () => {
  let release
  const editor = setup(() => new Promise(resolve => { release = resolve }))
  const upload = editor.upload({ target: { files: [file()], value: 'selected' } })
  editor.unmount()
  release({ path: 'static/late.png' })
  await upload
  assert.equal(editor.events.some(([event]) => event === 'update:modelValue'), false)
})
test('a partial upload keeps successful references and reports the failed file', async () => {
  let calls = 0
  const editor = setup(async () => { if (++calls === 2) throw new Error('Upload disconnected'); return { path: '/static/ok.png' } })
  await editor.upload({ target: { files: [file('one.png'), file('two.png')], value: 'selected' } })
  assert.deepEqual(Array.from(editor.props.modelValue), ['static/ok.png'])
  assert.equal(editor.events.some(([event, value]) => event === 'error' && value === 'Upload disconnected'), true)
  assert.deepEqual(editor.events.at(-1), ['uploading', false])
})

const detail = readFileSync(new URL('../app/views/drama/detail.vue', import.meta.url), 'utf8')
test('asset cards display API snake_case prompts for every asset kind without changing stored content', () => {
  const data = {
    characters: [{ id: 12, final_prompt: '角色已有三视图提示词' }],
    scenes: [{ id: 10, final_prompt: '场景已有固定视角提示词' }],
    props: [{ id: 2, final_prompt: '道具已有白底提示词' }],
  }
  const context = { drama: { value: data }, t: value => value, computed: getter => ({ get value() { return getter() } }), KIND_ORDER: { character: 0, scene: 1, prop: 2 } }
  runInNewContext(detail.slice(detail.indexOf('const materials = computed('), detail.indexOf('const visibleAssets = computed(')) + '\nglobalThis.records = () => materials.value', context)
  assert.deepEqual(Array.from(context.records(), row => row.finalPrompt), ['角色已有三视图提示词', '场景已有固定视角提示词', '道具已有白底提示词'])
  assert.equal(data.characters[0].final_prompt, '角色已有三视图提示词')
  data.characters[0] = { id: 12, final_prompt: null, finalPrompt: 'outdated cached prompt' }
  assert.equal(context.records()[0].finalPrompt, '')
  data.characters[0] = { id: 12, finalPrompt: 'legacy camelCase prompt' }
  assert.equal(context.records()[0].finalPrompt, 'legacy camelCase prompt')
})
const pollSource = detail.slice(detail.indexOf('let materialPageAlive = true'), detail.indexOf('function switchToAssets()'))
test('existing result stays pending through processing and transient polling errors; failure is shown once', async () => {
  let calls = 0
  const errors = []
  const m = { id: 1, kindKey: 'character', image_url: 'static/old.png' }
  const context = { pendingKey: item => `${item.kindKey}:${item.id}`, pendingMaterials: { value: new Set(['character:1']) }, sleep: async () => {}, onBeforeUnmount() {},
    taskAPI: { get: async () => { calls++; if (calls === 1) throw new Error('Temporary connection'); if (calls === 2) return { status: 'processing' }; return { status: 'failed', errorMsg: 'ComfyUI failed' } } },
    toastError: message => errors.push(message), toast: { info() {} }, t: value => value, load: async () => {}, materials: { value: [m] }, editTarget: { value: m }, matImage: item => item.image_url || item.imageUrl,
  }
  runInNewContext(pollSource, context)
  await context.pollMaterial(m, 10)
  assert.equal(calls, 3)
  assert.equal(context.pendingMaterials.value.size, 0)
  assert.deepEqual(errors, ['ComfyUI failed'])
})
test('completion updates both image field aliases in an open detail without clearing its draft', async () => {
  const m = { id: 1, kindKey: 'character', image_url: 'static/old.png', imageModel: 'chosen' }
  const context = { pendingKey: item => `${item.kindKey}:${item.id}`, pendingMaterials: { value: new Set(['character:1']) }, sleep: async () => {}, onBeforeUnmount() {},
    taskAPI: { get: async () => ({ status: 'completed' }) }, toastError() {}, toast: { info() {} }, t: value => value,
    load: async () => {}, materials: { value: [{ id: 1, kindKey: 'character', imageUrl: 'static/new.png', imageModel: 'old' }] }, editTarget: { value: m }, matImage: item => item.image_url || item.imageUrl,
  }
  runInNewContext(pollSource, context)
  await context.pollMaterial(m, 10)
  assert.equal(m.image_url, 'static/new.png')
  assert.equal(m.imageUrl, 'static/new.png')
  assert.equal(m.imageModel, 'chosen')
})

test('prompt generation never replaces manual text entered while the request is pending', async () => {
  let release
  const m = { id: 1, kindKey: 'character' }
  const context = { firstEpisodeId: { value: 1 }, finalPromptGen: { value: false }, historyRequest: 2, editDraft: { finalPrompt: 'original' }, editTarget: { value: m },
    characterAPI: { generatePrompt: () => new Promise(resolve => { release = resolve }) }, applyMaterialPatch: (target, patch) => Object.assign(target, patch), toast: { success() {} }, toastError() {}, t: value => value,
  }
  runInNewContext(detail.slice(detail.indexOf('async function generateFinalPrompt(m)'), detail.indexOf('function closeEdit()')), context)
  const request = context.generateFinalPrompt(m)
  context.editDraft.finalPrompt = 'new user text'
  release({ final_prompt: 'agent text' })
  await request
  assert.equal(context.editDraft.finalPrompt, 'new user text')
  assert.equal(m.finalPrompt, 'agent text')
})
test('saving an earlier text snapshot keeps subsequent edits visible in the dialog', async () => {
  let release, closed = false, savedPayload
  const m = { id: 1, kindKey: 'character' }
  const context = { editTarget: { value: m }, editSaving: { value: false }, referenceUploading: { value: false }, editMode: { value: 'text' },
    editDraft: { name: 'Name', appearance: 'before', styling: '', finalPrompt: 'prompt' }, characterAPI: { update: (id, payload) => { savedPayload = payload; return new Promise(resolve => { release = resolve }) } },
    applyMaterialPatch: (target, patch) => Object.assign(target, patch), toast: { success() {} }, toastError() {}, t: value => value, closeEdit: () => { closed = true },
  }
  runInNewContext(detail.slice(detail.indexOf('async function saveEdit('), detail.indexOf('async function saveAndGenerateMaterial()')), context)
  const save = context.saveEdit()
  context.editDraft.appearance = 'new unsaved appearance'
  release()
  await save
  assert.equal(savedPayload.appearance, 'before')
  assert.equal(m.appearance, 'before')
  assert.equal(context.editDraft.appearance, 'new unsaved appearance')
  assert.equal(closed, false)
})
