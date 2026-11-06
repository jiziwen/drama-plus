import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const source = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
function setup() {
  const ref = value => ({ value })
  const computed = get => ({ get value() { return get() } })
  const configs = [
    { id: 10, provider: 'comfyui', name: 'local', is_active: true, model: ['wf-minimax-h3'], comfyui: { maxReferences: 4 } },
    { id: 20, provider: 'aliyun', name: 'cloud', is_active: true, model: ['wan3.0-video'] },
    { id: 21, provider: 'aliyun', name: 'cloud two', is_active: true, model: ['wan3.0-video'] },
  ]
  const calls = [], errors = []
  const ctx = {
    ref, computed, videoConfigs: ref(configs), lockedVideoConfigId: ref(null),
    configModels: config => config?.model || [], modelLabel: value => value,
    selectedVideoConfig: ref(configs[1]), videoModel: ref('aliyun/wan3.0-video'),
    videoModelOptions: ref([{ key: 'aliyun/wan3.0-video', configId: 20 }]),
    bareModelName: key => key.split('/').slice(1).join('/'),
    ownerConfigId: (options, key) => options.find(option => option.key === key)?.configId,
    episode: ref({ resolution: '1080p' }),
    RESOLUTION_DISPLAY: { aliyun: { '1080p': '1080P' }, volcengine: { '1080p': '720p' } },
    videoSizeForConfig: () => '1024 × 576',
    sbs: ref([]), selectedSb: ref(null), batchVideoConfirm: ref({ targets: [] }),
    t: value => value, toastError: error => errors.push(error.message),
    storyboardAPI: { update: async (id, payload) => { calls.push({ id, ...payload }) } },
  }
  runInNewContext(section('const shotVideoModelOptions =', 'const batchVideoTotalDuration =') + '\nglobalThis.savingIds = savingShotVideoIds; globalThis.options = shotVideoModelOptions;', ctx)
  runInNewContext(section('function shotReferenceLimit(', '// 本次生成的生效配置'), ctx)
  return { ctx, configs, calls, errors }
}

test('shot overrides are independent and inheritance follows toolbar changes', () => {
  const { ctx, configs } = setup()
  const local = { id: 1, video_model: 'wf-minimax-h3', video_config_id: 10 }
  const inherited = { id: 2 }
  assert.equal(ctx.shotVideoSelection(local).configId, 10)
  assert.equal(ctx.shotVideoSelection(inherited).configId, 20)
  ctx.videoModel.value = 'comfyui/wf-minimax-h3'
  ctx.videoModelOptions.value.push({ key: ctx.videoModel.value, configId: 10 })
  ctx.selectedVideoConfig.value = configs[0]
  assert.equal(ctx.shotVideoSelection(inherited).configId, 10)
  assert.equal(ctx.shotVideoSelection(local).configId, 10)
  assert.equal(ctx.options.value.filter(option => option.model === 'wan3.0-video').length, 2)
  assert.notEqual(ctx.options.value[1].key, ctx.options.value[2].key)
})

test('reference limits and prompt indices use the target shot even when another shot is selected', () => {
  const { ctx } = setup()
  const local = { id: 1, video_model: 'wf-minimax-h3', video_config_id: 10 }
  const cloud = { id: 2, video_model: 'wan3.0-video', video_config_id: 20 }
  ctx.selectedSb.value = local
  ctx.getStoryboardScene = () => ({ location: 'scene', image_url: 'scene.png' })
  ctx.getStoryboardCharacters = () => Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, image_url: `c${i}.png` }))
  ctx.getStoryboardProps = () => []
  runInNewContext(section('function getShotReferenceImages(', '// 右侧参考素材面板'), ctx)
  runInNewContext(section('function getShotReferenceIndexMap(', '// 将视频提示词里的'), ctx)
  assert.equal(ctx.getShotReferenceImages(local).length, 4)
  assert.equal(ctx.getShotReferenceImages(cloud).length, 10)
  assert.equal(ctx.getShotReferenceIndexMap(cloud).c8, 10)
  assert.equal(ctx.getShotReferenceIndexMap(local).c3, undefined)
  assert.equal(ctx.shotVideoResolutionLabel(local), '1024 × 576')
  assert.equal(ctx.shotVideoResolutionLabel(cloud), '1080P')
})

test('saving a model updates only its shot and preserves all editing fields after switching selection', async () => {
  const { ctx, calls } = setup()
  const shot = { id: 1, description: 'scene', atmosphere: 'cold', video_prompt: '@hero walks', duration: 12.25, character_ids: [3], scene_id: 4 }
  const other = { id: 2, video_model: 'wan3.0-video', video_config_id: 20 }
  const before = structuredClone(shot)
  ctx.sbs.value = [shot, other]
  ctx.selectedSb.value = shot
  let release
  ctx.storyboardAPI.update = async (id, payload) => { calls.push({ id, ...payload }); await new Promise(resolve => { release = resolve }) }
  const operation = ctx.changeShotVideoModel(shot, '10/wf-minimax-h3')
  assert.deepEqual(Array.from(ctx.savingIds.value), [1])
  ctx.selectedSb.value = other
  release()
  await operation
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ id: 1, video_model: 'wf-minimax-h3', video_config_id: 10 }])
  for (const key of Object.keys(before)) assert.deepEqual(shot[key], before[key])
  assert.equal(shot.video_model, 'wf-minimax-h3')
  assert.equal(other.video_config_id, 20)
  assert.equal(ctx.savingIds.value.length, 0)
})

test('inheritance can be restored and a failed save leaves the old choice usable', async () => {
  const { ctx, errors } = setup()
  const shot = { id: 1, video_model: 'wf-minimax-h3', video_config_id: 10 }
  ctx.sbs.value = [shot]
  ctx.selectedSb.value = shot
  ctx.storyboardAPI.update = async () => { throw new Error('offline') }
  await ctx.changeShotVideoModel(shot, '')
  assert.equal(ctx.shotVideoModelKey(shot), '10/wf-minimax-h3')
  assert.deepEqual(errors, ['offline'])
  ctx.storyboardAPI.update = async () => {}
  await ctx.changeShotVideoModel(shot, '')
  assert.equal(ctx.shotVideoModelKey(shot), '')
  assert.equal(ctx.shotVideoSelection(shot).configId, 20)
})

test('single and batch submissions carry each target choice; invalid overrides do not silently fall back', async () => {
  const { ctx } = setup()
  const sent = [], errors = []
  Object.assign(ctx, {
    canRecoverVideo: () => false, latestVideoTask: () => null,
    getShotReferenceImages: () => [], resolveVideoPromptRefs: sb => sb.video_prompt,
    dramaId: 1, dramaAspectRatio: { value: '16:9' },
    failedVideoMessages: { value: {} }, pendingVideoIds: { value: [] },
    isPendingVideo: id => ctx.pendingVideoIds.value.includes(id),
    taskAPI: { generate: async params => { sent.push(params); return { id: sent.length } } },
    toast: { error: error => errors.push(error), success() {} }, refresh: async () => {}, pollVideoGeneration() {},
  })
  runInNewContext(section('function videoGenerationDuration(', 'function pickFile(') + section('async function genVid(', 'async function pollVideoGeneration('), ctx)
  await Promise.all([
    ctx.genVid({ id: 1, video_prompt: 'one', duration: 12.25, video_model: 'wf-minimax-h3', video_config_id: 10 }, { silent: true }),
    ctx.genVid({ id: 2, video_prompt: 'two', duration: 7.5 }, { silent: true }),
  ])
  assert.equal(sent[0].config_id, 10)
  assert.equal(sent[0].model, 'wf-minimax-h3')
  assert.equal(sent[1].config_id, 20)
  assert.equal(sent[0].duration, 12)
  assert.equal(sent[1].duration, 8)
  await ctx.genVid({ id: 3, video_prompt: 'three', video_model: 'removed', video_config_id: 10 })
  assert.equal(sent.length, 2)
  assert.deepEqual(errors, ['episode.inspector.modelUnavailable'])
})

test('video selector stays inside the existing inspector between duration and redraw', () => {
  const footer = section('<div class="video-inspector-footer">', '</aside>')
  assert.ok(footer.indexOf('onVideoDurationChange') < footer.indexOf('changeShotVideoModel'))
  assert.ok(footer.indexOf('changeShotVideoModel') < footer.indexOf('@click="genVid(selectedSb)"'))
  assert.doesNotMatch(footer, /dialog|modal|Teleport/)
})

test('duration editing uses whole seconds without rewriting the stored video duration on display', () => {
  const shot = { duration: 12.25 }
  const writes = []
  const ctx = { selectedSb: { value: shot }, updateField: (...args) => writes.push(args) }
  runInNewContext(section('function videoGenerationDuration(', 'function pickFile('), ctx)
  assert.equal(ctx.videoGenerationDuration(shot.duration), 12)
  assert.equal(shot.duration, 12.25)
  assert.equal(writes.length, 0)
  const event = { target: { value: '13.7' } }
  ctx.onVideoDurationChange(event)
  assert.equal(event.target.value, 14)
  assert.equal(writes[0][2], 14)
})
