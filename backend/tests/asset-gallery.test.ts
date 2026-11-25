import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

test('画廊创建项目资产，按所选比例生成和重绘，并从项目中删除', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asset-gallery-'))
  process.env.SQLITE_PATH = ':memory:'
  process.env.HUOBAO_DATA_DIR = root
  t.after(() => rm(root, { recursive: true, force: true }))

  const [{ default: gallery }, { default: projects }, { default: tasks }, { db, schema }] = await Promise.all([
    import('../src/routes/asset-gallery.js'), import('../src/routes/dramas.js'), import('../src/routes/tasks.js'), import('../src/db/index.js'),
  ])
  const timestamp = new Date().toISOString()
  const dates = { createdAt: timestamp, updatedAt: timestamp }
  const [project, otherProject] = db.insert(schema.dramas).values([
    { ...dates, title: '画廊测试' }, { ...dates, title: '另一个项目' },
  ]).returning().all()
  const model = 'gpt-image-2.6-sunburst'
  const config = db.insert(schema.aiServiceConfigs).values({
    ...dates, serviceType: 'image', provider: 'openai', name: '测试生图', baseUrl: 'https://example.test',
    apiKey: 'test-only', model: JSON.stringify([model, 'gpt-image-1']), isActive: true,
  }).returning().get()

  const output = await sharp({ create: { width: 96, height: 64, channels: 3, background: '#123456' } }).png().toBuffer()
  const upstream: { model: string; prompt: string; size: string }[] = []
  let hold: Promise<void> | undefined
  const imageUrl = 'https://example.test/result.png'
  const encoded = output.toString('base64')
  let imageResponse: { url?: string; b64_json?: string } = { b64_json: encoded }
  let downloadCalls = 0
  let interruptDownload = false
  let rejectGeneration = false
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === imageUrl) {
      downloadCalls++
      await hold
      const body = interruptDownload ? new ReadableStream({
        start(controller) {
          controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
        },
      }) : new Uint8Array(output)
      return new Response(body, { headers: { 'Content-Type': 'image/png' } })
    }
    upstream.push(JSON.parse(String(init?.body)))
    await hold
    if (rejectGeneration) return Response.json({ error: { message: '模型无可用渠道' } }, { status: 503 })
    return Response.json({ data: [imageResponse] })
  })

  const post = (value: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const url = `/${project.id}`
  const list = async () => (await (await gallery.request(url)).json()).data
  async function settled(taskId: number, status = 'completed') {
    for (let attempt = 0; attempt < 150; attempt++) {
      const assets = await list()
      const asset = assets.find((row: any) => row.task?.id === taskId)
      if (asset?.task?.status !== 'processing') {
        assert.equal(asset?.task?.status, status, asset?.task?.error ?? '')
        return asset
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('图片生成超时')
  }
  const completed = (taskId: number) => settled(taskId)

  const options = (await (await gallery.request('/models')).json()).data
  assert.deepEqual(options.map((option: any) => option.model), [model, 'gpt-image-1'])
  for (const [kind, aspect, size] of [
    ['characters', '9:16', '1152x2048'], ['scenes', '16:9', '2048x1152'], ['props', '1:1', '1536x1536'],
  ]) {
    const prompt = `${kind} 原始提示词`
    const response = await gallery.request(url, post({ kind, name: kind, aspect, model, configId: config.id, prompt }))
    assert.equal(response.status, 201)
    const { id, name, taskId } = (await response.json()).data
    assert.equal(name, kind)
    const done = await completed(taskId)
    assert.equal(done.id, id)
    assert.equal(done.aspect, aspect)
    assert.equal(done.prompt, prompt)
    assert.equal(upstream.at(-1)?.size, size)
    assert.equal(upstream.at(-1)?.prompt, prompt)
    const metadata = await sharp(join(root, done.image)).metadata()
    const [w, h] = aspect.split(':').map(Number)
    assert.equal(metadata.width * h, metadata.height * w)
  }

  const original = (await list()).find((row: any) => row.kind === 'characters')
  const assetPath = `${url}/characters/${original.id}`
  let release!: () => void
  hold = new Promise<void>(resolve => { release = resolve })
  const redraw = { aspect: '1:1', model: 'gpt-image-1', configId: config.id, prompt: '新的角色提示词' }
  let nextTask: number
  try {
    const response = await gallery.request(`${assetPath}/generate`, post(redraw))
    assert.equal(response.status, 200)
    nextTask = (await response.json()).data.taskId
    const pending = (await list()).find((row: any) => row.task?.id === nextTask)
    assert.equal(pending.task.status, 'processing')
    assert.equal(pending.image, original.image)
    assert.equal((await gallery.request(assetPath, { method: 'DELETE' })).status, 409)
    const duplicate = await gallery.request(`${assetPath}/generate`, post(redraw))
    assert.equal((await duplicate.json()).data.taskId, nextTask)
    assert.equal((await gallery.request(`/${otherProject.id}/characters/${original.id}/generate`, post(redraw))).status, 404)
  } finally {
    release()
  }

  const regenerated = await completed(nextTask!)
  assert.notEqual(regenerated.image, original.image)
  assert.equal(regenerated.prompt, redraw.prompt)
  assert.equal(regenerated.model, redraw.model)
  assert.equal(upstream.length, 4)
  const beforeDelete = (await (await projects.request(url)).json()).data
  assert.equal(beforeDelete.characters[0].final_prompt, redraw.prompt)
  assert.equal((await gallery.request(assetPath, { method: 'DELETE' })).status, 200)
  assert.equal((await list()).length, 2)
  const afterDelete = (await (await projects.request(url)).json()).data
  assert.deepEqual(afterDelete.characters, [])
  assert.equal((await gallery.request(`${assetPath}/generate`, post(redraw))).status, 404)

  for (const [kind, name, prompt, expected] of [
    ['characters', undefined, '  林晚，穿红衣的年轻女侠。手握长剑。', '林晚，穿红衣的年轻女侠'],
    ['scenes', '  ', '  清晨的旧码头\n远处有一艘渔船', '清晨的旧码头'],
    ['props', '', '！！！', '未命名物品'],
  ] as const) {
    const response = await gallery.request(url, post({ kind, name, aspect: '16:9', model, configId: config.id, prompt }))
    assert.equal(response.status, 201)
    const result = (await response.json()).data
    assert.equal(result.name, expected)
    const saved = await completed(result.taskId)
    assert.equal(saved.name, expected)
    assert.equal(saved.prompt, prompt.trim())
  }
  assert.equal((await gallery.request(url, post({
    kind: 'characters', aspect: '16:9', model, configId: config.id, prompt: ' ',
  }))).status, 400)
  assert.equal((await gallery.request(url, post({
    kind: 'characters', name: 'a'.repeat(121), aspect: '16:9', model, configId: config.id, prompt: '人物',
  }))).status, 400)
  const { sql } = await import('drizzle-orm')
  db.run(sql.raw(`CREATE TRIGGER gallery_test_reject_task BEFORE INSERT ON sys_task
    BEGIN SELECT RAISE(ABORT, 'test queue rejection'); END`))
  try {
    const response = await gallery.request(url, post({
      kind: 'scenes', aspect: '16:9', model, configId: config.id, prompt: '夜晚的街口。'
    }))
    assert.equal(response.status, 201)
    const rejected = (await response.json()).data
    assert.equal(rejected.name, '夜晚的街口')
    assert.equal(rejected.taskId, null)
    assert.match(rejected.error, /test queue rejection/)
    assert.equal((await list()).find((asset: any) => asset.id === rejected.id && asset.kind === 'scenes')?.name, rejected.name)
  } finally {
    db.run(sql.raw('DROP TRIGGER gallery_test_reject_task'))
  }

  await t.test('回包已经带图时跳过下载，内嵌图损坏时仍能使用原图地址', async () => {
    const input = { kind: 'props', aspect: '16:9', model, configId: config.id, prompt: '一只猫' }
    imageResponse = { url: imageUrl, b64_json: encoded }
    interruptDownload = true
    const inline = (await (await gallery.request(url, post(input))).json()).data
    const first = await completed(inline.taskId)
    assert.equal(downloadCalls, 0)
    const metadata = await sharp(join(root, first.image)).metadata()
    assert.equal(metadata.width * 9, metadata.height * 16)

    imageResponse = { url: imageUrl, b64_json: Buffer.from('invalid image').toString('base64') }
    interruptDownload = false
    const fallback = (await (await gallery.request(url, post(input))).json()).data
    assert.ok((await completed(fallback.taskId)).image)
    assert.equal(downloadCalls, 1)
  })

  await t.test('取图中断后保存原结果地址，并只重试原图下载', async () => {
    const input = { kind: 'props', aspect: '16:9', model, configId: config.id, prompt: '一个茶杯' }
    imageResponse = { url: imageUrl }
    interruptDownload = true
    const result = (await (await gallery.request(url, post(input))).json()).data
    const pending = await settled(result.taskId, 'delivery_pending')
    assert.equal(pending.image, null)
    assert.equal(pending.task.canRetryDelivery, true)
    assert.match(pending.task.error, /下载超时/)
    const diagnostic = (await (await tasks.request(`/${result.taskId}/diagnostics`)).json()).data
    assert.equal(diagnostic.hasResult, true)
    assert.equal(diagnostic.hasLocalFile, false)

    interruptDownload = false
    const initialDownloads = downloadCalls
    const initialSubmissions = upstream.length
    let releaseDownload!: () => void
    hold = new Promise<void>(resolve => { releaseDownload = resolve })
    try {
      const recover = () => tasks.request(`/${result.taskId}/recover`, { method: 'POST' })
      const [first, second] = await Promise.all([recover(), recover()])
      assert.deepEqual([first.status, second.status], [200, 200])
      const downloading = (await list()).find((asset: any) => asset.task?.id === result.taskId)
      assert.equal(downloading.task.status, 'processing')
      assert.equal(downloading.task.stage, 'downloading')
    } finally {
      releaseDownload()
      hold = undefined
    }
    const restored = await completed(result.taskId)
    assert.ok(restored.image)
    assert.equal(restored.task.error, null)
    assert.equal(downloadCalls - initialDownloads, 1)
    assert.equal(upstream.length, initialSubmissions)
  })

  await t.test('重启后继续取图，历史结果不会覆盖后来保存的资产', async () => {
    const { resumeInterruptedTasks } = await import('../src/services/generation.js')
    const { eq } = await import('drizzle-orm')
    const asset = (await list()).find((row: any) => row.kind === 'props' && row.image)
    assert.ok(asset?.image)
    const older = db.insert(schema.sysTask).values({
      ...dates, type: 'image', dramaId: project.id, propId: asset.id, provider: 'openai', model,
      resultUrl: imageUrl, status: 'processing', stage: 'downloading',
    }).returning().get()
    const newer = db.insert(schema.sysTask).values({
      ...dates, type: 'image', dramaId: project.id, propId: asset.id, provider: 'openai', model,
      status: 'completed', localPath: asset.image,
    }).returning().get()
    const initialSubmissions = upstream.length
    await resumeInterruptedTasks()
    let recovered = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, older.id)).get()
    for (let attempt = 0; attempt < 100 && recovered?.status === 'processing'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
      recovered = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, older.id)).get()
    }
    assert.equal(recovered?.status, 'completed', recovered?.errorMsg ?? '')
    assert.ok(recovered.localPath)
    assert.notEqual(recovered.localPath, asset.image)
    assert.equal((await completed(newer.id)).image, asset.image)
    assert.equal(upstream.length, initialSubmissions)
  })

  await t.test('上游明确拒绝生成时仍显示失败', async () => {
    rejectGeneration = true
    const rejected = (await (await gallery.request(url, post({
      kind: 'props', aspect: '16:9', model, configId: config.id, prompt: '一个花瓶',
    }))).json()).data
    const asset = await settled(rejected.taskId, 'failed')
    assert.equal(asset.task.canRetryDelivery, false)
    assert.match(asset.task.error, /503.*模型无可用渠道/)
    rejectGeneration = false
  })
})
