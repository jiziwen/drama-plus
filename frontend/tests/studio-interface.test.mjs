import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import * as vue from 'vue'

const require = createRequire(import.meta.url)
const app = new URL('../app/', import.meta.url)
const read = path => readFileSync(new URL(path, app), 'utf8')
const failNetwork = () => { throw new Error('These component tests must not contact a backend or generator') }
// An immediate watcher may await a Promise created across the VM boundary.
// Drain the host turn as well as Vue's scheduler before inspecting its result.
async function flushComponent() {
  await vue.nextTick()
  await new Promise(resolve => setImmediate(resolve))
  await vue.nextTick()
}

/** Execute the actual SFC setup with Vue reactivity; replace only browser/module boundaries. */
function setupComponent(path, props = {}, options = {}) {
  const mounted = [], unmounted = [], emitted = [], imports = options.imports || {}
  const { descriptor, errors } = parse(read(path), { filename: path })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: 'cinematic-test' })
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const exports = {}, scope = vue.effectScope()
  const refState = vue.reactive(props)
  const browserDocument = { hidden: false, addEventListener() {}, removeEventListener() {}, querySelector() { return null } }
  const context = {
    exports, console, URL, fetch: failNetwork,
    ref: vue.ref, reactive: vue.reactive, computed: vue.computed, watch: vue.watch, nextTick: vue.nextTick,
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback),
    useRoute: () => options.route || { query: {} }, useModelLabel: () => value => value,
    useStudioInterface: () => ({ interfaceLink: path => `${path}${path.includes('?') ? '&' : '?'}interface=cinematic` }),
    useSettingsPanel: () => ({ isOpen: vue.ref(false) }), document: browserDocument,
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    ...options.globals,
    require(id) {
      if (Object.hasOwn(imports, id)) return imports[id]
      if (id === 'vue') return { ...vue, onMounted: context.onMounted, onBeforeUnmount: context.onBeforeUnmount }
      if (id === 'lucide-vue-next') return require(id)
      if (id === '~/utils/projectPresentation') return loadTs('utils/projectPresentation.ts')
      if (id === '~/composables/useMedia') return loadTs('composables/useMedia.ts')
      throw new Error(`Unmocked external module ${id}`)
    },
  }
  function loadTs(path) {
    const target = {}
    const result = ts.transpileModule(read(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    runInNewContext(result, { exports: target, URL }, { filename: path })
    return target
  }
  runInNewContext(code, context, { filename: path })
  let model
  scope.run(() => { model = exports.default.setup(refState, { expose() {}, emit: (...args) => emitted.push(args) }) })
  return {
    model, props: refState, emitted,
    async mount() { for (const callback of mounted) await callback(); await flushComponent() },
    destroy() { unmounted.forEach(callback => callback()); scope.stop() },
  }
}

function loadMiddleware(storage = new Map(), unavailable = false) {
  const exports = {}
  const code = ts.transpileModule(read('middleware/cinematic.global.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(code, { exports, defineNuxtRouteMiddleware: fn => fn, navigateTo: (target, options) => ({ target, options }), localStorage: {
    getItem(key) { if (unavailable) throw new Error('Storage blocked'); return storage.get(key) ?? null },
    setItem(key, value) { if (unavailable) throw new Error('Storage blocked'); storage.set(key, value) },
  } })
  return exports.default
}

test('existing business routes preserve preview, query and hash; classic is a real exit', () => {
  const route = loadMiddleware()
  for (const path of ['/', '/assets', '/settings', '/drama/42', '/drama/42/episode/3']) {
    const result = route({ path, query: { tab: 'storage' }, hash: '#detail' }, { query: { interface: 'cinematic' } })
    assert.equal(result.target.path, path)
    assert.equal(result.target.query.interface, 'cinematic')
    assert.equal(result.target.query.tab, 'storage')
    assert.equal(result.target.hash, '#detail')
    assert.equal(result.options.replace, true)
  }
  assert.equal(route({ path: '/', query: { interface: 'classic' } }, { query: { interface: 'cinematic' } }), undefined)
  assert.equal(route({ path: '/assets', query: {} }, { query: {} }).target.query.interface, 'classic')
  assert.equal(route({ path: '/api/v1/tasks', query: {} }, { query: { interface: 'cinematic' } }), undefined)
})

test('first visits and unmarked deep links default to the new interface', () => {
  for (const path of ['/', '/assets', '/settings', '/drama/42', '/drama/42/episode/3']) {
    const result = loadMiddleware()({path,query:{tab:'assets'},hash:'#current'}, {query:{}})
    assert.equal(result.target.query.interface, 'cinematic')
    assert.equal(result.target.path, path)
    assert.equal(result.target.query.tab, 'assets')
    assert.equal(result.target.hash, '#current')
  }
})

test('either interface choice survives reloads and explicit links can switch it back', () => {
  const storage = new Map()
  const to = {path:'/drama/42/episode/3',query:{interface:'classic'},hash:'#shot-2'}
  assert.equal(loadMiddleware(storage)(to,{query:{interface:'cinematic'}}),undefined)
  assert.equal(storage.get('xiaoli:interface-mode'),'classic')
  assert.equal(loadMiddleware(storage)({path:'/',query:{}},{query:{}}).target.query.interface,'classic')
  assert.equal(loadMiddleware(storage)({...to,query:{interface:'cinematic'}},{query:{interface:'classic'}}),undefined)
  assert.equal(storage.get('xiaoli:interface-mode'),'cinematic')
  assert.equal(loadMiddleware(storage)({path:'/assets',query:{}},{query:{}}).target.query.interface,'cinematic')
})

test('invalid preferences and unavailable storage keep default and switching usable', () => {
  const invalid = new Map([['xiaoli:interface-mode','unknown']])
  assert.equal(loadMiddleware(invalid)({path:'/',query:{}},{query:{}}).target.query.interface,'cinematic')
  const route=loadMiddleware(new Map(),true)
  assert.equal(route({path:'/',query:{}},{query:{}}).target.query.interface,'cinematic')
  assert.equal(route({path:'/',query:{interface:'classic'}},{query:{}}),undefined)
  assert.equal(route({path:'/assets',query:{}},{query:{interface:'classic'}}).target.query.interface,'classic')
})

test('old preview bookmarks migrate to the formal interface URL without losing context', () => {
  const storage = new Map()
  const route = loadMiddleware(storage)
  const result = route({path:'/drama/42/episode/3',query:{preview:'classic',tab:'assets'},hash:'#shot-2'},{query:{}})
  assert.equal(result.target.query.interface,'classic')
  assert.equal(result.target.query.preview,undefined)
  assert.equal(result.target.query.tab,'assets')
  assert.equal(result.target.hash,'#shot-2')
  assert.equal(storage.get('xiaoli:interface-mode'),'classic')
  const override = route({path:'/',query:{interface:'cinematic',preview:'classic'}},{query:{}})
  assert.equal(override.target.query.interface,'cinematic')
  assert.equal(override.target.query.preview,undefined)
})

test('preview links retain existing query/hash and opt-in reacts without changing classic routes', () => {
  const route = vue.reactive({ query: {} }), exports = {}
  const code = ts.transpileModule(read('composables/useStudioInterface.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(code, { exports, URL, computed: vue.computed, useRoute: () => route })
  const model = exports.useStudioInterface()
  assert.equal(model.isCinematic.value, false)
  assert.equal(model.interfaceLink('/settings?tab=storage#usage'), '/settings?tab=storage&interface=cinematic#usage')
  route.query.interface = 'cinematic'
  assert.equal(model.isCinematic.value, true)
  route.query.interface = 'classic'
  assert.equal(model.isCinematic.value, false)
})

test('async real projects become selected; a real card never acquires a demo video or fake project', async () => {
  const calls = []
  const component = setupComponent('components/CinematicProjectGallery.vue', { projects: [], loading: true }, {
    imports: { '/studio/ribbon.js': { createRibbonV2: (_stage, options) => {
      calls.push(['init', options.initialId])
      return { setItems(items) { calls.push(['items', items.length]) }, select(id) { calls.push(['select', id]) }, setPaused() {}, destroy() {} }
    } } },
  })
  component.model.stage.value = { closest: () => ({}) }
  await component.mount()
  component.model.openSelected()
  assert.equal(component.emitted.length, 0)
  component.props.projects = [{ id: 42, title: '真实项目', episodes: [{ id: 7 }], characters: [{ id: 4, image_url: 'static/uploads/actual.png' }], scenes: [] }]
  component.props.loading = false
  await vue.nextTick()
  assert.equal(component.model.selected.value.id, 'project-42-characters-4')
  assert.equal(component.model.selected.value.project.id, 42)
  assert.equal(component.model.selected.value.poster, '/static/uploads/actual.png')
  assert.equal(component.model.selected.value.video, '')
  component.model.openSelected()
  assert.equal(component.emitted.at(-1)[0], 'open')
  assert.equal(component.emitted.at(-1)[1].id, 42)
  assert.equal(component.model.items.value.length, 1)
  component.props.projects = []
  await vue.nextTick()
  assert.equal(component.model.selected.value.project, null)
  component.model.openSelected()
  assert.equal(component.emitted.at(-1)[0], 'create')
  assert.ok(calls.some(([kind, id]) => kind === 'select' && id === 'project-42-characters-4'))
  component.destroy()
})

test('screening uses actual same-origin media and leaves empty projects empty', () => {
  const component = setupComponent('components/CinematicScreening.vue', {
    storyboards: [], characters: [], scenes: [], assets: [], merges: [], ratio: '16:9',
  }, { globals: { window: { location: { origin: 'http://studio.test' } } } })
  assert.equal(component.model.readyShots.value.length, 0)
  assert.equal(component.model.canScreen.value, false)
  component.props.scenes = [{ id: 9, image_url: 'static/images/scene.png' }]
  component.props.storyboards = [
    { id: 2, storyboard_number: 2, video_url: 'static/videos/two.mp4', duration: 260 },
    { id: 1, storyboard_number: 1, scene_id: 9, duration: 6 },
    { id: 3, storyboard_number: 3, duration: 5 },
    { id: 4, storyboard_number: 4, video_url: 'https://remote.invalid/not-downloaded.mp4' },
  ]
  assert.equal(component.model.readyShots.value.length, 2)
  assert.deepEqual([...component.model.readyShots.value.map(shot => shot.id)], [1, 2])
  assert.equal(component.model.readyShots.value[0].poster, 'http://studio.test/static/images/scene.png')
  assert.equal(component.model.readyShots.value[0].video, '')
  assert.equal(component.model.readyShots.value[1].video, 'http://studio.test/static/videos/two.mp4')
  assert.equal(component.model.readyShots.value[1].duration, 260)
  assert.match(component.model.readyShots.value[1].poster, /\/api\/v1\/storyboards\/2\/poster\?v=/)
  assert.equal(component.model.canScreen.value, true)
  component.destroy()
})

test('single-shot screening overrides the selected merge and closes back into the workspace', async () => {
  const events = [], opens = []
  let cinemaOptions
  const component = setupComponent('components/CinematicScreening.vue', {
    title: '真实项目', episodeTitle: '真实分集', episodeNumber: 3, selectedId: 12,
    storyboards: [
      { id: 11, storyboard_number: 1, video_url: '/static/videos/one.mp4', duration: 6 },
      { id: 12, storyboard_number: 2, video_url: '/static/videos/two.mp4', duration: 5 },
    ],
    characters: [], scenes: [], assets: [], ratio: '16:9',
    merges: [{ id: 99, status: 'completed', merged_url: '/static/videos/merged.mp4', duration: 11 }],
  }, {
    globals: {
      window: { location: { origin: 'http://studio.test' }, dispatchEvent: event => events.push(event) },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    },
    imports: { '/studio/cinema.js': { createCinema(options) {
      cinemaOptions = options
      return { open: options => opens.push(options), destroy() {} }
    } } },
  })
  component.model.source.value = 'merge:99'
  assert.equal(component.model.selectedMerge.value.id, 99)
  // The episode's single-shot entry explicitly clears the bar's selected merge.
  await component.model.open({ merge: null, fromStart: false })
  assert.equal(component.model.error.value, '')
  const snapshot = cinemaOptions.getSnapshot()
  assert.deepEqual([...snapshot.shots.map(shot => shot.id)], [11, 12])
  assert.equal(snapshot.selectedId, 12)
  assert.equal(snapshot.title, '真实项目')
  assert.equal(snapshot.shots[1].video, 'http://studio.test/static/videos/two.mp4')
  assert.equal(snapshot.strictMedia, true)
  assert.equal(snapshot.mediaAudio, true)
  assert.equal(opens.length, 1)
  assert.equal(opens[0].fromStart, false)
  assert.equal(component.emitted.at(-1)[0], 'opened')
  assert.equal(events.at(-1).type, 'cinematic-screening-change')
  assert.equal(events.at(-1).detail.open, true)
  cinemaOptions.onClose()
  assert.equal(component.emitted.at(-1)[0], 'closed')
  assert.equal(events.at(-1).detail.open, false)
  component.destroy()
})

test('all settings query tabs work, storage loads on first open, mounting only calls reads', async () => {
  const calls = []
  const apiGroup = name => new Proxy({}, { get(_object, method) {
    return async () => {
      calls.push([name, method])
      if (!['list', 'get', 'info'].includes(method)) throw new Error(`Unexpected write/generation ${name}.${String(method)}`)
      if (name === 'storageAPI') return { mode: 'server', usage: { total: 1 }, usageStale: false }
      if (name === 'promptAPI' && method === 'get') return { name: '测试提示', system_prompt: '', model: '', is_default: true }
      return []
    }
  } })
  const imports = {
    '~/components/BaseSelect.vue': {}, 'vue-sonner': { toast: { success() {} } },
    '~/composables/useToast': { toastError(error) { throw error } }, 'vue-i18n': { useI18n: () => ({ t: key => key }) },
    '~/composables/useApi': Object.fromEntries(['aiConfigAPI', 'promptAPI', 'skillsAPI', 'storageAPI', 'stylePresetAPI'].map(name => [name, apiGroup(name)])),
    '~/composables/useDesktopBridge': { useDesktopBridge: () => null }, '~/composables/useMigrateState': { useMigrateState: () => ({}) },
    '~/composables/useTheme': { useTheme: () => ({ themeMode: vue.ref('dark'), setThemeMode() {} }) },
    '~/composables/useProviderIcon': { providerIconUrl: () => '' }, '~/composables/useTour': { startTour() {}, autoTour() {} },
  }
  for (const tab of ['ai', 'calls', 'general', 'styles', 'agents', 'storage']) {
    const component = setupComponent('components/SettingsContent.vue', { embedded: true }, { imports, route: { query: { tab } } })
    assert.equal(component.model.tab.value, tab)
    if (tab === 'storage') {
      await flushComponent()
      assert.equal(component.model.storageInfo.value.mode, 'server')
    }
    component.destroy()
  }
  const component = setupComponent('components/SettingsContent.vue', { embedded: true }, { imports, route: { query: { tab: 'storage' } } })
  await component.mount()
  assert.equal(component.model.storageInfo.value.usage.total, 1)
  assert.ok(calls.some(([name, method]) => name === 'storageAPI' && method === 'info'))
  assert.ok(calls.every(([, method]) => ['list', 'get', 'info'].includes(method)))
  component.destroy()
})

test('cinematic SFCs and their shared home template compile', () => {
  for (const path of ['app.vue', 'pages/index.vue', 'layouts/cinematic.vue', 'components/CinematicProjectGallery.vue', 'components/CinematicScreening.vue', 'components/SettingsContent.vue']) {
    const { descriptor, errors } = parse(read(path), { filename: path })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: path })
    const template = compileTemplate({ source: descriptor.template.content, filename: path, id: path, compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [], path)
  }
})
