import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const script = ts.transpileModule([
  slice('async function loadTextModelOptions()', 'watch(voiceSettingsRevision, () => { void loadTextModelOptions() })'),
  slice('function textRequestOptions(', 'const revisionRequester ='),
].join('\n'), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText

test('text default follows exact global config and model while project overrides remain explicit', async () => {
  const configs = [
    {id:1, name:'A', provider:'openai', is_active:true, model:['same', 'other'], global_default_model:null},
    {id:2, name:'B', provider:'openai', is_active:true, model:['same', 'other'], global_default_model:'other'},
  ]
  const context = { alive:true, aiConfigAPI:{list:async () => configs}, textOptions:{value:[]}, toast:{error(){}}, defaultAgentPrompt:'default', currentProject:{value:{settings:{}}} }
  runInNewContext(`let textOptionsVersion = 0; ${script}`, context)
  await context.loadTextModelOptions()
  assert.equal(context.textOptions.value[0].key, '2:other')
  let selected = context.textRequestOptions({settings:{}})
  assert.equal(selected.configId, 2); assert.equal(selected.model, 'other')
  selected = context.textRequestOptions({settings:{textSelection:'1:same'}})
  assert.equal(selected.configId, 1); assert.equal(selected.model, 'same')
  configs[1].global_default_model = null
  configs[0].global_default_model = 'other'
  await context.loadTextModelOptions()
  selected = context.textRequestOptions({settings:{}})
  assert.equal(selected.configId, 1); assert.equal(selected.model, 'other')
  selected = context.textRequestOptions({settings:{textSelection:'1:same'}})
  assert.equal(selected.configId, 1); assert.equal(selected.model, 'same')
  assert.match(source, /watch\(voiceSettingsRevision, \(\) => \{ void loadTextModelOptions\(\) \}\)/)
})
