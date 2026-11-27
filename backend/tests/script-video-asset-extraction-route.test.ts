import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Hono } from 'hono'
import { registerScriptVideoAssetExtractionRoutes } from '../src/routes/script-video-asset-extraction.js'
import { extractScriptVideoAssets } from '../src/services/script-video-asset-extraction.js'
import { mergeScriptVideoProjectVoices, type ScriptVideoVoiceAssignment, type ScriptVideoVoiceProfile } from '../src/services/script-video-project-voices.js'
import { ScriptVideoStore, ScriptVideoStoreError } from '../src/services/script-video-store.js'

test('一键提取把场景四宫格写入项目资产，保留已有角色的编辑和跨集来源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-asset-extract-'))
  const store = new ScriptVideoStore(directory)
  try {
    const style = { id: `custom-${randomUUID()}` as const, name: '水墨动画', prefix: '宣纸纹理、淡墨层次。' }
    const project = await store.create('整剧', style)
    const app = new Hono()
    const gate = Promise.withResolvers<void>()
    let calls = 0
    await store.mutateAssets(project.id, () => ({ assets: [{
      id: 'role', kind: 'character', name: '林医生', image: '/static/uploads/role.png', imagePrompt: '初版',
      occurrences: [{ label: '林医生', quote: '林医生入场。', sourceTitle: '第1集', episodeNumber: 1, offset: 0 }],
    }], result: undefined }))
    registerScriptVideoAssetExtractionRoutes(app, store,
      (c, error) => c.json({ message: String(error) }, error instanceof ScriptVideoStoreError ? error.status : 500),
      async input => {
        calls++
        assert.deepEqual(input.sources.map(source => source.episodeNumber), [1, 2])
        await gate.promise
        return extractScriptVideoAssets(input, async ({ message }) => {
          const { episode, style: extractionStyle } = JSON.parse(message)
          assert.equal(extractionStyle, style.prefix)
          const role = {
            reuseId: 'existing-role', kind: 'character', name: '林青', assetIdentity: '林青', aliases: ['小林'],
            imagePrompt: '模型版',
            occurrences: [episode === 1 ? { label: '林医生', quote: '林医生入场。' } : { label: '林青', quote: '林青走进医院诊室。' }],
          }
          const scene = {
            kind: 'scene', name: '医院诊室', assetIdentity: '医院诊室',
            imagePrompt: [
              '[0.画风与光影] 电影级广角空场。',
              '[1.空间档案] 医院诊室。',
              '[2.建筑骨架] 一扇半开的白门，入口通向诊桌。',
              '[3.五方十字坐标陈设] 前方是白门，后方是诊桌。',
              '[4.光影与色彩] 室内冷白光。',
            ].join('\n'),
          }
          return JSON.stringify({ assets: episode === 2 ? [role, scene] : [role] })
        })
      },
    )
    const path = `/projects/${project.id}/assets/extract`
    const secondScript = '场次：2-01\n场景：医院诊室\n林青走进医院诊室。'
    const post = () => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      sources: [{ title: '第1集', script: '林医生入场。', episodeNumber: 1 }, { title: '第2集', script: secondScript, episodeNumber: 2 }],
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
    assert.deepEqual(role.occurrences, [
      { label: '林医生', quote: '林医生入场。', sourceTitle: '第1集', episodeNumber: 1, offset: 0 },
      { label: '林青', quote: '林青走进医院诊室。', sourceTitle: '第2集', episodeNumber: 2, offset: secondScript.indexOf('林青'), sceneId: '2-01', sceneTitle: '医院诊室' },
    ])
    assert.ok(role.aliases.includes('林青'))
    assert.equal(scene.image, '')
    assert.equal(scene.imageStatus, 'pending')
    assert.match(scene.imagePrompt, /广角空场/u)
    assert.match(scene.imagePrompt, /\[5\.四宫格多机位排版\]/u)
    assert.match(scene.imagePrompt, /左上【医院诊室-正视（朝内）】/u)
    assert.equal((await store.get(project.id)).episodes.length, 1)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('跨集提取合并声音字段，重提取继续复用已保存的音色', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-extract-voices-'))
  const store = new ScriptVideoStore(directory)
  try {
    const project = await store.create('阿宁的故事')
    const app = new Hono()
    const sources = [
      { title: '第1集', script: '成年阿宁声音低沉。', episodeNumber: 1 },
      { title: '第2集', script: '成年阿宁咬字利落。', episodeNumber: 2 },
      { title: '第3集', script: '童年阿宁嗓音清亮。', episodeNumber: 3 },
    ]
    let calls = 0
    let revision = false
    registerScriptVideoAssetExtractionRoutes(app, store,
      (c, error) => c.json({ message: String(error) }, error instanceof ScriptVideoStoreError ? error.status : 500),
      input => extractScriptVideoAssets(input, async ({ message }) => {
        calls++
        const { episode, script } = JSON.parse(message)
        const costume = episode === 1 ? '常服' : episode === 2 ? '礼服' : '年幼'
        const voice = { character: '阿宁', age: { stage: episode === 3 ? 'child' : 'adult', quote: script },
          clues: [{ facet: episode === 2 ? 'articulation' : 'timbre', source: 'explicit', quote: script,
            value: episode === 1 ? (revision ? '声音沙哑' : '声音低沉') : episode === 2 ? '咬字利落' : '嗓音清亮' }] }
        return JSON.stringify({ assets: [{ kind: 'character', name: `阿宁_${costume}`, assetIdentity: `阿宁｜${costume}`,
          imagePrompt: '阿宁的角色设计', voice }] })
      }),
    )
    const path = `/projects/${project.id}/assets/extract`
    const extract = async () => {
      const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources }) })
      assert.equal(response.status, 201)
      for (let attempt = 0; attempt < 100; attempt++) {
        const job = (await (await app.request(path)).json()).data
        if (job.status !== 'running') {
          assert.equal(job.status, 'completed', job.error)
          return (await store.summary(project.id)).assets
        }
        await pause(10)
      }
      throw new Error('资产提取没有结束')
    }
    const [daily, formal, child] = await extract()
    assert.equal(calls, 3)
    assert.equal(daily.voiceProfile.id, formal.voiceProfile.id)
    assert.equal(child.voiceProfile.ageStage, 'child')
    assert.notEqual(child.voiceProfile.id, daily.voiceProfile.id)
    assert.deepEqual(daily.voiceDescription, formal.voiceDescription)
    assert.equal(daily.observedVoiceAge, undefined)
    assert.equal(daily.voiceDescription.sourceLabel, '剧本提取')
    assert.match(daily.voiceDescription.text, /声音低沉/u)
    assert.match(daily.voiceDescription.text, /咬字利落/u)
    assert.equal(child.voiceDescription.text, '儿童年龄感｜嗓音清亮｜自然说话，咬字清楚｜中等音量｜正常语速｜中文普通话')

    const audio = { url: '/static/uploads/ning.mp3', name: '确认的声音' }
    const description = { text: '确认的成年音色', sourceLabel: '手动编辑' }
    await store.mutateAssets(project.id, assets => ({ assets: assets.map(asset => [daily.id, formal.id].includes(asset.id)
      ? { ...asset, voiceAudio: audio, voiceDescription: description } : asset), result: undefined }))
    revision = true
    const [again] = await extract()
    assert.equal(calls, 6)
    assert.equal(again.id, daily.id)
    assert.equal(again.voiceProfile.id, daily.voiceProfile.id)
    assert.deepEqual(again.voiceAudio, audio)
    assert.deepEqual(again.voiceDescription, description)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('一键提取为方闲补齐六段描述，分别保存男女易装的声线并保留已有媒体', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-extract-voice-design-'))
  const store = new ScriptVideoStore(directory)
  try {
    const project = await store.create('方闲的故事')
    const app = new Hono()
    const audio = { url: '/static/uploads/fang-xian.mp3', name: '方闲的参考音频' }
    const previousProfile = { id: randomUUID(), key: '方闲:unknown', character: '方闲', ageStage: 'unknown' as const, clues: [], conflicts: [] }
    await store.mutateAssets(project.id, () => ({
      assets: [
        { id: 'fang-xian', kind: 'character', name: '方闲', image: '/static/uploads/fang-xian.png', voiceAudio: audio,
          voiceProfile: previousProfile },
        { id: 'fang-xian-disguise', kind: 'character', name: '方闲（男扮女装）', assetIdentity: '方闲｜男扮女装',
          image: '/static/uploads/disguise.png', voiceAudio: audio, voiceProfile: previousProfile,
          voiceDescription: { text: '此前从常态造型继承的描述', sourceLabel: '剧本提取' } },
      ],
      result: undefined,
    }))
    const design = { ageFeel: '青年年龄感', timbre: '清朗青年男声，中低音区、略带松弛感',
      delivery: '清冷克制，措辞端正，句尾收稳', volume: '中等音量', pace: '正常语速', accent: '中文普通话' }
    registerScriptVideoAssetExtractionRoutes(app, store,
      (c, error) => c.json({ message: String(error) }, error instanceof ScriptVideoStoreError ? error.status : 500),
      input => extractScriptVideoAssets(input, async () => JSON.stringify({ assets: [
        { kind: 'character', name: '方闲', assetIdentity: '方闲', imagePrompt: '青年剑修', reuseId: 'existing-fang-xian',
          voice: { character: '方闲', design } },
        { kind: 'character', name: '方闲（礼服）', assetIdentity: '方闲｜礼服', imagePrompt: '青年剑修的礼服' },
        { kind: 'character', name: '陆掌柜', assetIdentity: '陆掌柜', imagePrompt: '镇上掌柜' },
        { kind: 'character', name: '方闲（男扮女装）', assetIdentity: '方闲｜男扮女装', imagePrompt: '女客装束',
          voice: { character: '方闲', design: { ...design, timbre: '清亮女声，尾音轻柔' } } },
        { kind: 'character', name: '云娘', assetIdentity: '云娘', imagePrompt: '青年女客',
          voice: { character: '云娘', design: { ...design, timbre: '清亮女声' } } },
        { kind: 'character', name: '云娘', assetIdentity: '云娘', imagePrompt: '扮作少年',
          voice: { character: '云娘', disguise: 'female_as_male', design: { ...design, timbre: '清润少年男声' } } },
        { kind: 'prop', name: '账簿', assetIdentity: '账簿', imagePrompt: '蓝布封面账簿' },
      ] })),
    )
    const path = `/projects/${project.id}/assets/extract`
    const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sources: [{ title: '第1集',
        script: '方闲走进客店，把账簿交给陆掌柜。方闲换上礼服。方闲男扮女装赴宴，云娘女扮男装作陪。', episodeNumber: 1 }] }) })
    assert.equal(response.status, 201)
    let job = (await (await app.request(path)).json()).data
    for (let attempt = 0; job.status === 'running' && attempt < 100; attempt++) {
      await pause(10)
      job = (await (await app.request(path)).json()).data
    }
    assert.equal(job.status, 'completed', job.error)
    const assets = (await store.summary(project.id)).assets
    const lead = assets.find(asset => asset.id === 'fang-xian')!
    const costume = assets.find(asset => asset.name === '方闲（礼服）')!
    assert.deepEqual(lead.voiceAudio, audio)
    assert.equal(lead.image, '/static/uploads/fang-xian.png')
    assert.equal(lead.voiceProfile?.ageStage, 'unknown')
    assert.deepEqual(lead.voiceProfile?.clues, [])
    assert.equal(lead.voiceDescription?.text, '青年年龄感｜清朗青年男声，中低音区、略带松弛感｜清冷克制，措辞端正，句尾收稳｜中等音量｜正常语速｜中文普通话')
    assert.deepEqual(costume.voiceDescription, lead.voiceDescription)
    assert.equal(costume.voiceProfile?.id, lead.voiceProfile?.id)
    const disguisedLead = assets.find(asset => asset.id === 'fang-xian-disguise')!
    const disguisedYun = assets.find(asset => asset.name === '云娘（女扮男装）')!
    const yun = assets.find(asset => asset.name === '云娘')!
    assert.equal(disguisedLead.voiceProfile?.disguise, 'male_as_female')
    assert.notEqual(disguisedLead.voiceProfile?.id, lead.voiceProfile?.id)
    assert.equal(disguisedLead.voiceDescription?.text.split('｜')[1], '清亮女声，尾音轻柔')
    assert.deepEqual(disguisedLead.voiceAudio, audio)
    assert.equal(disguisedYun.voiceProfile?.disguise, 'female_as_male')
    assert.notEqual(disguisedYun.voiceProfile?.id, yun.voiceProfile?.id)
    assert.equal(disguisedYun.voiceDescription?.text.split('｜')[1], '清润少年男声')
    assert.equal(yun.voiceDescription?.text.split('｜')[1], '清亮女声')
    assert.equal(assets.find(asset => asset.name === '陆掌柜')?.voiceDescription?.text.split('｜').length, 6)
    assert.equal(assets.find(asset => asset.name === '账簿')?.voiceDescription, undefined)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('同一张角色卡后来明确年龄时保留已生成音色和档案 ID', () => {
  const previous: ScriptVideoVoiceProfile = { id: randomUUID(), key: '阿宁:unknown', character: '阿宁', ageStage: 'unknown',
    clues: [], conflicts: [], generatedOutputId: randomUUID() }
  const audio = { url: `/static/uploads/${previous.generatedOutputId}.mp3`, name: '阿宁试音' }
  const description = { text: '已确认的常态声音', sourceLabel: '剧本提取' }
  const baseline = { key: previous.key, character: previous.character, ageStage: 'unknown' as const, clues: [], conflicts: [] }
  const adult = { ...baseline, key: '阿宁:adult', ageStage: 'adult' as const }
  const child = { ...baseline, key: '阿宁:child', ageStage: 'child' as const }
  const assets = [
    { id: 'daily', kind: 'character', voiceProfile: previous, voiceAudio: audio, voiceDescription: description },
    { id: 'formal', kind: 'character' },
    { id: 'child', kind: 'character' },
  ]
  const proposals = new Map<string, ScriptVideoVoiceAssignment>([
    ['daily', { draft: adult, observedAge: 'adult' }],
    ['formal', { draft: baseline }],
    ['child', { draft: child, observedAge: 'child' }],
  ])
  const [daily, formal, childhood] = mergeScriptVideoProjectVoices(assets, proposals)
  for (const variant of [daily, formal]) {
    assert.equal(variant.voiceProfile?.id, previous.id)
    assert.equal(variant.voiceProfile?.ageStage, 'adult')
    assert.equal(variant.voiceProfile?.generatedOutputId, previous.generatedOutputId)
    assert.deepEqual(variant.voiceDescription, description)
    assert.deepEqual(variant.voiceAudio, audio)
  }
  assert.equal(childhood.voiceProfile?.ageStage, 'child')
  assert.notEqual(childhood.voiceProfile?.id, previous.id)
  assert.equal(childhood.voiceAudio, undefined)
})

test('结果未收到时保留断点并提示可能计费，手动续提才请求未完成的分段', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-extract-resume-'))
  let store = new ScriptVideoStore(directory)
  const calls: [number, string | undefined][] = []
  const sources = [1, 2, 3].map(episodeNumber => ({ title: `第 ${episodeNumber} 集`, episodeNumber, script: `角色${episodeNumber}登场。` }))
  function makeApp() {
    const app = new Hono()
    registerScriptVideoAssetExtractionRoutes(app, store,
      (c, error) => c.json({ message: String(error) }, error instanceof ScriptVideoStoreError ? error.status : 500),
      input => extractScriptVideoAssets(input, async ({ message }) => {
        const { episode } = JSON.parse(message)
        calls.push([episode, input.model])
        if (episode === 2 && input.model === 'before') throw new Error('Cannot connect to API: other side closed', {
          cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
        })
        return JSON.stringify({ assets: [{ kind: 'character', name: `角色${episode}`, assetIdentity: `角色${episode}`, imagePrompt: '角色生图' }] })
      }),
    )
    return app
  }
  const post = (app: Hono, route: string, body: unknown) => app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  async function waitForJob(app: Hono, route: string) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const job = (await (await app.request(route)).json()).data
      if (job?.status !== 'running') return job
      await pause(10)
    }
    throw new Error('没有读到提取结果')
  }
  try {
    const project = await store.create('提取断点')
    const route = `/projects/${project.id}/assets/extract`
    let app = makeApp()
    const started = await post(app, route, { sources, model: 'before' })
    assert.equal(started.status, 201)
    const { id } = (await started.json()).data
    const failed = await waitForJob(app, route)
    assert.deepEqual([failed.status, failed.completed, failed.total], ['failed', 1, 3], failed.error)
    assert.match(failed.error, /上游可能已完成并计费.*继续提取.*重新请求/u)
    assert.deepEqual(calls, [[1, 'before'], [2, 'before']])
    await store.close()
    store = new ScriptVideoStore(directory)
    app = makeApp()
    const restored = await waitForJob(app, route)
    assert.equal(restored?.id, id)
    assert.equal(restored.resumable, true)
    assert.equal(restored.stage.episodeNumber, 2)
    assert.deepEqual(calls, [[1, 'before'], [2, 'before']])
    assert.equal((await post(app, route, { sources })).status, 409)
    const resumed = await post(app, `${route}/${id}/resume`, { model: 'after' })
    assert.equal(resumed.status, 201, await resumed.clone().text())
    const completed = await waitForJob(app, route)
    assert.deepEqual([completed.id, completed.status, completed.completed, completed.total, completed.added], [id, 'completed', 3, 3, 3])
    assert.deepEqual(calls, [[1, 'before'], [2, 'before'], [2, 'after'], [3, 'after']])
    assert.deepEqual((await store.summary(project.id)).assets.map(asset => asset.name), ['角色1', '角色2', '角色3'])
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('最后保存资产出错时，继续任务只重试合并，不再调用模型', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'script-video-extract-finalize-'))
  const store = new ScriptVideoStore(directory)
  try {
    const app = new Hono()
    const project = await store.create('断点继续保存')
    let calls = 0
    let failSave = true
    registerScriptVideoAssetExtractionRoutes(app, store,
      (c, error) => c.json({ message: String(error) }, error instanceof ScriptVideoStoreError ? error.status : 500),
      async input => {
        const extracted = await extractScriptVideoAssets(input, async () => {
          calls++
          return JSON.stringify({ assets: [{ kind: 'character', name: '阿宁', assetIdentity: '阿宁', imagePrompt: '人物' }] })
        })
        if (failSave) extracted[0].name = ''
        return extracted
      },
    )
    const path = `/projects/${project.id}/assets/extract`
    const response = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: [{ title: '第 1 集', script: '阿宁登场。' }] }),
    })
    const { id } = (await response.json()).data
    async function wait() {
      for (let attempt = 0; attempt < 80; attempt++) {
        const job = (await (await app.request(path)).json()).data
        if (job.status !== 'running') return job
        await pause(10)
      }
      throw new Error('没有读到任务结果')
    }
    const failed = await wait()
    assert.deepEqual([failed.status, failed.resumable, failed.completed, failed.total], ['failed', true, 1, 1], failed.error)
    assert.equal((await store.summary(project.id)).assets.length, 0)
    failSave = false
    assert.equal((await app.request(`${path}/${id}/resume`, { method: 'POST' })).status, 201)
    const completed = await wait()
    assert.deepEqual([completed.status, completed.added, calls], ['completed', 1, 1], completed.error)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
