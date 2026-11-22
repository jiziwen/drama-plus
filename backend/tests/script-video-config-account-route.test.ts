import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('剧本转视频提交使用所选 LibTV 账号和提示词模式，页面选择不写入全局', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-config-account-'))
  Object.assign(process.env, {
    SQLITE_PATH: path.join(root, 'test.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: path.join(root, 'static'), MYSQL_AUTO_IMPORT: 'false',
  })
  const { db, schema } = await import('../src/db/index.js')
  const { getVideoPromptMode, setVideoPromptMode } = await import('../src/services/app-settings.js')
  const { createVideoCliAccount, setActiveVideoCliAccount } = await import('../src/services/video-cli-accounts.js')
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const stores = new Set<InstanceType<typeof ScriptVideoStore>>()
  const getQueue = Object.getOwnPropertyDescriptor(ScriptVideoStore.prototype, 'queue')!.get!
  t.mock.getter(ScriptVideoStore.prototype, 'queue', function (this: InstanceType<typeof ScriptVideoStore>) {
    stores.add(this)
    return getQueue.call(this)
  })
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const store = new ScriptVideoStore(path.join(root, 'projects'))
  t.after(async () => {
    await Promise.all([...stores].map(item => item.close()))
    db.$client.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  const provider = 'libtv', model = 'star-video2.5'
  const first = createVideoCliAccount(provider, '账号一')
  const second = createVideoCliAccount(provider, '账号二')
  setActiveVideoCliAccount(provider, 'default')
  const ts = new Date().toISOString()
  const configs = [first, second].map(account => db.insert(schema.aiServiceConfigs).values({
    provider, model: JSON.stringify([model]), name: account.name, videoCliAccountId: account.id,
    serviceType: 'video', baseUrl: '', apiKey: '', isActive: true, createdAt: ts, updatedAt: ts,
  }).returning().get())
  await fs.mkdir(path.join(root, 'static', 'uploads'), { recursive: true })
  await fs.writeFile(path.join(root, 'static', 'uploads', 'prop.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64'))
  const { id } = await store.create('单账号视频配置')
  const episodeId = await store.mutate(id, record => {
    record.project.assets = [{ id: 'prop', kind: 'prop', name: '古伞', image: '/static/uploads/prop.png' }]
    const episode = record.project.episodes[0]
    episode.confirmed = true
    episode.confirmedScript = '场景：外墙\n时间：早晨'
    episode.cards = configs.map((config, index) => ({
      id: `part-${index}`, title: config.name, scene: '外墙', version: 2, status: 'draft', duration: 4,
      manuallyAdded: true, prompt: '窗外一束日光穿过树叶。', assetIds: ['prop'], shots: [],
    }))
    return { documentChanged: true, result: episode.id }
  })

  setVideoPromptMode('inline')
  const submissions: { accountId?: string; promptMode?: string }[] = []
  const unused = () => { throw new Error('不应调用其他生成服务') }
  const app = createScriptVideoRoutes(store, {
    generateScriptVideoOutline: unused, generateScriptVideoCards: unused, reviewScriptVideoEpisode: unused,
    reviseScriptVideoCard: unused, assertScriptVideoFormal: unused, recoverVideoTask: unused,
    async getScriptVideoGeneration(taskId) { return { taskId, status: 'processing', stage: 'polling' } },
    async startScriptVideoGeneration(input) {
      submissions.push({ accountId: input.videoCliAccountId, promptMode: input.promptMode })
      return { taskId: 401 + submissions.length, status: 'processing' }
    },
  })
  const endpoint = `/projects/${id}/episodes/${episodeId}`
  const post = (suffix: string, body: unknown) => app.request(endpoint + suffix, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Script-Video-Session': '12345678-1234-4567-8234-123456789012' },
    body: JSON.stringify(body),
  })
  const preview = { cardId: 'part-0', cardVersion: 2 }
  const inline = await post('/final-prompt', preview)
  assert.equal(inline.status, 200, await inline.clone().text())
  assert.doesNotMatch((await inline.json()).data.prompt, /参考素材：/u)
  const guide = await post('/final-prompt', { ...preview, promptMode: 'reference-guide' })
  assert.equal(guide.status, 200, await guide.clone().text())
  assert.match((await guide.json()).data.prompt, /^参考素材：[\s\S]+@图片1 是 @古伞/u)
  for (const [index, config] of configs.entries()) {
    const response = await post(`/cards/part-${index}/video`, { configId: config.id, model, aspectRatio: '16:9',
      resolution: '480p', expectedCardVersion: 2, ...(index === 0 && { promptMode: 'reference-guide' }) })
    assert.equal(response.status, 201, await response.clone().text())
  }
  assert.deepEqual(submissions, [{ accountId: first.id, promptMode: 'reference-guide' }, { accountId: second.id, promptMode: 'inline' }])
  assert.equal(getVideoPromptMode(), 'inline')
  const submitted = { configId: configs[0].id, model, aspectRatio: '16:9', resolution: '480p', expectedCardVersion: 2 }
  for (const [suffix, body] of [
    ['/cards/part-0/video', submitted], ['/final-prompt', { cardId: 'part-0', cardVersion: 2 }],
    ['/continuations', { cardIds: ['part-0'] }], ['/validate', { prepareReferenceImages: true }],
  ] as const) {
    const response = await post(suffix, { ...body, promptMode: 'follow-settings' })
    assert.equal(response.status, 400, await response.clone().text())
    assert.match((await response.json()).message, /请选择有效的视频提示词入参模式/u)
  }
  assert.equal(submissions.length, 2)
})
