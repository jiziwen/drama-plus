import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const script = source.slice(source.indexOf('function hasActiveAssetImage('), source.indexOf('function getVideoUrl(s)'))
function setup(type) {
  const calls = []
  let release
  let fail = false
  const gate = new Promise(resolve => { release = resolve })
  const ref = value => ({ value })
  const items = [{ id: 1, final_prompt: 'ready' }, { id: 2, final_prompt: 'ready' }]
  const context = {
    visualChars: ref(items), scenes: ref(items), propItems: ref(items),
    pendingCharImageIds: ref([]), pendingSceneImageIds: ref([]), pendingPropImageIds: ref([]),
    genTasks: ref([]), epId: ref(1), imageModel: ref('model'), imageModelOptions: ref([]),
    bareModelName: x => x, ownerConfigId: () => 1, chatModelOverride: () => '', chatConfigId: () => 1,
    t: x => x, toast: { info() {}, success() {} }, toastError() {}, watchAsyncResult() {},
    refresh: async () => {},
  }
  const api = { generateImage: async id => {
    calls.push(id)
    await gate
    if (fail) throw new Error('network error')
    context.genTasks.value.push({ type: 'image', status: 'processing', [`${type}_id`]: id })
  } }
  Object.assign(context, { characterAPI: api, sceneAPI: api, propAPI: api })
  runInNewContext(script, context)
  return { context, calls, release, setFail: value => { fail = value } }
}

for (const type of ['character', 'scene', 'prop']) {
  test(`${type}: rapid batch clicks and single clicks send each asset once`, async () => {
    const { context, calls, release } = setup(type)
    const first = context.batchAssetImages(type)
    await context.batchAssetImages(type)
    await context.submitAssetImage(type, 1)
    assert.deepEqual(calls, [1, 2])
    assert.equal(context.assetImageBatchBusy(type), true)
    release()
    await first
    // New page/local state cleared, but server tasks must still block submission.
    await context.batchAssetImages(type)
    assert.deepEqual(calls, [1, 2])
    context.genTasks.value.forEach(task => { task.status = 'failed' })
    assert.equal(context.assetImageBatchBusy(type), false)
    await context.submitAssetImage(type, 1)
    assert.deepEqual(calls, [1, 2, 1])
  })
}

test('failed HTTP submission unlocks assets for retry', async () => {
  const { context, calls, release, setFail } = setup('scene')
  setFail(true)
  release()
  await context.submitAssetImage('scene', 1)
  assert.equal(context.assetImageBatchBusy('scene'), false)
  setFail(false)
  await context.submitAssetImage('scene', 1)
  assert.deepEqual(calls, [1, 1])
})
