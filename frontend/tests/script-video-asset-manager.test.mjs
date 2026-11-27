import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import ts from 'typescript'
import { thumbOf } from '../app/composables/useMedia.ts'

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

test('资产缩略图加载失败时只尝试一次原图，换图后重置预览', (t) => {
  const filename = 'ScriptVideoPreviewAssetImage.vue'
  const source = readFileSync(new URL(`../app/components/${filename}`, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: filename, inlineTemplate: true })
  const { outputText } = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const exported = {}
  runInNewContext(outputText, { exports: exported, require: name => {
    if (name === 'vue') return vue
    if (name === 'lucide-vue-next') return { Headphones: () => null }
    assert.equal(name, '~/composables/useMedia')
    return { thumbOf }
  }, computed: vue.computed, ref: vue.ref, watch: vue.watch })

  const asset = vue.reactive({ image: '/static/uploads/旧图.png', name: '旧场景', kind: 'scene' })
  const scope = vue.effectScope()
  t.after(() => scope.stop())
  const draw = scope.run(() => exported.default.setup({ asset }, { expose() {} }))
  const render = () => draw({}, [])
  const fail = node => node.props.onError({ currentTarget: { getAttribute: () => node.props.src } })

  assert.equal(render().props.src, thumbOf(asset.image))
  fail(render())
  assert.equal(render().props.src, asset.image)
  fail(render())
  assert.equal(render().children, '图片暂不可用')

  asset.image = '/static/uploads/新图.png'
  assert.equal(render().props.src, thumbOf(asset.image))
  asset.image = 'https://example.test/scene.png'
  assert.equal(render().props.src, asset.image)
  fail(render())
  assert.equal(render().children, '图片暂不可用')
})

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
  assets.value = [{ ...assets.value[0], imageStatus: 'delivery_pending', imageTaskId: 63 }]
  assert.deepEqual(targetIds(), [])
  assets.value = [{ ...assets.value[0], imageStatus: 'failed' }]
  assert.deepEqual(targetIds(), ['gate'])
  replacingImages.value.add('gate')
  assert.deepEqual(targetIds(), [])
  replacingImages.value.delete('gate')
  assert.deepEqual(targetIds(), ['gate'])
})

test('旧导入图片资产始终有生图入口，音频不显示该按钮', () => {
  const assetManager = section('<div class="vp-asset-edit-grid">', '<div class="vp-binding-grid">')
  const button = assetManager.match(/<button\b[^>]*@click="requestAssetImageGeneration\(asset, \$event\)"[^>]*>[\s\S]*?<\/button>/u)?.[0]
  assert.ok(button, '资产卡片有生图按钮')
  assert.match(button, /v-if="asset\.kind !== 'audio'"/u)
  assert.match(button, /重新生成图片/u)
  assert.match(button, /生成图片/u)
  assert.match(assetManager, /v-model="asset\.imagePrompt"/u)
})

test('旧资产点击生图先打开并聚焦提示词，不改动资产；已有提示词时才提交生成', async () => {
  const generationController = ts.transpileModule(
    section('async function requestAssetImageGeneration(', 'async function generateAssetImages('),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText
  const editingAssetImagePromptId = ref('')
  const submitted = []
  let focused = 0
  const button = { closest(selector) {
    assert.equal(selector, '.vp-asset-edit-row')
    return { querySelector(query) {
      assert.equal(query, '.vp-asset-image-prompt textarea')
      return { focus: () => focused++ }
    } }
  } }
  const request = runInNewContext(generationController + '\nrequestAssetImageGeneration', {
    editingAssetImagePromptId, nextTick: vue.nextTick,
    generateAssetImages: assets => submitted.push(...assets),
  })
  const imported = { id: 'old', kind: 'character', name: '旧素材', image: '/static/uploads/old.png' }
  const original = { ...imported }
  await request(imported, { currentTarget: button })
  assert.equal(editingAssetImagePromptId.value, 'old')
  assert.equal(focused, 1)
  assert.deepEqual(imported, original)
  assert.deepEqual(submitted, [])

  imported.imagePrompt = '深蓝服装的角色'
  await request(imported, { currentTarget: button })
  assert.deepEqual(submitted, [imported])
  assert.equal(focused, 1)
})

test('只有场景卡片有 MJ 出图，保存提示词后直接提交 MJ 请求', async () => {
  const actions = section('<div class="vp-asset-edit-actions">', '<label v-if="asset.kind === \'audio\'" class="btn btn-sm vp-asset-replace">')
  assert.match(actions, /requestAssetImageGeneration\(asset, \$event\)"[\s\S]*?<\/button>\s*<button\s+v-if="asset\.kind === 'scene'"[\s\S]*?@click="requestAssetImageGeneration\(asset, \$event, 'midjourney'\)"[\s\S]*?MJ 出图/u)
  const generationController = ts.transpileModule(
    section('function assetImageRunning(', 'async function savePreviewConfig('),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText
  const submissions = new Set()
  const calls = []
  const request = runInNewContext(generationController + '\nrequestAssetImageGeneration', {
    currentProject: ref({ id: 'project' }),
    assetImageModels: ref([{ key: 'other', configId: 7, model: 'other-image-model' }]),
    assetImageModelKey: ref('other'),
    assetImageSubmissions: submissions,
    selectedAssetImages: ref(new Set()),
    replacingImages: ref(new Set()),
    requireSharedProjectEdit: () => true,
    async saveProjectNow(projectId) { calls.push(['save', projectId]) },
    async scriptVideoRequest(path, method, payload) {
      assert.ok(submissions.has('project/gate'))
      calls.push([method, path, JSON.parse(JSON.stringify(payload))])
      return { started: ['gate'] }
    },
    async refreshProject() {},
    requestActivityRefresh: undefined,
    alive: true,
    toast: { success() {} },
  })
  const scene = { id: 'gate', kind: 'scene', imagePrompt: '北城门' }
  await request(scene, {}, 'midjourney')
  await request(scene, {})
  assert.deepEqual(calls, [
    ['save', 'project'],
    ['POST', '/projects/project/assets/generate', { assetIds: ['gate'], mode: 'midjourney' }],
    ['save', 'project'],
    ['POST', '/projects/project/assets/generate', { assetIds: ['gate'], configId: 7, model: 'other-image-model' }],
  ])
  assert.equal(submissions.size, 0)
})

test('待取回的场景显示重试入口，点击只请求取回原图', async () => {
  const assetManager = section('<div class="vp-asset-edit-grid">', '<div class="vp-binding-grid">')
  assert.match(assetManager, /v-if="canRetryAssetImageDelivery\(asset\)"[\s\S]*?@click="retryAssetImageDelivery\(asset\)"[\s\S]*?重试取图/u)
  assert.match(assetManager, /asset\.imageError && \(asset\.imageStatus === 'failed' \|\| asset\.imageStatus === 'delivery_pending'\)/u)
  const recoveryController = ts.transpileModule([
    section('function assetImageRunning(', 'async function requestAssetImageGeneration('),
    section('async function retryAssetImageDelivery(', 'async function savePreviewConfig('),
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  const asset = { kind: 'scene', id: 'gate', imageStatus: 'delivery_pending', imageTaskId: 63 }
  const submissions = new Set()
  const calls = []
  const { retryAssetImageDelivery, assetImageStatusLabel, canRetryAssetImageDelivery } = runInNewContext(
    recoveryController + '\n;({ retryAssetImageDelivery, assetImageStatusLabel, canRetryAssetImageDelivery })', {
      currentProject: ref({ id: 'project' }),
      assetImageSubmissions: submissions,
      selectedAssetImages: ref(new Set(['gate'])),
      replacingImages: ref(new Set()),
      requireSharedProjectEdit: () => true,
      async scriptVideoRequest(path, method) {
        assert.ok(submissions.has('project/gate'))
        calls.push([method, path])
        return { taskId: 63 }
      },
      async refreshProject(projectId) { calls.push(['refresh', projectId]) },
      requestActivityRefresh: () => calls.push(['activity']),
      toast: { success() {} },
      alive: true,
    },
  )
  assert.equal(assetImageStatusLabel(asset), '已生成，待取回')
  assert.equal(canRetryAssetImageDelivery({ ...asset, imageTaskId: undefined }), false)
  await retryAssetImageDelivery({ ...asset, imageStatus: 'failed' })
  assert.deepEqual(calls, [])
  const pending = retryAssetImageDelivery(asset)
  assert.equal(assetImageStatusLabel(asset), '正在取回')
  await retryAssetImageDelivery(asset)
  await pending
  assert.deepEqual(calls, [['POST', '/projects/project/assets/gate/recover-image'], ['refresh', 'project'], ['activity']])
  assert.equal(submissions.size, 0)
})

const deletionController = ts.transpileModule([
  section('function releaseAssetImage(', 'function saveAudioEdit('),
  section('const assetDeleteDialog =', 'const sharedActivity ='),
].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function deletionManager(initialAssets, afterSave = () => {}) {
  const project = { id: 'project', assets: initialAssets }
  const currentProject = ref(project)
  const assets = computed(() => currentProject.value.assets)
  const selectedAssetImages = ref(new Set())
  const saves = [], errors = [], successes = [], released = []
  const confirmation = {
    open: false,
    isConnected: true,
    showModal() { this.open = true },
    close() { this.open = false },
  }
  const state = runInNewContext(controller + '\n' + deletionController + `\n;({
    assetManageSearch, assetManageKind, managedAssets, assetDeleteDialog, deletingAssets,
    requestAllAssetDeletion, confirmAssetDeletion,
  })`, {
    computed, ref, assets, currentProject, selectedAssetImages, Error,
    useId: () => 'confirmation', nextTick: vue.nextTick,
    alive: true, episodeOpen: ref(true), requireSharedProjectEdit: () => true,
    URL: { revokeObjectURL: url => released.push(url) },
    saveProjectNow: async id => {
      saves.push({ id, count: project.assets.length })
      await afterSave(saves.length, currentProject)
    },
    toast: { error: message => errors.push(message), success: message => successes.push(message) },
  })
  state.assetDeleteDialog.value = confirmation
  return { ...state, project, currentProject, assets, selectedAssetImages, confirmation, saves, errors, successes, released }
}

test('删除全部按确认时的项目范围覆盖所有分类，保留之后新增的资产及其批量选择', async () => {
  const assets = [
    { id: 'guard', kind: 'character', name: '守卫', image: 'blob:guard' },
    { id: 'gate', kind: 'scene', name: '北城门', image: '/static/gate.png' },
    { id: 'cup', kind: 'prop', name: '毒酒碗', image: '/static/cup.png' },
    { id: 'beast', kind: 'creature', name: '妖兽', image: '/static/beast.png' },
    { id: 'voice', kind: 'audio', name: '旁白', image: '' },
  ]
  const app = deletionManager(assets)
  app.assetManageKind.value = 'scene'
  app.assetManageSearch.value = '北城门'
  assert.deepEqual(visibleIds(app), ['gate'])
  app.selectedAssetImages.value.add('guard').add('beast')

  await app.requestAllAssetDeletion()
  assert.equal(app.confirmation.open, true)
  assert.equal(app.assets.value.length, 5)
  assert.deepEqual(app.saves, [])

  const added = { id: 'new', kind: 'scene', name: '城外', image: '/static/new.png' }
  app.assets.value.push(added)
  app.selectedAssetImages.value.add(added.id)
  await app.confirmAssetDeletion()

  assert.equal(app.confirmation.open, false)
  assert.deepEqual(app.assets.value.map(asset => asset.id), ['new'])
  assert.deepEqual([...app.selectedAssetImages.value], ['new'])
  assert.deepEqual(app.released, ['blob:guard'])
  assert.deepEqual(app.saves, [{ id: 'project', count: 1 }])
  assert.deepEqual(app.successes, ['已从项目资产移除 5 项资产'])
  assert.deepEqual(app.errors, [])
})

function generatedAssetList(length) {
  return Array.from({ length }, (_, index) => ({ id: `asset-${index}`, kind: 'prop', name: `道具 ${index}`, image: '' }))
}

test('删除超过同步单次改动上限的资产时，按批保存直至清空', async () => {
  const app = deletionManager(generatedAssetList(10_001))
  await app.requestAllAssetDeletion()
  await app.confirmAssetDeletion()

  assert.deepEqual(app.saves.map(save => save.count), [9_001, 8_001, 7_001, 6_001, 5_001, 4_001, 3_001, 2_001, 1_001, 1, 0])
  assert.equal(app.assets.value.length, 0)
  assert.equal(app.deletingAssets.value, false)
  assert.deepEqual(app.successes, ['已从项目资产移除 10001 项资产'])
  assert.deepEqual(app.errors, [])
})

test('批量删除第二次同步失败时停止，保留尚未处理的资产与选择', async () => {
  const app = deletionManager(generatedAssetList(2_003), saveNumber => {
    if (saveNumber === 2) throw new Error('网络断开')
  })
  app.selectedAssetImages.value.add('asset-1200').add('asset-2002')
  await app.requestAllAssetDeletion()
  await app.confirmAssetDeletion()

  assert.deepEqual(app.saves.map(save => save.count), [1_003, 3])
  assert.deepEqual(app.assets.value.map(asset => asset.id), ['asset-2000', 'asset-2001', 'asset-2002'])
  assert.deepEqual([...app.selectedAssetImages.value], ['asset-2002'])
  assert.equal(app.deletingAssets.value, false)
  assert.deepEqual(app.successes, [])
  assert.deepEqual(app.errors, ['删除未全部完成。网络断开'])
})

test('批次之间切换项目时停止删除，保留原项目的剩余资产', async () => {
  const other = { id: 'other', assets: generatedAssetList(3) }
  const app = deletionManager(generatedAssetList(1_001), (_, project) => { project.value = other })
  await app.requestAllAssetDeletion()
  await app.confirmAssetDeletion()

  assert.deepEqual(app.saves, [{ id: 'project', count: 1 }])
  assert.deepEqual(app.project.assets.map(asset => asset.id), ['asset-1000'])
  assert.equal(other.assets.length, 3)
  assert.equal(app.deletingAssets.value, false)
  assert.deepEqual(app.successes, [])
  assert.deepEqual(app.errors, ['删除未全部完成。项目已切换，请重新确认剩余资产'])
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
