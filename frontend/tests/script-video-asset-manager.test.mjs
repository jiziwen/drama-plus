import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import ts from 'typescript'

const { computed, ref } = vue
const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `Asset manager section exists: ${startMarker}`)
  return source.slice(start, end)
}
const controller = ts.transpileModule([
  section('const assetManageSearch =', 'const validation ='),
  section('const assetKinds =', 'const kindLabel ='),
  section('function editAsset(', 'function requireSharedProjectEdit('),
].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function manager() {
  const assets = ref([
    { id: 'guard', kind: 'character', name: 'Gatekeeper', sourcePath: 'Characters/守卫.png' },
    { id: 'hero', kind: 'character', name: '顾凌天', sourcePath: '角色/顾凌天_黑衣.png' },
    { id: 'gate', kind: 'scene', name: '北城门', sourcePath: 'Scenes/Gate.png' },
    { id: 'cup', kind: 'prop', name: '毒酒碗' },
    { id: 'beast', kind: 'creature', name: '妖兽', sourcePath: '生物/妖兽.png' },
  ])
  const dialog = ref(null)
  const editingAssetId = ref('')
  const state = runInNewContext(controller + '\n;({ assetManageSearch, assetManageKind, managedAssets, assetManageTabs, onAssetManageTabKeydown, editAsset })', {
    computed, ref, assets, dialog, editingAssetId,
  })
  return { ...state, assets, dialog, editingAssetId }
}

const visibleIds = manager => Array.from(manager.managedAssets.value, asset => asset.id)
const tabCounts = manager => Object.fromEntries(Array.from(manager.assetManageTabs.value, tab => [tab.value, tab.count]))

test('分类与名称、目录搜索同时生效，搜索忽略大小写且允许没有目录的资产', () => {
  const app = manager()
  app.assetManageSearch.value = 'GATE'
  assert.deepEqual(visibleIds(app), ['guard', 'gate'])
  app.assetManageKind.value = 'scene'
  assert.deepEqual(visibleIds(app), ['gate'])
  app.assetManageKind.value = 'character'
  assert.deepEqual(visibleIds(app), ['guard'])
  app.assetManageSearch.value = '黑衣'
  assert.deepEqual(visibleIds(app), ['hero'])
  app.assetManageKind.value = 'prop'
  assert.deepEqual(visibleIds(app), [])
  app.assetManageSearch.value = '毒酒'
  assert.deepEqual(visibleIds(app), ['cup'])
  app.assetManageSearch.value = ''
  app.assetManageKind.value = 'all'
  assert.equal(app.managedAssets.value.length, 5)
})

test('Tab 数量不受搜索限制，修改资产类型、导入和删除后实时更新', () => {
  const app = manager()
  const initial = { all: 5, character: 2, scene: 1, prop: 1, creature: 1, audio: 0 }
  assert.deepEqual(tabCounts(app), initial)
  app.assetManageSearch.value = '没有匹配的名称'
  app.assetManageKind.value = 'character'
  assert.deepEqual(visibleIds(app), [])
  assert.deepEqual(tabCounts(app), initial)
  app.assets.value[0].kind = 'scene'
  assert.deepEqual(tabCounts(app), { ...initial, character: 1, scene: 2 })
  app.assets.value.push({ id: 'hall', kind: 'scene', name: '大堂' })
  assert.deepEqual(tabCounts(app), { ...initial, all: 6, character: 1, scene: 3 })
  app.assets.value.splice(3, 1)
  assert.deepEqual(tabCounts(app), { ...initial, character: 1, scene: 3, prop: 0 })
})

test('分类 Tab 支持左右循环及 Home、End，并把焦点移到新分类', () => {
  const app = manager()
  const focused = []
  let prevented = 0
  const tabs = Array.from({ length: 6 }, (_, index) => ({ focus: () => focused.push(index) }))
  const press = (key, index) => app.onAssetManageTabKeydown({
    key,
    preventDefault() { prevented++ },
    currentTarget: { parentElement: { querySelectorAll(selector) {
      assert.equal(selector, '[role="tab"]')
      return tabs
    } } },
  }, index)

  press('ArrowLeft', 0)
  assert.equal(app.assetManageKind.value, 'audio')
  press('ArrowRight', 5)
  assert.equal(app.assetManageKind.value, 'all')
  press('ArrowRight', 0)
  assert.equal(app.assetManageKind.value, 'character')
  press('End', 1)
  assert.equal(app.assetManageKind.value, 'audio')
  press('Home', 5)
  assert.equal(app.assetManageKind.value, 'all')
  assert.deepEqual(focused, [5, 0, 1, 5, 0])
  assert.equal(prevented, 5)

  press('Enter', 0)
  press('ArrowDown', 0)
  assert.equal(app.assetManageKind.value, 'all')
  assert.equal(prevented, 5)
  assert.deepEqual(focused, [5, 0, 1, 5, 0])
})

test('从引用打开编辑时清空旧搜索并切到目标分类，保证目标资产可见', () => {
  const app = manager()
  app.assetManageKind.value = 'creature'
  app.assetManageSearch.value = '没有匹配的名称'
  assert.deepEqual(visibleIds(app), [])
  app.editAsset('gate')
  assert.equal(app.dialog.value, 'assets')
  assert.equal(app.editingAssetId.value, 'gate')
  assert.equal(app.assetManageSearch.value, '')
  assert.equal(app.assetManageKind.value, 'scene')
  assert.deepEqual(visibleIds(app), ['gate'])

  app.assetManageSearch.value = '旧搜索'
  app.editAsset('removed')
  assert.equal(app.assetManageSearch.value, '')
  assert.equal(app.assetManageKind.value, 'all')
  assert.equal(app.managedAssets.value.length, 5)
})

test('资产弹框在已有生图提示词和后台更新出图状态时都能显示批量目标', () => {
  const imageGenerationController = ts.transpileModule([
    section('const selectedAssetImages =', 'const assetManageSearch ='),
    section('const replacingImages =', 'async function replaceAssetImage('),
    section('function assetImageRunning(', 'function assetImageStatusLabel('),
  ].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const assets = ref([{ id: 'gate', kind: 'scene', imagePrompt: '北城门' }])
  const { batchAssetImageTargets, replacingImages } = runInNewContext(
    imageGenerationController + '\n;({ batchAssetImageTargets, replacingImages })',
    { assets, currentProject: ref({ id: 'project' }), computed, ref, reactive: vue.reactive },
  )

  const targetIds = () => Array.from(batchAssetImageTargets.value, asset => asset.id)
  assert.deepEqual(targetIds(), ['gate'])
  assets.value = [{ ...assets.value[0], imageStatus: 'generating' }]
  assert.deepEqual(targetIds(), [])
  assets.value = [{ ...assets.value[0], imageStatus: 'failed' }]
  assert.deepEqual(targetIds(), ['gate'])
  replacingImages.value.add('gate')
  assert.deepEqual(targetIds(), [])
  replacingImages.value.delete('gate')
  assert.deepEqual(targetIds(), ['gate'])
})

test('资产名称保存保留 Unicode 原文，纯空输入回填原值，重名沿用编号', async () => {
  const renameController = ts.transpileModule([
    section('function uniqueName(', 'function validReferenceAudio('),
    section('function renameAsset(', 'const assetDeleteDialog'),
  ].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const assets = ref([
    { id: 'photo', kind: 'prop', name: '原图' },
    { id: 'voice', kind: 'audio', name: '原音频' },
    { id: 'duplicate', kind: 'character', name: '已有名字🎙' },
  ])
  const saved = [], errors = []
  const rename = runInNewContext(renameController + '\nrenameAsset', {
    assets, currentProject: ref({ id: 'project' }), requireSharedProjectEdit: () => true,
    saveProjectNow: async id => saved.push({ id, names: assets.value.map(asset => asset.name) }),
    toast: { error: message => errors.push(message) },
  })
  const image = assets.value[0], audio = assets.value[1]
  const imageName = ' 北门@场 [镜头🎬] e\u0301 '
  const audioName = '音频１@旁白[试音🎙] e\u0301'

  const retainedImageName = await rename(image, imageName)
  assert.equal(image.name, imageName)
  assert.equal(retainedImageName, imageName)
  assert.equal(image.originalName, '原图')
  assert.equal(await rename(audio, audioName), audioName)
  assert.equal(audio.name, audioName)
  assert.equal(await rename(audio, '　\t '), audioName)
  assert.equal(audio.originalName, '原音频')
  assert.equal(await rename(audio, '已有名字🎙'), '已有名字🎙-2')
  assert.equal(audio.name, '已有名字🎙-2')
  assert.deepEqual(saved, [
    { id: 'project', names: [imageName, '原音频', '已有名字🎙'] },
    { id: 'project', names: [imageName, audioName, '已有名字🎙'] },
    { id: 'project', names: [imageName, '已有名字🎙-2', '已有名字🎙'] },
  ])
  assert.deepEqual(errors, ['资产名称不能为空'])
})

test('编辑资产名称时保留斜杠和空格，后台刷新后仍可正常提交或回填', async (t) => {
  const filename = 'ScriptVideoAssetNameInput.vue'
  const source = readFileSync(new URL(`../app/components/${filename}`, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: filename, inlineTemplate: true })
  const { outputText } = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exported = {}
  runInNewContext(outputText, { exports: exported, require: name => {
    assert.equal(name, 'vue')
    return vue
  } })

  // Use Vue's own input directive and DOM property patcher without a browser dependency.
  class InputDocument { activeElement = null }
  const document = new InputDocument()
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'Document')
  Object.defineProperty(globalThis, 'Document', { configurable: true, value: InputDocument })
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'Document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'Document')
  })
  const host = {}
  const renderer = vue.createRenderer({
    createElement: tag => Object.assign(new EventTarget(), {
      tagName: tag.toUpperCase(), type: 'text', value: '', disabled: false,
      getRootNode: () => document,
      setAttribute() {}, removeAttribute() {},
    }),
    insert(node, parent) { parent.input = node },
    remove() {},
    parentNode: () => host,
    nextSibling: () => null,
    patchProp: vue.patchProp,
  })
  const name = ref('萧府-内堂')
  const refresh = ref(0)
  const edits = []
  const commit = draft => {
    edits.push(draft)
    if (draft.trim()) name.value = draft
    return name.value
  }
  const app = renderer.createApp({
    render: () => vue.h(exported.default, { name: name.value, disabled: false, commit, 'data-refresh': refresh.value }),
  })
  app.mount(host)
  t.after(() => app.unmount())
  const input = host.input
  function focus() {
    document.activeElement = input
    input.dispatchEvent(new Event('focus'))
  }
  function change(value) {
    input.value = value
    input.dispatchEvent(new Event('input'))
  }
  function blur() {
    document.activeElement = null
    input.dispatchEvent(new Event('blur'))
  }

  assert.equal(input.value, '萧府-内堂')
  focus()
  change(' 萧府-内堂/夜 ')
  refresh.value++
  await vue.nextTick()
  assert.equal(input.value, ' 萧府-内堂/夜 ')
  name.value = '后台更新的名称'
  await vue.nextTick()
  assert.equal(input.value, ' 萧府-内堂/夜 ')
  assert.deepEqual(edits, [])
  blur()
  await vue.nextTick()
  assert.equal(name.value, ' 萧府-内堂/夜 ')
  assert.equal(input.value, name.value)

  focus()
  change('　 ')
  blur()
  await vue.nextTick()
  assert.equal(input.value, name.value)
  assert.deepEqual(edits, [' 萧府-内堂/夜 ', '　 '])
  name.value = '新场景/白天'
  await vue.nextTick()
  assert.equal(input.value, name.value)
})

for (const [kind, file, name, url] of [
  ['image', {name: '自定义城门.png', type: 'image/png', size: 100}, '自定义城门', '/static/uploads/custom.png'],
  ['audio', {name: '音频１.wav', type: 'audio/wav', size: 100}, '素材-音频１', '/static/uploads/custom.wav'],
]) test(`从提示词上传 ${kind} 时，即使切换片段，素材也只关联发起上传的片段`, async () => {
  const first = { id: 'first', assetIds: ['existing'], prompt: '拍摄城门。', version: 2 }
  const second = { id: 'second', assetIds: [], prompt: '人物走入画面。', version: 1 }
  const episode = { id: 'episode', cards: [first, second] }
  const project = { id: 'project', assets: [], episodes: [episode] }
  const currentEpisode = ref(episode)
  const selectedCard = ref(first)
  let finishUpload
  const pending = new Promise(resolve => { finishUpload = resolve })
  const saved = []
  const uploadController = ts.transpileModule([
    section('function updateCard(', 'function openBindingDialog('),
    section('function uniqueName(', 'async function importAssetFiles('),
  ].join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const upload = runInNewContext(uploadController + '\nuploadPromptMedia', {
    ref, alive: true, currentEpisode, selectedCard, currentProject: ref(project), projects: ref([project]),
    stage: ref('production'), requireSharedProjectEdit: () => true,
    uploadAPI: { [kind]: () => pending }, previewId: () => 'new-asset',
    saveProjectNow: async id => saved.push(id),
    toast: { success() {}, error: assert.fail },
  })

  const result = upload(file, kind)
  selectedCard.value = second
  finishUpload({ url })
  await result

  assert.equal(project.assets[0].name, name)
  assert.equal(project.assets[0].kind, kind === 'audio' ? 'audio' : 'prop')
  assert.equal(kind === 'audio' ? project.assets[0].voiceAudio.url : project.assets[0].image, url)
  assert.deepEqual(Array.from(episode.cards[0].assetIds), ['existing', 'new-asset'])
  assert.equal(episode.cards[0].prompt, first.prompt)
  assert.deepEqual(episode.cards[1].assetIds, [])
  assert.deepEqual(saved, [project.id])
})
