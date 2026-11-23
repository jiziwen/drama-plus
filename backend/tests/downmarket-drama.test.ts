import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { DramaChapter, DownmarketDrama, DramaCommand, DramaModelSelection } from '../src/services/downmarket-drama-types.js'
import { DRAMA_REFERENCE_UPLOAD_BYTES } from '../src/services/downmarket-drama-types.js'
import { analyzeDramaReference, dramaReferenceBudgets } from '../src/services/downmarket-drama-reference.js'

test('逐章写作、修订确认、单图资产和幂等制作交接', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'downmarket-drama-'))
  const oldPath = process.env.SQLITE_PATH
  process.env.SQLITE_PATH = join(dir, 'app.sqlite3')
  const [{ createDownmarketDramaRoutes }, { ScriptVideoStore }, { db, schema }, { eq }] = await Promise.all([
    import('../src/routes/downmarket-drama.js'), import('../src/services/script-video-store.js'),
    import('../src/db/index.js'), import('drizzle-orm'),
  ])
  const store = new ScriptVideoStore(join(dir, 'video'))
  t.after(async () => {
    await store.close()
    if (oldPath === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = oldPath
    await rm(dir, { recursive: true, force: true })
  })
  const chapter = (title: string): DramaChapter => ({
    title, text: '## S01 | 内景 · 账房 | 日\n\n周岚（拍桌、焦急）：把账给我。', summary: title + '经过',
    continuity: '账本留在方桌上。', dialogueNotes: '短句制造交锋。',
  })
  const outline = {
    title: '清账', world: '老街商会凭票据结算。', characters: '周岚要查账，商会要保住声誉。',
    chapters: [{ title: '交账', plan: '周岚夺回账本。' }, { title: '还账', plan: '商会交出原票。' }],
  }
  let holding = false
  let writes = 0
  let imageTask: number | undefined
  let batchImages = 0
  let lastTextModel: DramaModelSelection | undefined
  const analyzedSlices: string[] = []
  const timestamp = new Date().toISOString()
  for (const config of [
    { id: 21, serviceType: 'text', model: '["same-writer"]', name: '文字服务一' },
    { id: 22, serviceType: 'text', model: '["same-writer"]', name: '文字服务二' },
    { id: 23, serviceType: 'image', model: '["image-first", "image-picked"]', name: '生图服务' },
    { id: 24, serviceType: 'image', model: '["image-off"]', name: '停用服务', isActive: false },
  ]) {
    db.insert(schema.aiServiceConfigs).values({
      ...config, provider: 'openai', baseUrl: 'http://localhost:9000', apiKey: 'fake-test-only', createdAt: timestamp, updatedAt: timestamp,
    }).run()
  }
  const app = createDownmarketDramaRoutes(store, {
    createTextRunner: async selection => async ({ instructions, message, signal }) => {
      lastTextModel = selection
      const data = JSON.parse(message)
      if (holding) await delay(10_000, null, { signal })
      if (instructions.includes('同一对标文的连续片段')) {
        analyzedSlices.push(data.reference)
        return JSON.stringify({ notes: '分段笔记 ' + data.number })
      }
      if (instructions.includes('三个原创故事')) return JSON.stringify({
        analysis: '开场矛盾明确。', pitches: ['账房', '旧店', '街市'].map(title => ({
          title, conflict: '争账本。', premise: '查清旧账。', hook: '凭票人失踪。',
        })),
      })
      if (instructions.includes('建立故事规则')) return JSON.stringify({ world: outline.world, characters: outline.characters })
      if (instructions.includes('章大纲，规划约')) return JSON.stringify(outline)
      if (instructions.includes('沿用前文人物现状')) {
        writes++
        if (data.chapter === 2) {
          assert.equal(data.previous[0].continuity, '账本留在方桌上。')
          assert.match(data.previousEnding, /把账给我/u)
        }
        return JSON.stringify(chapter(data.currentPlan.title))
      }
      if (instructions.includes('审核正文是否违背')) return JSON.stringify({ revise: false, notes: '通过。' })
      if (instructions.includes('查时间')) return JSON.stringify({ verdict: '一处证据需要交代。', issues: [{ chapter: 1, problem: '未提凭票。', fix: '周岚出示凭票。' }] })
      if (instructions.includes('三个原创解说式')) return JSON.stringify({ options: ['欠条', '凭票', '账本'].map(title => ({ title, text: '旁白（紧张、低声）：账本被锁在门里。' })) })
      if (instructions.includes('逐场判断')) return JSON.stringify({ needsEdit: true, plan: '进入账房后直接亮凭票。' })
      if (instructions.includes('按已经确认')) {
        assert.match(data.approvedChanges.openingText, /亲手改/u)
        return JSON.stringify(chapter('修订后交账'))
      }
      if (instructions.includes('提取真实出现')) return JSON.stringify({ assets: [
        { kind: 'character', name: '周岚', prompt: '二十七岁，深蓝棉布夹克。' },
        { kind: 'character', name: '周 岚', prompt: '重复人物。' },
        { kind: 'scene', name: '账房', prompt: '木方桌与账柜。' },
      ] })
      assert.fail('unexpected text step')
    },
    resolveImageConfig: async selection => {
      assert.deepEqual(selection, { configId: 23, model: 'image-picked' })
      return { id: selection.configId, model: selection.model }
    },
    generateImage: async params => {
      assert.equal(params.size, '2048x1152')
      assert.equal(params.requireLandscape16x9, true)
      const timestamp = new Date().toISOString()
      assert.equal(params.configId, 23)
      assert.equal(params.model, 'image-picked')
      if (!params.referenceImages) {
        assert.match(params.prompt, /一张16:9横屏图.*账房/u)
        batchImages++
        return db.insert(schema.sysTask).values({
          type: 'image', status: 'completed', localPath: 'static/images/scene.png', createdAt: timestamp, updatedAt: timestamp,
        }).returning({ id: schema.sysTask.id }).get().id
      }
      assert.match(params.prompt, /一张16:9横屏图.*周岚/u)
      assert.match(params.prompt, /四张完整全身视图/u)
      assert.deepEqual(params.referenceImages, ['/static/uploads/reference.png'])
      assert.equal(imageTask, undefined, '同一个资产的运行任务不应重复提交')
      imageTask = db.insert(schema.sysTask).values({
        type: 'image', status: 'processing', createdAt: timestamp, updatedAt: timestamp,
      }).returning({ id: schema.sysTask.id }).get().id
      return imageTask
    },
  })
  const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
  const created = await app.request('/', json({ title: '写剧本测试' }))
  assert.equal(created.status, 201)
  let state: DownmarketDrama = (await created.json()).data
  assert.equal(state.brief.chapterCount, 15)
  assert.equal(state.brief.runtimeMinutes, 65)
  const catalog = (await (await app.request('/models')).json()).data
  assert.deepEqual(catalog, [
    { kind: 'text', configId: 21, model: 'same-writer', configName: '文字服务一' },
    { kind: 'text', configId: 22, model: 'same-writer', configName: '文字服务二' },
    { kind: 'image', configId: 23, model: 'image-first', configName: '生图服务' },
    { kind: 'image', configId: 23, model: 'image-picked', configName: '生图服务' },
  ])
  const projectPath = '/' + state.id
  const submit = (input: DramaCommand, revision = state.revision) => app.request(projectPath + '/commands', json({ revision, command: input }))
  async function load() {
    const response = await app.request(projectPath)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
    return (await response.json()).data as DownmarketDrama
  }
  async function command(input: DramaCommand, expected = 200) {
    const response = await submit(input)
    const body = await response.json()
    assert.equal(response.status, expected, body.message)
    if (expected === 200) state = body.data
  }
  async function finished() {
    for (let i = 0; i < 50; i++) {
      state = await load()
      if (state.job?.status !== 'running') break
      await delay(15)
    }
    assert.equal(state.job?.status, 'done', state.job?.error)
  }

  await command({ action: 'write' }, 400)
  await command({ action: 'saveBrief', brief: { ...state.brief, reference: '一张旧票牵出欠账。', chapterCount: 2 } })
  const stale = state.revision
  holding = true
  await command({ action: 'analyze' })
  assert.equal((await app.request(projectPath, { method: 'DELETE' })).status, 409)
  assert.equal((await submit({ action: 'analyze' }, stale)).status, 409)
  assert.equal((await load()).job?.status, 'running')
  await command({ action: 'stop' })
  assert.equal(state.job?.status, 'failed')
  holding = false
  await command({ action: 'analyze' })
  await finished()
  assert.equal(lastTextModel, undefined, '已有项目默认使用全局文字模型')
  assert.equal(state.pitches?.length, 3)
  await command({ action: 'selectModel', kind: 'text', selection: { configId: 23, model: 'image-picked' } }, 400)
  await command({ action: 'selectModel', kind: 'image', selection: { configId: 24, model: 'image-off' } }, 400)
  await command({ action: 'selectModel', kind: 'image', selection: { configId: 23, model: 'missing' } }, 400)
  await command({ action: 'selectModel', kind: 'text', selection: { configId: 22, model: 'same-writer' } })
  await command({ action: 'selectModel', kind: 'image', selection: { configId: 23, model: 'image-picked' } })
  assert.deepEqual((await load()).models, {
    text: { configId: 22, model: 'same-writer' }, image: { configId: 23, model: 'image-picked' },
  })
  await command({ action: 'outline', pitch: 0 })
  await finished()
  assert.deepEqual(lastTextModel, { configId: 22, model: 'same-writer' })
  assert.equal(state.outline?.title, '清账')
  await command({ action: 'confirmOutline', outline: { ...outline, chapters: outline.chapters.slice(0, 1) } }, 400)
  await command({ action: 'confirmOutline', outline })
  await command({ action: 'write' })
  await finished()
  assert.equal(writes, 1)
  assert.equal(state.chapters.length, 1)
  await command({ action: 'finalize' }, 400)
  await command({ action: 'write' })
  await finished()
  assert.equal(state.chapters.length, 2)

  await command({ action: 'logic' })
  await finished()
  assert.equal(state.logic?.issues[0]?.chapter, 1)
  await command({ action: 'opening', mode: 'narrated', reference: '一条对标开头。' })
  await finished()
  await command({ action: 'pace', chapter: 1 })
  await finished()
  assert.equal(state.pacing[1].needsEdit, true)
  await command({ action: 'revise', chapter: 1, source: 'opening', notes: '亲手改过的旁白。' })
  await finished()
  assert.equal(state.chapters[0].title, '交账')
  assert.equal(state.candidate?.content.title, '修订后交账')
  await command({ action: 'finalize' }, 400)
  await command({ action: 'saveChapter', chapter: 1, content: state.candidate!.content })
  await command({ action: 'finalize' })
  await command({ action: 'assets' })
  await finished()
  assert.deepEqual(state.assets.map(item => item.name), ['周岚', '账房'])
  const image = { action: 'image' as const, assetId: state.assets[0].id, prompt: '蓝衣角色。', reference: '/static/uploads/reference.png' }
  await command(image)
  await finished()
  await command(image, 400)
  await command({ action: 'deliver', allowMissingImages: true }, 400)
  db.update(schema.sysTask).set({ status: 'completed', localPath: 'static/images/character.png' }).where(eq(schema.sysTask.id, imageTask!)).run()
  state = await load()
  assert.equal(state.assets[0].image, '/static/images/character.png')
  await command({ action: 'deliver', allowMissingImages: false }, 400)
  await command({ action: 'deliver', allowMissingImages: true })
  await finished()
  const original = state.delivery!
  const imported = await store.get(original.projectId)
  assert.deepEqual(imported.episodes.map(ep => ep.title), ['修订后交账', '还账'])
  assert.equal(original.episodeId, imported.episodes[0].id)
  assert.equal(imported.episodes[1].script, state.chapters[1].text)
  assert.equal(imported.assets[0].image, '/static/images/character.png')
  await command({ action: 'deliver', allowMissingImages: true })
  await finished()
  assert.deepEqual(state.delivery, original)
  assert.equal((await store.listSummaries()).length, 1)

  await command({ action: 'images' })
  await finished()
  assert.equal(batchImages, 1)
  assert.equal(state.assets[1].image, '/static/images/scene.png')
  assert.equal(state.delivery, undefined)
  await command({ action: 'images' }, 400)

  await command({ action: 'selectModel', kind: 'image', selection: null })
  assert.equal((await load()).models?.image, undefined)
  assert.equal(state.finalized, true)
  await command({ action: 'saveChapter', chapter: 2, content: { ...state.chapters[1], title: '手动修改' } })
  assert.equal(state.finalized, false)
  assert.equal(state.assetsCurrent, false)
  assert.equal(state.delivery, undefined)
  await command({ action: 'deliver', allowMissingImages: true }, 400)

  const large = (await (await app.request('/', json({ title: '长文测试' }))).json()).data as DownmarketDrama
  const longReference = '第一章 来客\n\n' + '屋外站着前来索债的客人，账房不肯交出票据。\n'.repeat(20_000) + '最后一章 对账落幕。\n'
  const file = new File([longReference], '全本对标.md', { type: 'text/markdown' })
  assert.ok(file.size > 750_000)
  async function upload(revision: number, content = file) {
    const form = new FormData()
    form.set('file', content)
    form.set('revision', String(revision))
    return app.request('/' + large.id + '/reference', { method: 'PUT', body: form })
  }
  const result = await upload(large.revision)
  assert.equal(result.status, 200)
  const payload = await result.text()
  assert.ok(payload.length < 10_000, '项目接口仅返回预览和元数据')
  assert.ok(!payload.includes('对账落幕'))
  let importedReference = JSON.parse(payload).data as DownmarketDrama
  assert.equal(importedReference.brief.reference, '')
  assert.equal(importedReference.referenceFile?.characters, longReference.length)
  assert.equal(importedReference.referenceFile?.bytes, file.size)
  assert.equal((await upload(large.revision)).status, 409)
  assert.equal((await upload(importedReference.revision, new File(['\0'], '坏文件.txt'))).status, 400)
  assert.equal((await upload(importedReference.revision, new File([new Uint8Array(DRAMA_REFERENCE_UPLOAD_BYTES + 1)], '超限.txt'))).status, 413)
  const getLarge = async () => (await (await app.request('/' + large.id)).json()).data as DownmarketDrama
  const commandLarge = (input: DramaCommand) => app.request('/' + large.id + '/commands',
    json({ revision: importedReference.revision, command: input }))
  const saving = await commandLarge({ action: 'saveBrief', brief: { ...importedReference.brief, direction: '原创改成海边小镇。' } })
  assert.equal(saving.status, 200)
  importedReference = await getLarge()
  const analyzing = await commandLarge({ action: 'analyze' })
  assert.equal(analyzing.status, 200)
  for (let tries = 0; tries < 100; tries++) {
    importedReference = await getLarge()
    if (importedReference.job?.status !== 'running') break
    await delay(15)
  }
  assert.equal(importedReference.job?.status, 'done', importedReference.job?.error)
  assert.equal(importedReference.pitches?.length, 3)
  assert.ok(analyzedSlices.length > 1)
  assert.equal(analyzedSlices.join(''), longReference, '每段按原顺序拼接时保留整份原文')
  assert.equal((await commandLarge({ action: 'clearReference' })).status, 200)
  assert.equal((await getLarge()).referenceFile, undefined)
  assert.equal((await getLarge()).pitches, undefined)
  const smallForm = new FormData()
  smallForm.set('revision', String((await getLarge()).revision))
  smallForm.set('file', new File([new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])], '短文.txt'))
  const small = await app.request('/' + large.id + '/reference', { method: 'PUT', body: smallForm })
  assert.equal(small.status, 200)
  assert.equal((await small.json()).data.brief.reference, '中文', '小文件依然可以直接在项目中编辑')

  assert.equal((await upload((await getLarge()).revision)).status, 200)
  const uploadedReference = () => db.select({ id: schema.downmarketDramaReferences.dramaId })
    .from(schema.downmarketDramaReferences).where(eq(schema.downmarketDramaReferences.dramaId, large.id)).get()
  assert.ok(uploadedReference())
  assert.equal((await app.request('/' + large.id, { method: 'DELETE' })).status, 200)
  assert.equal(uploadedReference(), undefined)
  assert.equal((await app.request('/' + large.id)).status, 404)
  assert.deepEqual((await (await app.request('/')).json()).data.map((item: DownmarketDrama) => item.id), [state.id])

  assert.equal((await app.request(projectPath, { method: 'DELETE' })).status, 200)
  assert.equal((await app.request(projectPath)).status, 404)
  assert.equal((await app.request(projectPath, { method: 'DELETE' })).status, 404)
  assert.equal((await store.get(original.projectId)).episodes[0].id, original.episodeId)
})

test('整篇优先，网关拒绝上下文后缩小批次且保留所有段落', async () => {
  const source = Array.from({ length: 1_200 }, (_, index) => `第${index + 1}段 😀 两人终于回到了码头。\n\n`).join('')
  const budget = dramaReferenceBudgets({ maxInputTokens: 475_000, contextWindow: 500_000 }, '').source
  const handled: string[] = []
  let wholeCalls = 0
  let attempts = 0
  let merged = 0
  const reject = () => Object.assign(new Error('gateway rejected request'), {
    cause: { statusCode: 400, responseBody: '{"error":{"code":"context_length_exceeded"}}' },
  })
  const result = await analyzeDramaReference(source, budget, new AbortController().signal, {
    whole: async text => { wholeCalls++; assert.equal(text, source); throw reject() },
    slice: async part => {
      attempts++
      if (part.text.length > 5_000) throw reject()
      assert.ok(!/[\uD800-\uDBFF]$/u.test(part.text))
      assert.equal(part.number, handled.length + 1)
      handled.push(part.text)
      return '本段冲突。'.repeat(280)
    },
    merge: async digests => {
      merged++
      assert.ok(digests.every((entry, index) => !index || digests[index - 1]!.last + 1 === entry.first))
      return '合并后的结构笔记。'
    },
    finish: async digests => {
      assert.equal(digests[0]?.first, 1)
      assert.equal(digests.at(-1)?.last, handled.length)
      return '选题已生成'
    },
  })
  assert.equal(result, '选题已生成')
  assert.equal(wholeCalls, 1)
  assert.ok(attempts > handled.length && handled.length > 1)
  assert.ok(merged > 0)
  assert.equal(handled.join(''), source)
})

test('容量充足时只发原文，普通服务错误直接返回', async () => {
  let maps = 0
  const steps = {
    whole: async (reference: string) => reference,
    slice: async () => { maps++; return '' },
    merge: async () => '',
    finish: async () => '',
  }
  const signal = new AbortController().signal
  assert.equal(await analyzeDramaReference('前后完整的原文。', 300_000, signal, steps), '前后完整的原文。')
  await assert.rejects(analyzeDramaReference('正常文案', 300_000, signal, {
    ...steps, whole: async () => { throw Object.assign(new Error('invalid API key'), { statusCode: 401 }) },
  }), /invalid API key/)
  assert.equal(maps, 0)
})
