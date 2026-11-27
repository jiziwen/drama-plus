import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('async function loadVoiceGenerationOptions()')
const end = source.indexOf('watch([selectedProjectId, loadingProjects, voiceSettingsRevision]', start)
assert.ok(start >= 0 && end > start)
const script = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('uses backend-verified account models and surfaces an availability message', async () => {
  const calls = []
  const context = {
    selectedProjectId: {value:'project'}, loadingProjects: {value:false}, alive: true,
    voiceGenerationOptions: {value:[]}, voiceGenerationMessage: {value:''}, voiceOptionsLoading: {value:false},
    scriptVideoRequest: async path => { calls.push(path); return {options: [
      {configId: 3, model: 'jimeng-seedance-2.0-mini', label: '即梦', resolution: '720p'},
      {configId: 7, model: 'libtv-mini', label: 'LibTV', resolution: '480p'},
    ], message: '部分账号不可用'} }, encodeURIComponent,
  }
  runInNewContext(`let voiceOptionsVersion = 0, voiceOptionsProject = ''; ${script}`, context)
  await context.loadVoiceGenerationOptions()
  assert.deepEqual(calls, ['/projects/project/assets/voice-generation-models'])
  assert.deepEqual(Array.from(context.voiceGenerationOptions.value, o => o.key), ['3/jimeng-seedance-2.0-mini', '7/libtv-mini'])
  assert.deepEqual(Array.from(context.voiceGenerationOptions.value, o => o.resolution), ['720p', '480p'])
  assert.equal(context.voiceGenerationMessage.value, '部分账号不可用')
  assert.equal(context.voiceOptionsLoading.value, false)
})

test('ignores model results received after switching project', async () => {
  let resolveRequest
  const context = {
    selectedProjectId: {value:'old'}, loadingProjects: {value:false}, alive: true,
    voiceGenerationOptions: {value:[]}, voiceGenerationMessage: {value:''}, voiceOptionsLoading: {value:false},
    scriptVideoRequest: () => new Promise(resolve => { resolveRequest = resolve }), encodeURIComponent,
  }
  runInNewContext(`let voiceOptionsVersion = 0, voiceOptionsProject = ''; ${script}`, context)
  const pending = context.loadVoiceGenerationOptions()
  context.selectedProjectId.value = 'new'
  resolveRequest({options: [{configId: 3, model: 'jimeng-seedance-2.0-mini', label: '即梦'}]})
  await pending
  assert.equal(context.voiceGenerationOptions.value.length, 0)
})
