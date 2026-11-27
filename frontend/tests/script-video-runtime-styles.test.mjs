import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ref, shallowRef } from 'vue'
import ts from 'typescript'
import { SCRIPT_VIDEO_STYLE_PRESETS, getScriptVideoStylePreset, isScriptVideoStylePreset } from '../../backend/src/services/script-video-style.ts'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, '页面实现存在：' + startMarker)
  return source.slice(start, end)
}
const script = ts.transpileModule([
  section('const stylePresets =', 'const creatingProject ='),
  section('async function refreshProject(', 'function persistDraft('),
  section('function openProjectDialog(', 'async function createProject('),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function setup(request) {
  const calls = []
  const sharedLoaded = new Map([['project', 1]])
  const serverSnapshots = new Map()
  const currentProject = ref({ id: 'project', settings: { stylePreset: getScriptVideoStylePreset('cool') } })
  const dialog = ref(null)
  const context = {
    ref, shallowRef, SCRIPT_VIDEO_STYLE_PRESETS, getScriptVideoStylePreset, isScriptVideoStylePreset,
    alive: true, requestController: new AbortController(), AbortSignal, createScriptVideoUuid: () => crypto.randomUUID(),
    currentProject, dialog, sharedLoaded, serverSnapshots, newProjectTitle: ref(''), styleProjectId: ref(''),
    requireSharedProjectEdit: () => true,
    projects: ref([currentProject.value]), savingStyle: ref(false), validProjectStyle: ref(true),
    saveProjectNow: async () => {},
    toast: { success() {}, error: error => { throw new Error(error) } },
    scriptVideoRequest: async path => { calls.push(path); return request(path) },
    materialize: summary => summary,
    acceptProject: project => serverSnapshots.set(project.id, project),
  }
  const controls = runInNewContext(script + '\n;({ stylePresets, newProjectStyle, projectStyleDraft, projectCustomStylesDraft, loadStylePresets, refreshProject, openProjectDialog, openStyleDialog, saveProjectStyle })', context)
  return { ...controls, calls, context, currentProject, dialog }
}
const latestPresets = () => SCRIPT_VIDEO_STYLE_PRESETS.map(preset => ({ ...preset, prefix: preset.prefix + '\r\n运行期更新。' }))

test('运行期预设并发只请求一次，更新未改动的草稿，相同响应保持对象稳定', async () => {
  let release
  const latest = latestPresets()
  const app = setup(() => new Promise(resolve => { release = resolve }))
  const first = app.loadStylePresets()
  const second = app.loadStylePresets()
  assert.deepEqual(app.calls, ['/style-presets'])
  release(latest)
  await Promise.all([first, second])
  assert.equal(app.stylePresets.value[0].prefix, latest[0].prefix)
  assert.equal(app.newProjectStyle.value.prefix, latest[0].prefix)
  const list = app.stylePresets.value, draft = app.newProjectStyle.value
  const third = app.loadStylePresets()
  release(latest.map(preset => ({ ...preset })))
  await third
  assert.equal(app.stylePresets.value, list)
  assert.equal(app.newProjectStyle.value, draft)
})

test('打开弹窗刷新预设，更新未改动的旧内置快照，保留自定义和已经编辑的草稿', async () => {
  let release
  const latest = latestPresets()
  const app = setup(() => new Promise(resolve => { release = resolve }))
  app.currentProject.value.settings.stylePreset.prefix = '旧冷色快照。'
  app.openStyleDialog()
  release(latest)
  await app.loadStylePresets()
  assert.equal(app.projectStyleDraft.value.prefix, latest[0].prefix)

  app.openStyleDialog()
  app.projectStyleDraft.value = { id: 'custom', name: '手写风格', prefix: '未提交的手写内容。' }
  release(latest.map(preset => ({ ...preset, prefix: preset.prefix + '再更新。' })))
  await app.loadStylePresets()
  assert.equal(app.projectStyleDraft.value.prefix, '未提交的手写内容。')

  app.openProjectDialog()
  app.newProjectStyle.value = { ...latest[0], prefix: '未提交的内置草稿改动。' }
  release(latest)
  await app.loadStylePresets()
  assert.equal(app.newProjectStyle.value.prefix, '未提交的内置草稿改动。')
})

test('共享版本刷新才并行加载预设，单分集刷新不新增预设或全量项目请求', async () => {
  const app = setup(path => path === '/style-presets' ? latestPresets() : { id: 'project', revision: 2, episodes: [] })
  await app.refreshProject('project', undefined, undefined, false)
  assert.deepEqual(app.calls, [])
  await app.refreshProject('project', undefined, undefined, true)
  assert.deepEqual(new Set(app.calls), new Set(['/style-presets', '/projects/project?view=summary']))
})

test('项目风格草稿可取消，保存时同时提交自定义列表和所选风格并保留其他页面新增的项', async () => {
  const app = setup(() => SCRIPT_VIDEO_STYLE_PRESETS)
  const old = { id: 'custom-00000000-0000-4000-8000-000000000001', name: '旧风格', prefix: '旧提示词。' }
  const next = { id: 'custom-00000000-0000-4000-8000-000000000002', name: '  水墨  ', prefix: '淡墨与留白。' }
  const remote = { id: 'custom-00000000-0000-4000-8000-000000000003', name: '定格动画', prefix: '手作羊毛毡。' }
  app.currentProject.value.settings = { stylePreset: old, customStylePresets: { [old.id]: old } }
  app.openStyleDialog()
  app.projectCustomStylesDraft.value = {}
  app.dialog.value = null
  app.openStyleDialog()
  assert.equal(app.projectCustomStylesDraft.value[old.id].prefix, old.prefix)
  assert.equal(app.projectStyleDraft.value.id, old.id)

  app.projectCustomStylesDraft.value = { [next.id]: next }
  app.projectStyleDraft.value = next
  app.currentProject.value.settings.customStylePresets[remote.id] = remote
  await app.saveProjectStyle()
  const saved = JSON.parse(JSON.stringify(app.currentProject.value.settings))
  const normalized = { ...next, name: '水墨' }
  assert.deepEqual(saved, { stylePreset: normalized, customStylePresets: { [remote.id]: remote, [next.id]: normalized } })
  assert.equal(app.dialog.value, null)

  app.openStyleDialog()
  assert.equal(app.projectStyleDraft.value.id, next.id)
  assert.deepEqual(Object.keys(app.projectCustomStylesDraft.value), [remote.id, next.id])
})

test('预设接口不可用或响应无效时保留已有预设和草稿', async () => {
  for (const request of [() => { throw new Error('离线') }, () => [{ id: 'custom', name: '错误返回', prefix: '无效' }]]) {
    const app = setup(request)
    const list = app.stylePresets.value, draft = app.newProjectStyle.value
    await app.loadStylePresets()
    assert.equal(app.stylePresets.value, list)
    assert.equal(app.newProjectStyle.value, draft)
  }
})

test('窗口回到前台和页面重新可见时刷新预设，后台保持静默', () => {
  const documentListeners = new Map(), windowListeners = new Map()
  const pageVisible = ref(false)
  let requests = 0
  const document = { visibilityState: 'visible', addEventListener: (name, callback) => documentListeners.set(name, callback) }
  const window = { addEventListener: (name, callback) => windowListeners.set(name, callback) }
  const visibilityScript = ts.transpileModule(section('function refreshVisibleStyles()', 'watch(selectedProjectId'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(visibilityScript, {
    document, window, pageVisible, loadStylePresets: () => { requests++; return Promise.resolve() },
    onMounted: callback => callback(),
  })
  assert.equal(requests, 1)
  windowListeners.get('focus')()
  assert.equal(requests, 2)
  document.visibilityState = 'hidden'
  documentListeners.get('visibilitychange')()
  windowListeners.get('focus')()
  assert.equal(requests, 2)
  document.visibilityState = 'visible'
  documentListeners.get('visibilitychange')()
  assert.equal(requests, 3)
  assert.equal(pageVisible.value, true)
})

test('新建或风格弹窗可见时每5秒只刷新预设，关闭后清理轮询', async () => {
  let requests = 0, cleanup
  const timers = new Map()
  const pollScript = ts.transpileModule(section(
    "watch(() => pageVisible.value && (dialog.value === 'project' || dialog.value === 'style')",
    'onBeforeRouteLeave('), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  runInNewContext(pollScript, {
    watch: (_, callback) => callback(true, undefined, value => { cleanup = value }),
    loadStylePresets: () => { requests++; return Promise.resolve() },
    setTimeout: (callback, interval) => { timers.set(1, { callback, interval }); return 1 },
    clearTimeout: id => timers.delete(id),
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 1)
  assert.equal(timers.get(1).interval, 5000)
  timers.get(1).callback()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, 2)
  cleanup()
  assert.equal(timers.size, 0)
})
