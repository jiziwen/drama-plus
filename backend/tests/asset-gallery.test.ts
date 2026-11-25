import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

test('画廊创建项目资产，按所选比例生成和重绘，并从项目中删除', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asset-gallery-'))
  process.env.SQLITE_PATH = join(root, 'gallery.sqlite3')
  process.env.HUOBAO_DATA_DIR = root
  t.after(() => rm(root, { recursive: true, force: true }))

  const [{ default: gallery }, { default: projects }, { db, schema }] = await Promise.all([
    import('../src/routes/asset-gallery.js'), import('../src/routes/dramas.js'), import('../src/db/index.js'),
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
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    upstream.push(JSON.parse(String(init?.body)))
    await hold
    return Response.json({ data: [{ b64_json: output.toString('base64') }] })
  })

  const post = (value: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const url = `/${project.id}`
  const list = async () => (await (await gallery.request(url)).json()).data
  async function completed(taskId: number) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const assets = await list()
      const asset = assets.find((row: any) => row.task?.id === taskId)
      if (asset?.task?.status !== 'processing') {
        assert.equal(asset?.task?.status, 'completed', asset?.task?.error ?? '')
        return asset
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail('图片生成超时')
  }

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
})
