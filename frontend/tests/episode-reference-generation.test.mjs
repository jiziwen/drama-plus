import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { assetModelOptions, assetModelKey, assetModelPatch, resolveAssetModel, assetReferences } from '../app/composables/useAssetGeneration.ts'

const source = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
function section(start, end) {
  const offset = source.indexOf(start)
  assert.notEqual(offset, -1, `missing function boundary: ${start}`)
  const limit = source.indexOf(end, offset)
  assert.notEqual(limit, -1, `missing function boundary: ${end}`)
  return source.slice(offset, limit)
}
const plain = value => JSON.parse(JSON.stringify(value))

function setup(kind = 'character') {
  const requests = [], updates = [], errors = [], promptCalls = [], pollChecks = [], timers = [], stops = []
  const item = { id: 1, name: 'hero', appearance: 'original face', styling: 'original clothes',
    prompt: 'original scene', description: 'original object', final_prompt: '',
    image_url: 'static/current.png', image_model: 'wf-z-image', image_config_id: 10,
    reference_model: 'wf-qwen-image', reference_config_id: 11,
    reference_images: [], edit_prompt: '',
  }
  const configs = [
    { id: 10, provider: 'comfyui', is_active: true, model: ['wf-z-image'] },
    { id: 11, provider: 'comfyui', is_active: true, model: ['wf-qwen-image'] },
    { id: 12, provider: 'openai', is_active: true, model: ['gpt-image-2'] },
  ]
  const records = ref([item])
  let taskResults = { tasks: [], merges: [] }, queryError = null
  let updateHandler = async () => {}
  const ctx = {
    ref, reactive, computed, nextTick, assetModelOptions, assetModelKey, assetModelPatch, resolveAssetModel, assetReferences,
    watch: (...args) => { const stop = watch(...args); stops.push(stop); return stop },
    assetDetail: ref({ open: false, type: '', item: null }),
    assetDetailDraft: ref({}), assetPromptDraft: ref(''), assetPromptDirty: ref(false), savingAssetDetail: ref(false),
    assetGenerationMode: ref('text'), assetGenerationModels: ref({ text: '', reference: '' }),
    assetTextReferenceDraft: ref([]), assetReferenceDraft: ref([]), assetEditDraft: ref(''), assetReferenceHistory: ref([]),
    assetReferenceUploading: ref(false), assetDialogElement: ref(null),
    imageConfigs: ref(configs), imageModel: ref('openai/gpt-image-2'),
    imageModelOptions: ref([{ key: 'openai/gpt-image-2', model: 'gpt-image-2', configId: 12 }]),
    chars: records, visualChars: records, scenes: records, propItems: records,
    pendingCharImageIds: ref([]), pendingSceneImageIds: ref([]), pendingPropImageIds: ref([]),
    pendingVideoIds: ref([]), failedVideoMessages: ref({}), sbs: ref([]),
    genTasks: ref([]), genMerges: ref([]), submittedImageTaskIds: reactive(new Set()), notifiedImageFailureIds: new Set(),
    dramaId: 1, epId: ref(1), document: { activeElement: null },
    t: value => value, toast: { info() {}, success() {}, error: value => errors.push(value) }, toastError: error => errors.push(error?.message || error),
    chatModelOverride: () => 'text-model', chatConfigId: () => 99,
    ensureAssetPrompt: async (...args) => { promptCalls.push(args) },
    refresh: async () => {}, watchAsyncResult: check => pollChecks.push(check),
    taskAPI: {
      list: async () => [],
      listByEpisode: async () => { if (queryError) throw queryError; return taskResults },
    },
    hasVid: () => false,
    setInterval: callback => { const timer = { callback, cleared: false }; timers.push(timer); return timer },
    clearInterval: timer => { timer.cleared = true },
  }
  for (const type of ['character', 'scene', 'prop']) {
    ctx[`${type}API`] = {
      update: async (id, payload) => { updates.push({ type, id, payload: plain(payload) }); await updateHandler() },
      generateImage: async (...args) => { requests.push({ type, args: plain(args) }); return { image_generation_id: 42 } },
    }
  }
  ctx.isAssetImagePending = (type, id) => ctx.hasActiveAssetImage(type, id) || ctx[{ character: 'pendingCharImageIds', scene: 'pendingSceneImageIds', prop: 'pendingPropImageIds' }[type]].value.includes(id)
  runInNewContext('let assetDetailRevision = 0; let assetDialogOpener = null; let genTasksTimer = null;\n'
    + section('function openAssetDetail(', 'function trapAssetDialogFocus(')
    + section('async function saveAssetDetail(', 'function assetImageSrc(')
    + section('function hasActiveAssetImage(', 'function getVideoUrl(')
    + section('async function loadGenTasks()', 'const genTaskDoneCount =')
    + section('let refreshingTasks = false', 'const productionBlockMessage =')
    + '\nglobalThis.activeCount = genTaskActiveCount;', ctx)
  return {
    ctx, item: records.value[0], requests, updates, errors, promptCalls, pollChecks, timers,
    open: mode => {
      ctx.openAssetDetail(kind, records.value[0])
      if (mode === 'reference') ctx.assetGenerationMode.value = mode
    },
    setTaskResults: value => { taskResults = value },
    setQueryError: value => { queryError = value },
    setUpdateHandler: handler => { updateHandler = handler },
    cleanup: () => stops.forEach(stop => stop()),
  }
}

test('details always opens text mode and switching tabs does not auto-use the current image', async t => {
  const h = setup(); t.after(h.cleanup)
  h.open()
  assert.equal(h.ctx.assetGenerationMode.value, 'text')
  h.ctx.assetGenerationMode.value = 'reference'
  assert.equal(h.ctx.assetGenerationMode.value, 'reference')
  assert.deepEqual(plain(h.ctx.assetReferenceDraft.value), [])
  h.ctx.closeAssetDetail()
  h.open()
  assert.equal(h.ctx.assetGenerationMode.value, 'text')
  assert.equal(h.ctx.assetDetailDraft.value.appearance, 'original face')
  assert.equal(h.ctx.assetDetailDraft.value.styling, 'original clothes')
  assert.equal(h.ctx.assetGenerationModels.value.text, '10/wf-z-image')
  assert.equal(h.ctx.assetGenerationModels.value.reference, '11/wf-qwen-image')
  await nextTick()
})

for (const kind of ['character', 'scene', 'prop']) {
  test(`${kind}: reference submission preserves text fields, uses its own model and skips the prompt agent`, async t => {
    const h = setup(kind); t.after(h.cleanup)
    h.item.final_prompt = 'original final prompt'
    h.open('reference')
    h.ctx.assetReferenceDraft.value = ['static/main.png', 'static/support.png']
    h.ctx.assetEditDraft.value = '  change the coat  '
    h.ctx.assetDetailDraft.value = { appearance: 'unsaved face', styling: 'unsaved clothes', description: 'unsaved object', prompt: 'unsaved scene' }
    h.ctx.assetPromptDraft.value = 'unsaved text prompt'
    h.ctx.assetPromptDirty.value = true
    await h.ctx.generateAssetDetail()
    assert.deepEqual(h.promptCalls, [])
    assert.equal(h.requests.length, 1)
    const args = h.requests[0].args
    assert.equal(args[2], 'wf-qwen-image')
    assert.equal(args[3], 11)
    assert.deepEqual(args[6], { generation_mode: 'reference', reference_images: ['static/main.png', 'static/support.png'], edit_prompt: 'change the coat' })
    assert.deepEqual(Object.keys(h.updates[0].payload).sort(), ['edit_prompt', 'reference_config_id', 'reference_images', 'reference_model'])
    assert.equal(h.item.appearance, 'original face')
    assert.equal(h.item.styling, 'original clothes')
    assert.equal(h.item.final_prompt, 'original final prompt')
    assert.equal(h.ctx.assetPromptDraft.value, 'unsaved text prompt')
    assert.equal(h.ctx.assetPromptDirty.value, true)
  })

  test(`${kind}: outside text redraw sends no saved reference or edit prompt and selects the text model`, async t => {
    const h = setup(kind); t.after(h.cleanup)
    h.item.reference_images = ['static/main.png']
    h.item.edit_prompt = 'reference-only changes'
    await h.ctx.submitAssetImage(kind, h.item.id)
    assert.equal(h.promptCalls.length, 1)
    assert.equal(h.requests.length, 1)
    const args = h.requests[0].args
    assert.equal(args[2], 'wf-z-image')
    assert.equal(args[3], 10)
    assert.deepEqual(args[6], { generation_mode: 'text' })
    assert.equal(h.ctx.assetDetail.value.open, false)
  })

  test(`${kind}: text dialog uses the final prompt with optional references for this submission`, async t => {
    const h = setup(kind); t.after(h.cleanup)
    h.item.reference_images = ['static/saved-edit.png']
    h.open()
    assert.deepEqual(plain(h.ctx.assetTextReferenceDraft.value), [])
    h.ctx.assetGenerationModels.value.text = '12/gpt-image-2'
    h.ctx.assetTextReferenceDraft.value = ['static/main.png', 'static/support.png']
    h.ctx.assetPromptDraft.value = 'new final prompt'
    h.ctx.assetPromptDirty.value = true
    await h.ctx.generateAssetDetail()
    assert.equal(h.updates[0].payload.final_prompt, 'new final prompt')
    assert.equal('reference_images' in h.updates[0].payload, false)
    assert.deepEqual(h.requests[0].args[6], { generation_mode: 'text', reference_images: ['static/main.png', 'static/support.png'] })
    assert.deepEqual(plain(h.item.reference_images), ['static/saved-edit.png'])
    assert.deepEqual(h.promptCalls, [])
  })
}

test('reference generation validates both explicit images and modification text before saving or submitting', async t => {
  const h = setup(); t.after(h.cleanup)
  h.open('reference')
  await h.ctx.generateAssetDetail()
  assert.equal(h.errors[0], 'assetGeneration.referenceRequired')
  h.ctx.assetReferenceDraft.value = ['static/main.png']
  await h.ctx.generateAssetDetail()
  assert.equal(h.errors[1], 'assetGeneration.editRequired')
  assert.equal(h.updates.length, 0)
  assert.equal(h.requests.length, 0)
})

test('save-and-generate snapshots reference input even when the modal is closed and another asset is opened', async t => {
  const h = setup(); t.after(h.cleanup)
  h.open('reference')
  h.ctx.assetReferenceDraft.value = ['static/main.png']
  h.ctx.assetEditDraft.value = 'change coat'
  let release
  h.setUpdateHandler(() => new Promise(resolve => { release = resolve }))
  const operation = h.ctx.generateAssetDetail()
  h.ctx.closeAssetDetail()
  const other = { id: 2, appearance: 'different face', styling: 'different clothes' }
  h.ctx.openAssetDetail('character', other)
  release()
  await operation
  assert.equal(h.ctx.assetGenerationMode.value, 'text')
  assert.equal(h.ctx.assetDetail.value.item.id, 2)
  assert.equal(h.ctx.assetDetailDraft.value.appearance, 'different face')
  assert.equal(h.requests[0].args[0], 1)
  assert.deepEqual(h.requests[0].args[6], { generation_mode: 'reference', reference_images: ['static/main.png'], edit_prompt: 'change coat' })
})

test('a failed save reports an error and prevents a generation request', async t => {
  const h = setup(); t.after(h.cleanup)
  h.open('reference')
  h.ctx.assetReferenceDraft.value = ['static/main.png']
  h.ctx.assetEditDraft.value = 'change coat'
  h.setUpdateHandler(async () => { throw new Error('save failed') })
  await h.ctx.generateAssetDetail()
  assert.deepEqual(h.errors, ['save failed'])
  assert.equal(h.requests.length, 0)
  assert.equal(h.ctx.savingAssetDetail.value, false)
})

test('refresh updates the open modal result image without replacing unsaved text or reference drafts', async t => {
  const h = setup(); t.after(h.cleanup)
  h.open('reference')
  h.ctx.assetReferenceDraft.value = ['static/unsaved-reference.png']
  h.ctx.assetEditDraft.value = 'unsaved edit'
  h.ctx.assetDetailDraft.value.appearance = 'unsaved face'
  h.ctx.assetPromptDraft.value = 'unsaved final prompt'
  Object.assign(h.ctx, {
    drama: ref(null), episode: ref(null), episodeNumber: 1,
    scenes: ref([]), propItems: ref([]), selectedVideoSbIds: ref([]), selectedSb: ref(null), scriptStep: ref(0),
    dramaAPI: { get: async () => ({ episodes: [{ id: 1, episode_number: 1 }] }) },
    episodeAPI: {
      characters: async () => [{ id: 1, image_url: 'static/new-result.png', local_path: 'static/new-result.png', appearance: 'server face' }],
      scenes: async () => [], props: async () => [], storyboards: async () => [],
    },
    mergeData: ref(null), mergeAPI: { status: async () => null }, loadExportMerges: async () => {},
  })
  runInNewContext('let panelRestored = false;\n' + section('async function refresh()', 'function saveRaw()'), h.ctx)
  await h.ctx.refresh()
  assert.equal(h.ctx.assetDetail.value.item.image_url, 'static/new-result.png')
  assert.equal(h.ctx.assetDetailDraft.value.appearance, 'unsaved face')
  assert.equal(h.ctx.assetPromptDraft.value, 'unsaved final prompt')
  assert.equal(h.ctx.assetEditDraft.value, 'unsaved edit')
  assert.deepEqual(plain(h.ctx.assetReferenceDraft.value), ['static/unsaved-reference.png'])
  assert.deepEqual(h.errors, [])
})

test('a task which fails before the first status read produces exactly one toast and releases submitted tracking', async t => {
  const h = setup(); t.after(h.cleanup)
  h.item.final_prompt = 'ready'
  await h.ctx.submitAssetImage('character', 1)
  assert.equal(h.ctx.submittedImageTaskIds.has(42), true)
  h.setTaskResults({ tasks: [{ id: 42, type: 'image', status: 'failed', character_id: 1, error_msg: 'reference unavailable' }], merges: [] })
  await h.ctx.loadGenTasks()
  await h.ctx.loadGenTasks()
  assert.deepEqual(h.errors, ['reference unavailable'])
  assert.equal(h.ctx.submittedImageTaskIds.has(42), false)
  assert.equal(h.pollChecks[0](), true)
})

test('temporary task query failures preserve submitted IDs and keep both polling paths alive until terminal status', async t => {
  const h = setup(); t.after(h.cleanup)
  h.item.final_prompt = 'ready'
  h.setQueryError(new Error('temporarily offline'))
  h.ctx.refresh = () => h.ctx.loadGenTasks()
  await h.ctx.submitAssetImage('character', 1)
  await nextTick()
  assert.equal(h.ctx.activeCount.value, 0)
  assert.equal(h.ctx.submittedImageTaskIds.has(42), true)
  assert.equal(h.pollChecks[0](), false)
  assert.equal(h.timers.filter(timer => !timer.cleared).length, 1)
  await h.timers.find(timer => !timer.cleared).callback()
  assert.equal(h.ctx.submittedImageTaskIds.has(42), true)
  h.setQueryError(null)
  h.setTaskResults({ tasks: [{ id: 42, type: 'image', status: 'completed', character_id: 1 }], merges: [] })
  await h.ctx.loadGenTasks()
  await nextTick()
  assert.equal(h.ctx.submittedImageTaskIds.has(42), false)
  assert.equal(h.pollChecks[0](), true)
  assert.equal(h.timers.filter(timer => !timer.cleared).length, 0)
  assert.deepEqual(h.errors, [])
})
