import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const busyAt = page.indexOf('const assetExtractionBusy = computed(')
const actionsAt = page.indexOf('function assetExtractionPath(')
const pollAt = page.indexOf('watch(() => pageVisible.value && !loadingProjects.value ? selectedProjectId.value')
assert.ok(busyAt >= 0 && actionsAt >= 0 && pollAt >= 0)
const code = ts.transpileModule(page.slice(busyAt, page.indexOf('const assetExtractionPollState =', busyAt)) +
  page.slice(actionsAt, page.indexOf('async function loadAssetImageModels', actionsAt)) +
  page.slice(pollAt, page.indexOf('let requestActivityRefresh', pollAt)), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

const interrupted = { id: 'job-1', status: 'failed', resumable: true, completed: 2, total: 5, stage: { title: '第 3 集', episodeNumber: 3 } }
const path = '/projects/project/assets/extract'
const flush = () => new Promise(resolve => setImmediate(resolve))
const serialized = value => JSON.parse(JSON.stringify(value))

function extractionFixture(request) {
  const timers = new Set()
  const calls = []
  let watchCallback, cleanup
  const app = {
    alive: true,
    selectedProjectId: { value: 'project' }, currentProject: { value: { id: 'project' } },
    loadingProjects: { value: false }, pageVisible: { value: true }, dialog: { value: null },
    readingAssetScripts: { value: false }, assetExtractionFailedJob: { value: interrupted },
    assetExtractionSourceForm: { value: false }, assetExtractionRestarting: { value: false },
    assetExtractionJobs: new Map(), assetExtractionPollStates: new Map(), assetExtractionApplied: new Map(),
    assetExtractionErrors: new Map(), assetExtractionSubmissions: new Set(),
    assetScriptSources: { value: [{ title: '初见', script: '测试剧本', number: 1 }] }, assetScriptErrors: { value: [] },
    groupImportedEpisodes: episodes => ({ episodes, errors: [] }),
    textRequestOptions: () => ({configId: undefined, model: undefined}),
    requireSharedProjectEdit: () => true,
    saveProjectNow: async () => {}, refreshProject: async () => {},
    watch: (_selected, callback) => { watchCallback = callback },
    toast: { error() {}, success() {} },
    AbortSignal, AbortController,
    setTimeout: callback => { timers.add(callback); return callback },
    clearTimeout: callback => timers.delete(callback),
    scriptVideoRequest: (...args) => { calls.push(args); return request(...args) },
  }
  app.computed = get => ({ get value() { return get() } })
  app.submittingAssetExtraction = app.computed(() => app.assetExtractionSubmissions.has(app.currentProject.value.id))
  app.activeAssetExtraction = app.computed(() => app.assetExtractionJobs.get(app.currentProject.value.id))
  runInNewContext(`let requestAssetExtractionStatus; let assetScriptProjectId = ''; ${code};
    wakeExtractionForTest = () => requestAssetExtractionStatus?.()`, app)
  return { app, calls, timers, openProject(id) {
    cleanup?.()
    app.selectedProjectId.value = id
    app.currentProject.value = { id }
    watchCallback(id, undefined, callback => { cleanup = callback })
  }, close() { cleanup?.() } }
}

test('项目载入时只读取保存的失败任务，断线后保留已完成分段并重读进度', async () => {
  let response = interrupted
  const { app, calls, timers, openProject, close } = extractionFixture(async () => response)
  openProject('project')
  await flush()
  assert.equal(app.assetExtractionJobs.get('project'), interrupted)
  assert.equal(app.assetExtractionPollStates.get('project'), 'ready')
  assert.equal(timers.size, 0)
  response = { message: '服务返回了无法识别的结果' }
  app.wakeExtractionForTest()
  await flush()
  assert.equal(app.assetExtractionPollStates.get('project'), 'unavailable')
  assert.equal(app.assetExtractionJobs.get('project').completed, 2)
  assert.equal(timers.size, 1)
  response = { ...interrupted, status: 'running', completed: 3, resumable: false }
  timers.values().next().value()
  await flush()
  assert.equal(app.assetExtractionPollStates.get('project'), 'ready')
  assert.equal(app.assetExtractionJobs.get('project').completed, 3)
  assert.ok(calls.every(call => call[0] === path && call[1] === 'GET'))
  close()
})

test('切换项目丢弃旧任务的慢响应，将 API 空包识别为尚无提取任务', async () => {
  let resolveOld
  const { app, calls, openProject, close } = extractionFixture(async uri => uri === path
    ? await new Promise(resolve => { resolveOld = resolve }) : { code: 200, data: null, message: 'success' })
  openProject('project')
  openProject('next')
  resolveOld(interrupted)
  await flush()
  assert.equal(calls[0][3].aborted, true)
  assert.equal(app.assetExtractionJobs.get('project'), undefined)
  assert.equal(app.assetExtractionJobs.get('next'), undefined)
  assert.equal(app.assetExtractionPollStates.get('next'), 'ready')
  close()
})

test('继续提取使用原任务编号，省略来源和未选择的模型参数', async () => {
  const { app, calls } = extractionFixture(async () => ({ ...interrupted, status: 'running' }))
  app.saveProjectNow = async () => { throw new Error('resume must not save pending project changes') }
  app.textRequestOptions = () => ({ configId: 12, model: 'global-default' })
  await app.startAssetExtraction(true)
  assert.equal(calls.length, 0)
  await app.resumeAssetExtraction()
  assert.deepEqual(serialized(calls), [[`${path}/${interrupted.id}/resume`, 'POST', {}]])
  assert.equal(app.assetExtractionJobs.get('project').id, interrupted.id)
})

test('继续提取可使用项目显式选定的备用模型', async () => {
  const { app, calls } = extractionFixture(async () => ({ ...interrupted, status: 'running' }))
  app.currentProject.value.settings = { textSelection: '12/alternate' }
  app.textRequestOptions = () => ({ configId: 12, model: 'alternate' })
  await app.resumeAssetExtraction()
  assert.deepEqual(serialized(calls), [[`${path}/${interrupted.id}/resume`, 'POST', { configId: 12, model: 'alternate' }]])
})

test('显式从头提取才发送替换任务编号，并保留原文件导入路径', async () => {
  const { app, calls } = extractionFixture(async () => ({ id: 'new', status: 'running', total: 1, completed: 0 }))
  app.assetExtractionSourceForm.value = true
  app.assetExtractionRestarting.value = true
  app.textRequestOptions = () => ({ configId: 12, model: 'fixture-text' })
  await app.startAssetExtraction(false)
  assert.deepEqual(serialized(calls), [[path, 'POST', {
    configId: 12, model: 'fixture-text', restartJobId: interrupted.id,
    sources: [{title: '初见', script: '测试剧本', episodeNumber: 1}],
  }]])
})

test('读取进度失败后仍可提交已导入的剧本，服务端确认已有任务时阻止重复提交', async () => {
  const running = { ...interrupted, status: 'running' }
  const { app, calls, openProject, close } = extractionFixture(async (_uri, method) => {
    if (method === 'GET') throw new Error('读取进度暂时失败')
    return running
  })
  app.assetExtractionSourceForm.value = true
  openProject('project')
  await flush()
  assert.equal(app.assetExtractionPollStates.get('project'), 'unavailable')
  await app.startAssetExtraction(false)
  await app.startAssetExtraction(false)
  const submits = calls.filter(call => call[1] === 'POST')
  assert.equal(submits.length, 1)
  assert.deepEqual(serialized(submits[0][2]), { sources: [{ title: '初见', script: '测试剧本', episodeNumber: 1 }] })
  assert.equal(app.assetExtractionJobs.get('project'), running)
  close()
})
