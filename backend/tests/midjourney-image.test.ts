import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import sharp from 'sharp'

test('资产画廊的火灵灵配置提交绘图、轮询任务并保存图片', async t => {
  const root = await mkdtemp(join(tmpdir(), 'midjourney-image-'))
  process.env.SQLITE_PATH = join(root, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = root
  process.env.MYSQL_AUTO_IMPORT = 'false'

  const [{ default: gallery }, { default: aiConfigs }, { db, schema }, { eq }, { generateImage, resumeInterruptedTasks }, { resolveAssetImageRequest }] = await Promise.all([
    import('../src/routes/asset-gallery.js'), import('../src/routes/aiConfigs.js'), import('../src/db/index.js'),
    import('drizzle-orm'), import('../src/services/generation.js'), import('../src/services/media-selection.js'),
  ])
  t.after(async () => {
    db.$client.close()
    await rm(root, { recursive: true, force: true })
  })
  const timestamp = new Date().toISOString()
  const dates = { createdAt: timestamp, updatedAt: timestamp }
  const project = db.insert(schema.dramas).values({ ...dates, title: '生图测试' }).returning().get()
  const origin = 'https://api.hllapi.vip'
  const config = db.insert(schema.aiServiceConfigs).values({
    ...dates,
    serviceType: 'image',
    provider: 'openai',
    name: '火灵灵',
    baseUrl: origin + '/v1',
    apiKey: 'test-only',
    model: JSON.stringify(['mj_imagine', 'mj_blend']),
    isActive: true,
  }).returning().get()
  const taskId = '1234567890123456789'
  const imageUrl = origin + '/mj/image/' + taskId
  const imageBytes = new Uint8Array(await sharp({
    create: { width: 160, height: 90, channels: 3, background: '#123456' },
  }).png().toBuffer())
  const calls: { url: string; method: string; auth: string | null; body?: unknown }[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method || 'GET'
    const auth = new Headers(init?.headers).get('Authorization')
    calls.push({ url, method, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'POST' && [origin + '/mj/submit/imagine', origin + '/mj/submit/blend'].includes(url)) {
      return Response.json({ code: 1, description: '提交成功', result: taskId })
    }
    if (method === 'GET' && url === origin + '/mj/task/' + taskId + '/fetch') {
      return Response.json({ id: taskId, status: 'SUCCESS', progress: '100%', imageUrl })
    }
    if (url === imageUrl) return new Response(imageBytes, { headers: { 'Content-Type': 'image/png' } })
    if (url === origin + '/v1/models') return Response.json({ data: [{ id: 'mj_imagine' }, { id: 'mj_blend' }] })
    return Response.json({ error: { message: 'openai_error', type: 'bad_response_status_code' } }, { status: 404 })
  })
  // 只缩短任务轮询的等待时间，保留任务提交和落盘的异步流程。
  const setTimer = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms?: number, ...args: unknown[]) =>
    setTimer(callback, ms === 5000 ? 5 : ms, ...args))

  const post = (body: object) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  async function completed(id: number) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const task = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()
      if (task?.status !== 'processing') {
        assert.equal(task?.status, 'completed', task?.errorMsg ?? '')
        return task!
      }
      await delay(20)
    }
    assert.fail('图片任务未完成')
  }
  const input = { kind: 'props', name: '猫', prompt: '一只猫', aspect: '16:9', configId: config.id }
  const models = (await (await gallery.request('/models')).json()).data
  assert.deepEqual(models.map((model: { model: string }) => model.model), ['mj_imagine'])
  assert.equal((await gallery.request('/' + project.id, post({ ...input, model: 'mj_blend' }))).status, 400)
  assert.equal(calls.length, 0)
  const response = await gallery.request('/' + project.id, post({ ...input, model: 'mj_imagine' }))
  assert.equal(response.status, 201)
  const created = (await response.json()).data
  assert.ok(created.taskId, created.error)
  const task = await completed(created.taskId)
  assert.equal(task?.taskId, taskId)
  assert.deepEqual(calls, [
    { url: origin + '/mj/submit/imagine', method: 'POST', auth: 'Bearer test-only',
      body: { botType: 'MID_JOURNEY', prompt: '一只猫 --ar 16:9', base64Array: [] } },
    { url: origin + '/mj/task/' + taskId + '/fetch', method: 'GET', auth: 'Bearer test-only', body: undefined },
    { url: imageUrl, method: 'GET', auth: null, body: undefined },
  ])
  const asset = db.select().from(schema.props).where(eq(schema.props.id, created.id)).get()
  assert.equal(asset?.imageUrl, task.localPath)
  assert.ok(asset?.imageUrl)
  const output = await sharp(join(root, asset.imageUrl)).metadata()
  assert.equal(output.width * 9, output.height * 16)

  await t.test('带参考图的绘图请求传入 Base64，采用所选比例', async () => {
    const encoded = Buffer.from(imageBytes).toString('base64')
    const firstCall = calls.length
    const id = await generateImage({
      configId: config.id, model: 'mj_imagine', prompt: '一只猫 --aspect 1:1', size: '1920x1080',
      referenceImages: ['data:image/png;base64,' + encoded],
    })
    await completed(id)
    assert.deepEqual(calls[firstCall]?.body, { botType: 'MID_JOURNEY', prompt: '一只猫 --ar 16:9', base64Array: [encoded] })
    const entry = db.select().from(schema.apiCallLogs).all().find(row => row.taskId === id && row.method === 'POST')
    assert.ok(entry)
    assert.match(entry.request || '', /参考图内容已省略/)
    assert.ok(!entry.request?.includes(encoded))
  })

  await t.test('独立图片服务可验证连接，再按文档用两张图融合', async () => {
    const settings = {
      service_type: 'image', provider: 'midjourney', name: '火灵灵融合',
      base_url: origin + '/mj/', api_key: 'test-only', model: ['mj_imagine', 'mj_blend'],
    }
    const saved = await aiConfigs.request('/', post(settings))
    assert.equal(saved.status, 201)
    const configId = (await saved.json()).data.id
    const check = await aiConfigs.request('/test', post(settings))
    assert.equal((await check.json()).data.ok, true)
    assert.deepEqual(calls.at(-1), { url: origin + '/v1/models', method: 'GET', auth: 'Bearer test-only', body: undefined })

    const referenceImages = ['https://example.test/mountain.png', 'https://example.test/village.png']
    const blend = { generation_mode: 'reference', model: 'mj_blend', config_id: configId, reference_images: referenceImages }
    await assert.rejects(resolveAssetImageRequest({ ...blend, reference_images: referenceImages.slice(0, 1) }, {}), /两张参考图/)
    const request = await resolveAssetImageRequest(blend, {})
    const firstCall = calls.length
    await completed(await generateImage({ ...request, prompt: request.editPrompt }))
    assert.deepEqual(calls[firstCall], { url: origin + '/mj/submit/blend', method: 'POST', auth: 'Bearer test-only',
      body: { base64Array: referenceImages } })
  })

  await t.test('服务重启后继续查询已提交的绘图任务', async () => {
    const interrupted = db.insert(schema.sysTask).values({
      ...dates, type: 'image', provider: config.provider, model: 'mj_imagine', configId: config.id,
      configBaseUrl: config.baseUrl, taskId, status: 'processing', stage: 'polling',
    }).returning().get()
    const firstCall = calls.length
    await resumeInterruptedTasks()
    await completed(interrupted.id)
    assert.deepEqual(calls.slice(firstCall), [
      { url: origin + '/mj/task/' + taskId + '/fetch', method: 'GET', auth: 'Bearer test-only', body: undefined },
      { url: imageUrl, method: 'GET', auth: null, body: undefined },
    ])
  })

  await t.test('剧本转视频的项目资产使用同一生图任务并写回项目', async () => {
    const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
    const { createScriptVideoAssetImages } = await import('../src/routes/script-video-asset-images.js')
    const store = new ScriptVideoStore(join(root, 'script-video'))
    try {
      const { id } = await store.create('剧本转视频项目')
      await store.mutateAssets(id, () => ({ assets: [{
        id: 'courtyard', kind: 'scene', name: '庭院', image: '', imagePrompt: '一座没有人物的庭院',
      }], result: undefined }))
      const images = createScriptVideoAssetImages(store, { pollIntervalMs: 5 })
      const startedAt = calls.length
      const submitted = await images.routes.request(`/projects/${id}/assets/generate`, post({
        assetIds: ['courtyard'], configId: config.id, model: 'mj_imagine',
      }))
      assert.equal(submitted.status, 200)
      assert.deepEqual((await submitted.json()).data.started, ['courtyard'])
      for (let attempt = 0; attempt < 150; attempt++) {
        if ((await store.summary(id)).assets[0].imageStatus !== 'generating') break
        await delay(20)
      }
      const [asset] = (await store.summary(id)).assets
      assert.equal(asset.imageStatus, 'completed', asset.imageError)
      const task = await completed(asset.imageTaskId)
      assert.equal(asset.image, '/' + task.localPath)
      assert.deepEqual(JSON.parse(task.params!).scriptVideoAsset, {
        projectId: id, assetId: 'courtyard', requestId: asset.imageRequestId,
      })
      assert.equal(task.propId, null)
      assert.deepEqual(calls[startedAt].body, {
        botType: 'MID_JOURNEY', prompt: '一座没有人物的庭院 --ar 16:9', base64Array: [],
      })
    } finally {
      await store.close()
    }
  })
})
