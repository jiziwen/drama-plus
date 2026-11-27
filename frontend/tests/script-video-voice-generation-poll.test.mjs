import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('watch([selectedProjectId, loadingProjects]')
const end = source.indexOf('function pendingAudioEdits', start)
assert.ok(start >= 0 && end > start)
const script = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('restores an active voice job, refreshes the project on completion and stops polling', async () => {
  const calls = [], timers = [], results = [
    [{ id: 3, assetId: 'hero', status: 'processing' }],
    [{ id: 3, assetId: 'hero', status: 'completed' }],
  ]
  let watcher, cleanup
  const context = {
    selectedProjectId: { value: 'project' }, loadingProjects: {}, voiceJobs: { value: new Map() }, alive: true,
    watch: (_sources, callback) => { watcher = callback },
    scriptVideoRequest: async (...args) => { calls.push(args); return results.shift() },
    refreshProject: async (...args) => calls.push(['refresh', ...args]),
    setTimeout: callback => { timers.push(callback); return callback }, clearTimeout: () => {},
    AbortController, Map, Set, encodeURIComponent,
  }
  runInNewContext(`let wakeVoicePoll; ${script}`, context)
  watcher(['project', false], undefined, callback => { cleanup = callback })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.voiceJobs.value.get('hero').status, 'processing')
  assert.equal(timers.length, 1)
  timers.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.voiceJobs.value.get('hero').status, 'completed')
  assert.equal(calls.filter(call => call[0] === 'refresh').length, 1)
  assert.equal(timers.length, 0)
  cleanup()
})

test('a response from the previous project cannot update the newly selected project', async () => {
  let watcher, resolveRequest
  const context = {
    selectedProjectId: { value: 'old' }, loadingProjects: {}, voiceJobs: { value: new Map() }, alive: true,
    watch: (_sources, callback) => { watcher = callback },
    scriptVideoRequest: () => new Promise(resolve => { resolveRequest = resolve }),
    refreshProject: () => { throw new Error('must not refresh the old project') },
    setTimeout: () => { throw new Error('must not start another poll') }, clearTimeout: () => {},
    AbortController, Map, Set, encodeURIComponent,
  }
  runInNewContext(`let wakeVoicePoll; ${script}`, context)
  watcher(['old', false], undefined, () => {})
  context.selectedProjectId.value = 'new'
  resolveRequest([{ id: 3, assetId: 'hero', status: 'completed' }])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.voiceJobs.value.size, 0)
})

test('notifies once when a running job fails and keeps its failure reason on the card', async () => {
  const reason = '即梦：生成视频版权校验未通过（20115）'
  const old = {id: 2, assetId: 'guard', status: 'failed', error: '之前的失败'}
  const failed = {id: 3, assetId: 'hero', status: 'failed', error: reason}
  const results = [
    [{id: 3, assetId: 'hero', status: 'processing'}, old],
    [failed, old],
    [failed, old],
  ]
  const timers = [], notifications = []
  let watcher
  const context = {
    selectedProjectId: {value: 'project'}, loadingProjects: {}, voiceJobs: {value: new Map()}, alive: true,
    currentProject: {value: {id: 'project', assets: [{id: 'hero', name: '守卫'}]}},
    voiceFailureDetail: message => message,
    notifyVoiceGenerationFailure: (...args) => notifications.push(args),
    watch: (_sources, callback) => { watcher = callback },
    scriptVideoRequest: async () => results.shift(),
    setTimeout: callback => { timers.push(callback); return callback }, clearTimeout: () => {},
    AbortController, Map, Set, encodeURIComponent,
  }
  runInNewContext(`let wakeVoicePoll; ${script}; wakeVoicePollForTest = () => wakeVoicePoll()`, context)
  watcher(['project', false], undefined, () => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(notifications, [])
  timers.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.voiceJobs.value.get('hero').error, reason)
  assert.deepEqual(notifications, [['守卫', reason]])
  context.wakeVoicePollForTest()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(notifications.length, 1)
})

test('keeps an immediate submission failure on the matching character and clears it on retry', async () => {
  const start = source.indexOf('function voiceFailureDetail(')
  const end = source.indexOf('let wakeVoicePoll', start)
  const submitStart = source.indexOf('async function generateCharacterVoice(')
  const submitEnd = source.indexOf('function removeCharacterVoice(', submitStart)
  const {outputText} = ts.transpileModule(
    source.slice(start, end) + source.slice(submitStart, submitEnd),
    {compilerOptions: {target: ts.ScriptTarget.ES2022}},
  )
  const notifications = []
  const model = {configId: 7, model: 'jimeng'}
  const reason = '服务端 FFmpeg 不可用，无法提取角色声音'
  const context = {
    currentProject: {value: {id: 'project', assets: [{id: 'hero', kind: 'character', name: '守卫'}]}},
    voiceJobs: {value: new Map()}, voiceStarts: {value: new Set()}, voiceStartErrors: {value: new Map()},
    voiceEdits: {value: new Map()}, voiceGenerationOptions: {value: [model]}, episodeOpen: {value: true},
    requireSharedProjectEdit: () => true, alive: true, wakeVoicePoll: () => {}, saveProjectNow: async () => {},
    scriptVideoRequest: async () => { throw new Error(reason) }, Error,
    toast: {error: (title, {description}) => notifications.push([title, description])},
  }
  runInNewContext(outputText, context)
  await context.generateCharacterVoice('hero', {...model, description: '沉稳', dialogue: '来了。'})
  assert.equal(context.voiceGenerationError('hero'), reason)
  assert.equal(context.voiceGenerationError('guard'), '')
  assert.deepEqual(notifications, [['守卫的角色声音生成失败', reason]])

  context.scriptVideoRequest = async () => ({id: 3, assetId: 'hero', status: 'processing'})
  await context.generateCharacterVoice('hero', {...model, description: '沉稳', dialogue: '来了。'})
  assert.equal(context.voiceGenerationError('hero'), '')
  assert.equal(context.voiceJobs.value.get('hero').status, 'processing')
})
