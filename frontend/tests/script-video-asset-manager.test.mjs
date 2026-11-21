import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { computed, ref } from 'vue'
import ts from 'typescript'

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
  const initial = { all: 5, character: 2, scene: 1, prop: 1, creature: 1 }
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
  assert.deepEqual(tabCounts(app), { all: 5, character: 1, scene: 3, prop: 0, creature: 1 })
})

test('分类 Tab 支持左右循环及 Home、End，并把焦点移到新分类', () => {
  const app = manager()
  const focused = []
  let prevented = 0
  const tabs = Array.from({ length: 5 }, (_, index) => ({ focus: () => focused.push(index) }))
  const press = (key, index) => app.onAssetManageTabKeydown({
    key,
    preventDefault() { prevented++ },
    currentTarget: { parentElement: { querySelectorAll(selector) {
      assert.equal(selector, '[role="tab"]')
      return tabs
    } } },
  }, index)

  press('ArrowLeft', 0)
  assert.equal(app.assetManageKind.value, 'creature')
  press('ArrowRight', 4)
  assert.equal(app.assetManageKind.value, 'all')
  press('ArrowRight', 0)
  assert.equal(app.assetManageKind.value, 'character')
  press('End', 1)
  assert.equal(app.assetManageKind.value, 'creature')
  press('Home', 4)
  assert.equal(app.assetManageKind.value, 'all')
  assert.deepEqual(focused, [4, 0, 1, 4, 0])
  assert.equal(prevented, 5)

  press('Enter', 0)
  press('ArrowDown', 0)
  assert.equal(app.assetManageKind.value, 'all')
  assert.equal(prevented, 5)
  assert.deepEqual(focused, [4, 0, 1, 4, 0])
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

test('从提示词上传时，即使切换片段，图片也只关联发起上传的片段', async () => {
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
  const upload = runInNewContext(uploadController + '\nuploadPromptImage', {
    ref, alive: true, currentEpisode, selectedCard, currentProject: ref(project), projects: ref([project]),
    stage: ref('production'), requireSharedProjectEdit: () => true,
    uploadAPI: { image: () => pending }, previewId: () => 'new-image',
    saveProjectNow: async id => saved.push(id),
    toast: { success() {}, error: assert.fail },
  })

  const result = upload({ name: '自定义城门.png', type: 'image/png', size: 100 })
  selectedCard.value = second
  finishUpload({ url: '/static/uploads/custom.png' })
  await result

  assert.equal(project.assets[0].name, '自定义城门')
  assert.deepEqual(Array.from(episode.cards[0].assetIds), ['existing', 'new-image'])
  assert.equal(episode.cards[0].prompt, first.prompt)
  assert.deepEqual(episode.cards[1].assetIds, [])
  assert.deepEqual(saved, [project.id])
})
