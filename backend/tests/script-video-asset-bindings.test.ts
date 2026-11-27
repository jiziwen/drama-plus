import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planScriptVideoCardBindings, resolveScriptVideoAssetBinding, scriptVideoAssetBindingIssues } from '../src/services/script-video-asset-bindings.js'
import { scriptVideoAssetSourceScenes } from '../src/services/script-video-asset-scenes.js'
import { generateScriptVideoCards, generateScriptVideoOutline } from '../src/services/script-video-ai.js'
import type { ScriptVideoAsset, ScriptVideoCard } from '../src/services/script-video-types.js'

const script = '场次：4-01\n场景：东院\n小宁披着白斗篷。\n场次：4-02\n场景：正殿\n小宁换上礼服。'
const costume = (id: string, name: string, quote: string, index: number): ScriptVideoAsset => ({
  id, name, kind: 'character', aliases: ['小宁'], assetIdentity: `阿宁｜${name.split('_')[1]}`,
  image: `/static/uploads/${id}.png`,
  occurrences: [{ label: '小宁', quote, offset: script.indexOf(quote), sourceTitle: '第四集', episodeNumber: 4, sceneId: `4-0${index}` }],
})
const assets = [costume('white', '阿宁_白斗篷', '小宁披着白斗篷。', 1), costume('formal', '阿宁_礼服', '小宁换上礼服。', 2)]
const input = { script, episodeNumber: 4, assets }
const shot = (action: string, assetId?: string) => ({ id: 'shot', duration: 10, camera: '中景', action, dialogue: '小宁：“先等我。”',
  visualAssetIds: assetId ? [assetId] : [], speakerAssetIds: assetId ? [assetId] : [] })
const board = (fields: Partial<ScriptVideoCard> = {}): ScriptVideoCard => ({ id: 'card', title: '等候', summary: '小宁等候。',
  duration: 10, status: 'draft', prompt: '', assetIds: ['formal'], version: 1, combat: false, shots: [shot('阿宁_礼服偏过头。', 'formal')], ...fields })

test('已确认的剧本场次优先，模型写错同一角色的造型时纠正镜头 ID 和正文', () => {
  const draft = board({ scene: '正殿｜场次 4-02｜镜头1' })
  const planned = planScriptVideoCardBindings(draft, input, board({ sourceSceneIds: ['4-01'], shots: [] }))
  assert.deepEqual(planned.sourceSceneIds, ['4-01'])
  assert.deepEqual(planned.assetIds, ['white'])
  assert.deepEqual(planned.shots[0].visualAssetIds, ['white'])
  assert.deepEqual(planned.shots[0].speakerAssetIds, ['white'])
  assert.match(planned.shots[0].action, /阿宁_白斗篷/u)
  assert.equal(planned.shots[0].dialogue, draft.shots[0].dialogue)
  assert.deepEqual(scriptVideoAssetBindingIssues(planned, assets), [])
})

test('旧素材的同名多造型保留待选，制作阶段选定后才允许提交', () => {
  const old = assets.map(({ occurrences: _proof, ...asset }) => asset)
  const planned = planScriptVideoCardBindings(board({ scene: '小宁正在等待', prompt: '镜头1\n画面与动作：@阿宁_礼服偏过头。' }),
    { script: '小宁在巷口等人。', episodeNumber: 4, assets: old })
  const [issue] = scriptVideoAssetBindingIssues(planned, old)
  assert.equal(issue.requirement.assetId, undefined)
  assert.deepEqual(issue.requirement.candidateIds, ['white', 'formal'])
  const fixed = resolveScriptVideoAssetBinding(planned, issue.requirement.key, 'white', old)!
  assert.deepEqual(fixed.assetIds, ['white'])
  assert.match(fixed.prompt, /@阿宁_白斗篷/u)
  assert.equal(fixed.shots[0].dialogue, '小宁：“先等我。”')
  assert.equal(fixed.assetBindingRequirements?.[0].confirmed, true)
  assert.deepEqual(scriptVideoAssetBindingIssues(fixed, old), [])
  assert.match(scriptVideoAssetBindingIssues(fixed, old.filter(asset => asset.id !== 'white'))[0].message, /请选择/u)
})

test('两场换装按镜头范围切换，缺少范围或手改提示词填错会阻塞视频', () => {
  const draft = board({ scene: '东院｜场次 4-01｜镜头1\n正殿｜场次 4-02｜镜头2', duration: 20,
    assetIds: ['white', 'formal'], shots: [shot('阿宁_礼服走进东院。', 'formal'), { ...shot('阿宁_白斗篷落座。', 'white'), id: 'shot-2' }] })
  const planned = planScriptVideoCardBindings(draft, input)
  assert.deepEqual(planned.shots.map(shot => shot.visualAssetIds), [['white'], ['formal']])
  assert.deepEqual(scriptVideoAssetBindingIssues(planned, assets), [])
  assert.ok(scriptVideoAssetBindingIssues({ ...planned, scene: '东院之后转到正殿' }, assets).length)
  assert.ok(scriptVideoAssetBindingIssues({ ...planned, prompt: '镜头1\n画面与动作：@阿宁_礼服到了。' }, assets).length)
})

test('明确场次的背景以原剧本地点为准，即使模型引用另一个地点', () => {
  const scenes: ScriptVideoAsset[] = [{ id: 'yard', kind: 'scene', name: '东院', image: '/static/uploads/yard.png' },
    { id: 'hall', kind: 'scene', name: '正殿', image: '/static/uploads/hall.png' }]
  const planned = planScriptVideoCardBindings(board({ scene: '正殿｜场次 4-02｜镜头1', assetIds: ['hall'],
    shots: [{ ...shot('@正殿 内的灯光。', 'hall'), speakerAssetIds: [] }] }), { ...input, assets: scenes },
    board({ sourceSceneIds: ['4-01'], assetIds: [], shots: [] }))
  assert.deepEqual(planned.assetIds, ['yard'])
  assert.deepEqual(planned.shots[0].visualAssetIds, ['yard'])
  assert.match(planned.shots[0].action, /@东院/u)
  assert.deepEqual(scriptVideoAssetBindingIssues(planned, scenes), [])
})

test('大纲把实际场次、别名和候选 ID 提供给模型，素材待确认仍可返回大纲', async () => {
  const old = assets.map(({ occurrences: _proof, ...asset }) => asset)
  const result = await generateScriptVideoOutline({ ...input, assets: old }, async request => {
    const message = JSON.parse(request.message)
    assert.deepEqual(message.sourceSceneAssets.map((scene: { id: string }) => scene.id), ['4-01', '4-02'])
    assert.ok(message.assets.some((asset: { id: string; aliases?: string[] }) => asset.id === 'white' && asset.aliases?.includes('小宁')))
    assert.match(request.instructions, /服饰、年龄、伤势或形态/u)
    return { cards: [{ title: '等候', summary: '小宁到了东院。', assetIds: ['formal'], sourceSceneIds: ['4-01'], duration: 30, combat: false }] }
  })
  assert.equal(result.cards.length, 1)
  assert.match(scriptVideoAssetBindingIssues(result.cards[0], old)[0].message, /小宁/u)
  assert.deepEqual(scriptVideoAssetSourceScenes(script).map(({ title }) => title), ['东院', '正殿'])
})

test('分批请求共享相同的资产绑定，逐段保留不同的人工选择、候选和场次证据', async () => {
  const binding = { key: 'costume', label: '小宁', kind: 'character' as const, sceneId: '4-01', candidateIds: ['white', 'formal'] }
  const outline = [
    board({ id: 'first', duration: 30, shots: [], assetBindingRequirements: [binding] }),
    board({ id: 'second', duration: 30, shots: [], assetBindingRequirements: [{ ...binding, assetId: 'white', confirmed: true }] }),
    board({ id: 'third', duration: 30, shots: [], assetBindingRequirements: [binding] }),
  ]
  const controller = new AbortController()
  let payload = ''
  await assert.rejects(generateScriptVideoCards({ ...input, outline, signal: controller.signal }, async request => {
    payload = request.message
    controller.abort(new Error('captured request'))
    throw controller.signal.reason
  }, { batchSize: 1 }), /captured request/)
  const data = JSON.parse(payload)
  assert.deepEqual(data.targetCardIds, ['first'])
  assert.deepEqual(data.confirmedOutline.map((card: ScriptVideoCard) => card.id), ['first', 'second', 'third'])
  assert.ok(data.confirmedOutline.every((card: ScriptVideoCard) => !card.assetBindingRequirements))
  const modelBinding = { label: '小宁', kind: 'character', sceneId: '4-01', candidateIds: ['white', 'formal'] }
  assert.deepEqual(data.confirmedOutlineBindings, [
    { ...modelBinding, segments: [1, 3] },
    { ...modelBinding, assetId: 'white', confirmed: true, segments: [2] },
  ])
  assert.deepEqual(data.assets.map((asset: ScriptVideoAsset) => asset.id), ['white', 'formal'])
  assert.match(JSON.stringify(data.sourceSceneAssets), /小宁披着白斗篷。/u)
  assert.equal(outline[1].assetBindingRequirements?.[0].confirmed, true)
})
