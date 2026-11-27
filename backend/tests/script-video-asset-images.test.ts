import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createScriptVideoAssetImages } from '../src/routes/script-video-asset-images.js'
import { scriptVideoAssetImagePrompt } from '../src/services/script-video-asset-image-prompt.js'
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
  const existingScene = '空庭院，庭门在画面右侧'
  const extractedScene = scriptVideoAssetImagePrompt('scene', '空堂，正中有一条通道。', '大堂')
  const characterPrompt = '苏荷，窄脸，深蓝色布衣。'
  const previousPrompt = [
    '角色设定参考图（正脸特写＋三视图）。左侧是正脸特写，完整展示头部和肩部。右侧按正面、90 度侧面、背面排列三张等高全身图，头顶和脚底对齐。',
    '四个视图是同一角色的同一套造型，面容、发型、体型、服装和配饰一致。面部表情中性，全身采用自然 A 字站姿。纯白背景，柔和均匀的光线。画面无文字、水印或其他人物。',
    '构图以以上布局为准，以下描述用于角色设定和画风。',
    characterPrompt,
  ].join('\n')
  const extractedPrompt = scriptVideoAssetImagePrompt('character', '苏荷，窄脸，灰色斗篷。')
  const previousCostume = '苏荷，长发编成辫子，身穿白色披风。'
  const previousCostumePrompt = [
    '角色设定参考图（正脸特写＋服装三视图＋细节特写）。横向 16:9，纯白背景，柔和均匀的棚拍光。画面分为左、中、右三栏。',
    '中栏约占 50%，从左到右并排展示同一角色的正面、90 度侧面、180 度背面。三幅都从头顶到脚底完整入镜，保留完整头部、发型、头饰、服装和鞋靴。',
    '构图采用上述布局，以下描述用于角色设定和画风。',
    previousCostume,
  ].join('\n')
  await store.mutateAssets(id, () => ({ assets: [
    { id: 'court', kind: 'scene', name: '庭院', image: '', imagePrompt: existingScene },
    { id: 'key', kind: 'prop', name: '旧钥匙', image: oldImage, imagePrompt: '有缺口的铜钥匙' },
    { id: 'suhe', kind: 'character', name: '苏荷', image: '', imagePrompt: previousPrompt },
    { id: 'suhe-cloak', kind: 'character', name: '苏荷（斗篷）', image: '', imagePrompt: extractedPrompt },
    { id: 'hall', kind: 'scene', name: '大堂', image: '', imagePrompt: extractedScene },
    { id: 'suhe-white', kind: 'character', name: '苏荷（白色披风）', image: '', imagePrompt: previousCostumePrompt },
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
    body: JSON.stringify({ ...imageModel, assetIds: ['court', 'key', 'court', 'suhe', 'suhe-cloak', 'hall', 'suhe-white'] }),
    headers: { 'Content-Type': 'application/json' },
  })

  assert.deepEqual((await (await generate()).json()).data.started, ['court', 'key', 'suhe', 'suhe-cloak', 'hall', 'suhe-white'])
  assert.deepEqual((await (await generate()).json()).data.started, [])
  const pending = (await store.summary(id)).assets
  assert.ok(pending.every(asset => asset.imageStatus === 'generating'))
  assert.equal(pending[1].image, oldImage)
  assert.equal(calls.length, 1)
  complete = true
  for (let attempt = 0; attempt < 100; attempt++) {
    const assets = (await store.summary(id)).assets
    if (assets.every(asset => asset.imageStatus !== 'generating')) break
    await delay(5)
  }
  const assets = (await store.summary(id)).assets
  const [sceneRequest, propRequest, characterRequest] = calls
  assert.deepEqual([sceneRequest.configId, sceneRequest.model, sceneRequest.galleryAspect], [23, 'mj_imagine', '16:9'])
  assert.ok(sceneRequest.prompt.startsWith(existingScene))
  assert.match(sceneRequest.prompt, /\[5\.四宫格多机位排版\]/u)
  assert.match(sceneRequest.prompt, /左上【庭院-正视（朝内）】/u)
  assert.match(sceneRequest.prompt, /右上【90°侧视】/u)
  assert.match(sceneRequest.prompt, /左下【180°反打（朝入口）】/u)
  assert.match(sceneRequest.prompt, /右下【45°全局俯视】/u)
  assert.equal(assets[0].imagePrompt, existingScene)
  assert.deepEqual([propRequest.prompt, propRequest.configId, propRequest.model, propRequest.galleryAspect],
    ['有缺口的铜钥匙', 23, 'mj_imagine', '1:1'])
  assert.equal(assets[0].image, '/static/images/court-after.png')
  assert.equal(assets[0].imageStatus, 'completed')
  assert.equal(assets[1].image, oldImage)
  assert.equal(assets[1].imageStatus, 'failed')
  assert.equal(assets[1].imageError, '服务暂时不可用')
  assert.equal(calls.length, 6)
  assert.equal(characterRequest.galleryAspect, '16:9')
  assert.match(characterRequest.prompt, /左侧约占 38%.*超大正面头部与上半身肖像/u)
  assert.match(characterRequest.prompt, /中部约占 50%.*严格正面、严格 90 度侧面、严格 180 度背面/u)
  assert.match(characterRequest.prompt, /正面和侧面从颈根展示至鞋底.*省略头部/u)
  assert.match(characterRequest.prompt, /背面从头顶到鞋底完整入镜/u)
  assert.match(characterRequest.prompt, /鞋底基线对齐，双臂自然垂落，双手放松/u)
  assert.match(characterRequest.prompt, /最右侧约占 12%.*三个矩形细节特写/u)
  assert.doesNotMatch(characterRequest.prompt, /正脸特写＋三视图/u)
  assert.ok(characterRequest.prompt.endsWith(characterPrompt))
  assert.equal(assets[2].imagePrompt, previousPrompt)
  assert.equal(calls[3].prompt, extractedPrompt)
  assert.equal(calls[4].prompt, extractedScene)
  assert.equal(calls[5].prompt, scriptVideoAssetImagePrompt('character', previousCostume))
  assert.doesNotMatch(calls[5].prompt, /三幅都从头顶到脚底完整入镜/u)
  assert.equal(assets[5].imagePrompt, previousCostumePrompt)
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

test('an already generated project image can be downloaded again and attached to its original asset', () => fixture(async (store, id) => {
  const oldImage = '/static/uploads/previous.png'
  const error = '图片已生成，暂未保存到资产。'
  await store.mutateAssets(id, () => ({ assets: [
    { id: 'street', kind: 'scene', name: '朱雀大街', image: oldImage, imagePrompt: '青石街道',
      imageStatus: 'failed', imageError: error, imageTaskId: 31, imageRequestId: 'street-request' },
    { id: 'unrelated', kind: 'scene', name: '其他场景', image: oldImage, imagePrompt: '宅院',
      imageStatus: 'failed', imageTaskId: 31, imageRequestId: 'other-request' },
  ], result: undefined }))
  let task = { id: 31, status: 'delivery_pending', localPath: null as string | null, error: error as string | null }
  const recoveries: number[] = []
  const { routes, refresh } = createScriptVideoAssetImages(store, {
    readImageTask: (owner, taskId) => owner.assetId === 'street' && owner.requestId === 'street-request' && taskId === 31 ? task : undefined,
    generateImage: async () => assert.fail('recover must not submit a new generation'),
    async recoverImageTask(taskId) {
      recoveries.push(taskId)
      task = { ...task, status: 'processing', error: null }
    },
  })
  assert.equal(await refresh(id), true)
  const [pending] = (await store.summary(id)).assets
  assert.equal(pending.imageStatus, 'delivery_pending')
  assert.equal(pending.imageError, error)
  assert.equal(pending.image, oldImage)
  assert.equal(await refresh(id), false)

  const recover = (assetId: string) => routes.request(`/projects/${id}/assets/${assetId}/recover-image`, { method: 'POST' })
  assert.equal((await recover('unrelated')).status, 400)
  assert.equal((await recover('street')).status, 200)
  assert.equal((await recover('street')).status, 200)
  assert.deepEqual(recoveries, [31])
  assert.equal((await store.summary(id)).assets[0].imageStatus, 'generating')

  task = { ...task, status: 'completed', localPath: 'static/images/street.png' }
  assert.equal(await refresh(id), true)
  const [restored, unrelated] = (await store.summary(id)).assets
  assert.equal(restored.imageStatus, 'completed')
  assert.equal(restored.image, '/static/images/street.png')
  assert.equal(restored.imageError, undefined)
  assert.equal(unrelated.image, oldImage)
  assert.equal(await refresh(id), false)
}))
