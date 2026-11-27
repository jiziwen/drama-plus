import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as vue from 'vue'
import ts from 'typescript'

const filename = 'ScriptVideoPreviewModelSelect.vue'
const source = readFileSync(new URL(`../app/components/${filename}`, import.meta.url), 'utf8')
const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source, {filename})
const compiled = compileScript(descriptor, {id:'model', inlineTemplate:true})
const { outputText } = ts.transpileModule(compiled.content, {compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022}})

function createPicker(configs, initial = '') {
  const events = [], mounted = [], revision = vue.ref(0), exported = {}
  const props = vue.reactive({modelValue:initial})
  const context = { exports: exported, require: name => {
    if (name === 'vue') return {...vue, onMounted: fn => mounted.push(fn)}
    if (name === '~/composables/useApi') return {aiConfigAPI:{list:async () => configs.value}}
    if (name.endsWith('/script-video-capabilities')) return {scriptVideoCapabilities: (_provider, model) => model === 'unsupported' ? null : {minDuration:1, maxDuration:10, wholeSeconds:true, maxAudioReferences:0, maxAudioDuration:0}}
    throw Error(name)
  }, useSettingsPanel: () => ({revision}), useModelLabel: () => x => x }
  runInNewContext(outputText, context)
  const draw = exported.default.setup(props, {emit: (...args) => events.push(args), expose() {}})
  const load = () => Promise.all(mounted.map(fn => fn()))
  async function flush() { await vue.nextTick(); await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
  return {events, props, draw, revision, load, flush}
}

test('following the global model does not persist a model key and reacts to settings changes', async () => {
  const configs = {value:[
    {id:1, provider:'openai', name:'A', model:['a', 'b'], is_active:true, global_default_model:'b'},
    {id:2, provider:'comai', name:'B', model:['c'], is_active:true, global_default_model:null},
  ]}
  const picker = createPicker(configs)
  await picker.load(); await picker.flush()
  assert.equal(picker.events.some(([name]) => name === 'update:modelValue'), false)
  let change = picker.events.filter(([name]) => name === 'change').at(-1)[1]
  assert.equal(change.key, '')
  assert.equal(change.model, 'b')
  assert.equal(change.configId, 1)
  configs.value[0].global_default_model = null
  configs.value[1].global_default_model = 'c'
  picker.revision.value++
  await picker.flush()
  change = picker.events.filter(([name]) => name === 'change').at(-1)[1]
  assert.equal(change.key, '')
  assert.equal(change.model, 'c')
  assert.equal(change.configId, 2)
})

test('pinned choices remain pinned; unsupported global choices do not fall back to another provider', async () => {
  const configs = {value:[
    {id:1, provider:'openai', model:['unsupported'], is_active:true, global_default_model:'unsupported'},
    {id:2, provider:'jimeng', model:['compatible'], is_active:true, global_default_model:null},
  ]}
  const follow = createPicker(configs)
  await follow.load(); await follow.flush()
  assert.equal(follow.events.filter(([name]) => name === 'change').at(-1)[1].maxDuration, 0)
  assert.equal(follow.events.some(([name]) => name === 'update:modelValue'), false)
  const pinned = createPicker(configs, 'config:2:compatible')
  await pinned.load(); await pinned.flush()
  assert.equal(pinned.events.filter(([name]) => name === 'change').at(-1)[1].model, 'compatible')
  assert.equal(pinned.events.some(([name]) => name === 'update:modelValue'), false)
  configs.value[0].global_default_model = null
  const fallback = createPicker(configs)
  await fallback.load(); await fallback.flush()
  assert.equal(fallback.events.filter(([name]) => name === 'change').at(-1)[1].model, 'compatible')
})

test('switching episodes remounts the picker and resolves the latest global default without pinning', async () => {
  assert.match(page, /<ScriptVideoPreviewModelSelect :key="episodeKey"/)
  const configs = {value:[
    {id:1, provider:'openai', model:['a'], is_active:true, global_default_model:'a'},
    {id:2, provider:'openai', model:['b'], is_active:true, global_default_model:null},
  ]}
  const first = createPicker(configs)
  await first.load(); await first.flush()
  assert.equal(first.events.filter(([name]) => name === 'change').at(-1)[1].model, 'a')
  configs.value[0].global_default_model = null
  configs.value[1].global_default_model = 'b'
  const second = createPicker(configs)
  assert.equal(second.events.find(([name]) => name === 'loading')[1], true)
  await second.load(); await second.flush()
  const effective = second.events.filter(([name]) => name === 'change').at(-1)[1]
  assert.equal(effective.key, '')
  assert.equal(effective.configId, 2)
  assert.equal(effective.model, 'b')
  assert.equal(second.events.some(([name]) => name === 'update:modelValue'), false)
})
