import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Hono } from 'hono'
import { registerScriptVideoAssetExtractionRoutes } from '../src/routes/script-video-asset-extraction.js'
import { ScriptVideoStore, ScriptVideoStoreError } from '../src/services/script-video-store.js'

test('资产提取重用已有角色，保留任务期间编辑的提示词和图片，并保存跨集来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-asset-extract-'))
  const store = new ScriptVideoStore(directory)
  try {
    const project = await store.create('整剧')
    const app = new Hono()
    const gate = Promise.withResolvers<void>()
    let calls = 0
    await store.mutateAssets(project.id, () => ({ assets: [{
      id: 'role', kind: 'character', name: '林医生', image: '/static/uploads/role.png', imagePrompt: '初版',
    }], result: undefined }))
    registerScriptVideoAssetExtractionRoutes(app, store,
      (c, error) => c.json({ message: String(error) }, error instanceof ScriptVideoStoreError ? error.status : 500),
      async input => {
        calls++
        assert.deepEqual(input.sources.map(source => source.episodeNumber), [1, 2])
        input.onProgress?.(1, 2)
        await gate.promise
        return [
          { existingAssetId: 'role', kind: 'character', name: '林青', assetIdentity: '林青', aliases: ['小林'],
            imagePrompt: '模型版', sourceTitles: ['第1集', '第2集'], sourceEpisodes: [1, 2] },
          { kind: 'scene', name: '医院诊室', assetIdentity: '医院诊室', aliases: [],
            imagePrompt: '一扇半开的白门，电影级广角空场。', sourceTitles: ['第2集'], sourceEpisodes: [2] },
        ]
      },
    )
    const path = `/projects/${project.id}/assets/extract`
    const post = () => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      sources: [{ title: '第1集', script: '林医生入场。', episodeNumber: 1 }, { title: '第2集', script: '林青走进医院诊室。', episodeNumber: 2 }],
    }) })
    const first = (await (await post()).json()).data
    assert.equal(first.status, 'running')
    assert.equal((await (await post()).json()).data.id, first.id)
    assert.equal(calls, 1)
    await store.mutateAssets(project.id, assets => ({ assets: assets.map(asset => ({ ...asset, imagePrompt: '手动修改' })), result: undefined }))
    gate.resolve()
    let job = (await (await app.request(path)).json()).data
    for (let attempt = 0; job.status === 'running' && attempt < 30; attempt++) {
      await pause(10)
      job = (await (await app.request(path)).json()).data
    }
    assert.deepEqual([job.status, job.added, job.reused], ['completed', 1, 1])
    const [role, scene] = (await store.get(project.id)).assets
    assert.deepEqual([role.id, role.name, role.image, role.imagePrompt], ['role', '林医生', '/static/uploads/role.png', '手动修改'])
    assert.deepEqual(role.sourceEpisodes, [1, 2])
    assert.ok(role.aliases.includes('林青'))
    assert.equal(scene.image, '')
    assert.equal(scene.imageStatus, 'pending')
    assert.match(scene.imagePrompt, /广角空场/u)
    assert.equal((await store.get(project.id)).episodes.length, 1)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
