import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createScriptVideoAssetImages } from '../src/routes/script-video-asset-images.js'
import { ScriptVideoStore } from '../src/services/script-video-store.js'
import type { generateImage } from '../src/services/generation.js'

const imageModel = { configId: 23, model: 'mj_imagine' }

async function fixture(run: (store: ScriptVideoStore, id: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-asset-images-'))
  const store = new ScriptVideoStore(directory)
  try {
    const { id } = await store.create('整剧资产')
    await run(store, id)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('batch starts each project asset once and a failed redraw preserves the previous image', () => fixture(async (store, id) => {
  const oldImage = '/static/images/key-before.png'
  await store.mutateAssets(id, () => ({ assets: [
    { id: 'court', kind: 'scene', name: '庭院', image: '', imagePrompt: '空庭院，庭门在画面右侧' },
    { id: 'key', kind: 'prop', name: '旧钥匙', image: oldImage, imagePrompt: '有缺口的铜钥匙' },
  ], result: undefined }))
  const calls: Parameters<typeof generateImage>[0][] = []
  let complete = false
  const { routes } = createScriptVideoAssetImages(store, {
    selectTextImageModel: selection => selection.configId === imageModel.configId ? imageModel : undefined,
    generateImage: async input => calls.push(input),
    readImageTask: (_owner, taskId) => {
      if (!taskId) return
      if (!complete) return { id: taskId, status: 'processing', localPath: null, error: null }
      if (taskId === 1) return { id: taskId, status: 'completed', localPath: 'static/images/court-after.png', error: null }
      return { id: taskId, status: 'failed', localPath: null, error: '服务暂时不可用' }
    },
    pollIntervalMs: 5,
    workers: 1,
  })
  const generate = () => routes.request(`/projects/${id}/assets/generate`, {
    method: 'POST',
    body: JSON.stringify({ ...imageModel, assetIds: ['court', 'key', 'court'] }),
    headers: { 'Content-Type': 'application/json' },
  })

  assert.deepEqual((await (await generate()).json()).data.started, ['court', 'key'])
  assert.deepEqual((await (await generate()).json()).data.started, [])
  const pending = (await store.summary(id)).assets
  assert.deepEqual(pending.map(asset => asset.imageStatus), ['generating', 'generating'])
  assert.equal(pending[1].image, oldImage)
  assert.equal(calls.length, 1)
  complete = true
  for (let attempt = 0; attempt < 100; attempt++) {
    const assets = (await store.summary(id)).assets
    if (assets.every(asset => asset.imageStatus !== 'generating')) break
    await delay(5)
  }
  const assets = (await store.summary(id)).assets
  assert.deepEqual(calls.map(input => [input.prompt, input.configId, input.model, input.galleryAspect]), [
    ['空庭院，庭门在画面右侧', 23, 'mj_imagine', '16:9'],
    ['有缺口的铜钥匙', 23, 'mj_imagine', '1:1'],
  ])
  assert.equal(assets[0].image, '/static/images/court-after.png')
  assert.equal(assets[0].imageStatus, 'completed')
  assert.equal(assets[1].image, oldImage)
  assert.equal(assets[1].imageStatus, 'failed')
  assert.equal(assets[1].imageError, '服务暂时不可用')
}))

test('refresh attaches the matching task after restart and releases an interrupted submission', () => fixture(async (store, id) => {
  await store.mutateAssets(id, () => ({ assets: [
    { id: 'recover', kind: 'character', name: '苏荷', image: '', imagePrompt: '苏荷正面造型', imageStatus: 'generating', imageRequestId: 'attached-after-crash' },
    { id: 'lost', kind: 'prop', name: '徽章', image: '/static/images/badge-before.png', imagePrompt: '金属徽章', imageStatus: 'generating', imageRequestId: 'interrupted' },
  ], result: undefined }))
  const { refresh } = createScriptVideoAssetImages(store, {
    readImageTask: owner => {
      assert.equal(owner.projectId, id)
      if (owner.assetId === 'recover' && owner.requestId === 'attached-after-crash') {
        return { id: 18, status: 'completed', localPath: 'static/images/cast.png', error: null }
      }
    },
  })
  assert.equal(await refresh(id), true)
  assert.equal(await refresh(id), false)
  const assets = (await store.summary(id)).assets
  assert.equal(assets[0].imageTaskId, 18)
  assert.equal(assets[0].imageStatus, 'completed')
  assert.equal(assets[0].image, '/static/images/cast.png')
  assert.equal(assets[1].imageStatus, 'failed')
  assert.equal(assets[1].image, '/static/images/badge-before.png')
}))
