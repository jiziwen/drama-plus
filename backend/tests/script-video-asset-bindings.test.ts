import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completeScriptVideoSceneReferences, planScriptVideoCardBindings, resolveScriptVideoAssetBinding, scriptVideoAssetBindingIssues, scriptVideoCardSceneIds, scriptVideoSceneReferenceProblems, scriptVideoSourceAssetMap } from '../src/services/script-video-asset-bindings.js'
import { scriptVideoAssetSourceScenes } from '../src/services/script-video-asset-scenes.js'
import { generateScriptVideoCards, generateScriptVideoOutline } from '../src/services/script-video-ai.js'
import { buildScriptVideoDelivery } from '../src/services/script-video-delivery.js'
import { scriptVideoStoryboardBody } from '../src/services/script-video-format.js'
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
  const planned = planScriptVideoCardBindings(board({ scene: '庭院', assetIds: [], shots: [shot('小宁偏过头。')],
    prompt: '镜头1\n画面与动作：小宁偏过头。' }),
    { script: '小宁在巷口等人。', episodeNumber: 4, assets: old })
  const [issue] = scriptVideoAssetBindingIssues(planned, old)
  assert.equal(issue.requirement.assetId, undefined)
  assert.deepEqual(issue.requirement.candidateIds, ['white', 'formal'])
  const fixed = resolveScriptVideoAssetBinding(planned, issue.requirement.key, 'white', old)!
  assert.deepEqual(fixed.assetIds, ['white'])
  assert.deepEqual(fixed.shots[0].visualAssetIds, ['white'])
  assert.deepEqual(buildScriptVideoDelivery(fixed, old, { preview: true, promptMode: 'inline' }).images.map(asset => asset.id), ['white'])
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

test('已使用长剑的片段不会因同场其他段的剑柄或音效里的桌沿要求选图', () => {
  const props: ScriptVideoAsset[] = [
    { id: 'sword', name: '客栈镇宅长剑', aliases: ['长剑', '剑柄'], kind: 'prop', image: '/sword.png' },
    { id: 'broken', name: '雪白碎剑', aliases: ['剑柄'], kind: 'prop', image: '/broken.png' },
    { id: 'table', name: '执剑堂木桌', aliases: ['桌沿'], kind: 'prop', image: '/table.png' },
  ]
  const requirement = (label: string, candidateIds: string[], assetId?: string) => ({ key: label, label, kind: 'prop' as const,
    sceneId: '4-03', candidateIds, assetId })
  const draft = board({ sourceSceneIds: ['4-03'], scene: '茶铺｜4-03｜镜头1', assetIds: ['sword'],
    openingAssetIds: ['sword'],
    shots: [{ ...shot('曹敬仍垂持客栈镇宅长剑。', 'sword'), speakerAssetIds: [], dialogue: '音效：袖口擦过桌沿。' }],
    prompt: '镜头1（0–10秒）\n画面与动作：曹敬仍垂持@客栈镇宅长剑。\n音效：袖口擦过桌沿。',
    assetBindingRequirements: [requirement('长剑', ['sword'], 'sword'), requirement('剑柄', ['sword', 'broken']), requirement('桌沿', ['table'])] })
  const labels = (card: ScriptVideoCard, assets = props) => scriptVideoAssetBindingIssues(card, assets).map(issue => issue.requirement.label)
  assert.deepEqual(labels(draft), [])
  assert.deepEqual(buildScriptVideoDelivery(draft, props, { promptMode: 'reference-guide' }).images.map(asset => asset.id), ['sword'])
  assert.deepEqual(labels({ ...draft, prompt: draft.prompt.replace('曹敬仍垂持@客栈镇宅长剑。', '曹敬握住剑柄。') }), [])
  assert.deepEqual(labels({ ...draft, prompt: draft.prompt.replace('@客栈镇宅长剑', '@雪白碎剑') }), [])
  assert.deepEqual(labels({ ...draft, shots: draft.shots.map(shot => ({ ...shot, visualAssetIds: undefined })) }), [])
  const selected = { ...draft, assetBindingRequirements: draft.assetBindingRequirements!.map(item => item.label === '剑柄'
    ? { ...item, assetId: 'sword', confirmed: true as const } : item) }
  assert.deepEqual(labels(selected, props.filter(asset => asset.id !== 'sword')), ['长剑', '剑柄'])

  const next = planScriptVideoCardBindings({ ...draft, prompt: '', assetBindingRequirements: undefined },
    { script: '4-03 茶铺\n曹敬垂持长剑。\n下一段，洛晓晓手按剑柄，顺着桌沿走。', episodeNumber: 4, assets: props })
  assert.deepEqual(next.assetBindingRequirements?.map(item => item.label), ['长剑'])
})

test('只有当前画面真正引用多个候选的已提取物件才需要确认', () => {
  const table: ScriptVideoAsset[] = [
    { id: 'hall', name: '执剑堂议事木桌', aliases: ['桌沿'], originalName: '木桌', kind: 'prop', image: '/hall.png' },
    { id: 'room', name: '书生卧房木桌', aliases: ['桌沿'], originalName: '木桌', kind: 'prop', image: '/room.png' },
  ]
  const requirement = { key: 'table', label: '木桌', kind: 'prop' as const, candidateIds: ['hall', 'room'] }
  const draft = board({ assetIds: [], shots: [shot('木桌占据画面中央。')], assetBindingRequirements: [requirement],
    prompt: '镜头1（0–10秒）\n画面与动作：木桌占据画面中央。' })
  const [issue] = scriptVideoAssetBindingIssues(draft, table)
  assert.equal(issue.type, 'ambiguous')
  assert.deepEqual(issue.requirement.candidateIds, ['hall', 'room'])
  const picked = resolveScriptVideoAssetBinding(draft, requirement.key, 'hall', table)!
  assert.deepEqual(picked.shots[0].visualAssetIds, ['hall'])
  assert.deepEqual(buildScriptVideoDelivery(picked, table, { preview: true, promptMode: 'inline' }).images.map(asset => asset.id), ['hall'])
  const edge = { ...draft, prompt: draft.prompt.replace('木桌占据画面中央', '手沿着桌沿滑过'),
    assetBindingRequirements: [{ ...requirement, label: '桌沿' }] }
  assert.deepEqual(scriptVideoAssetBindingIssues(edge, table), [])
  const named = { ...draft, assetIds: ['hall'], shots: [{ ...draft.shots[0], visualAssetIds: ['hall'] }],
    prompt: draft.prompt.replace('木桌占据', '@执剑堂议事木桌占据') }
  assert.deepEqual(scriptVideoAssetBindingIssues(named, table), [])
  assert.equal(scriptVideoAssetBindingIssues(picked, table.filter(asset => asset.id !== 'hall'))[0].type, 'missing')
})

test('多条素材要求共享镜头解析，并按各自场次验证最新提示词', () => {
  const props: ScriptVideoAsset[] = [
    { id: 'bronze', name: '青铜令牌', originalName: '令牌', kind: 'prop', image: '/bronze.png' },
    { id: 'silver', name: '白银令牌', originalName: '令牌', kind: 'prop', image: '/silver.png' },
    { id: 'long', name: '长剑', originalName: '剑', kind: 'prop', image: '/long.png' },
    { id: 'short', name: '短剑', originalName: '剑', kind: 'prop', image: '/short.png' },
    { id: 'red', name: '红纸灯', originalName: '灯', kind: 'prop', image: '/red.png' },
    { id: 'white', name: '白纸灯', originalName: '灯', kind: 'prop', image: '/white.png' },
  ]
  const actions = ['门边挂着@短剑。', '手里握着@白银令牌。', '手里握着@白银令牌。', '桌上放着一柄剑。']
  const actionReads = actions.map(() => 0)
  const earlyPrompt = '镜头1（0–5秒）\n画面与动作：门边挂着@短剑。'
  let prompt = earlyPrompt + '\n镜头2（5–10秒）\n画面与动作：墙上悬着@白纸灯。'
    + '\n镜头4（15–20秒）\n画面与动作：桌上放着@短剑。'
  let promptReads = 0
  const card: ScriptVideoCard = {
    ...board({
      assetIds: ['bronze', 'long', 'red'],
      sourceSceneIds: ['4-01', '4-02'],
      scene: '东院｜场次 4-01｜镜头1–2\n正殿｜场次 4-02｜镜头3–4',
      assetBindingRequirements: [
        { key: 'sword', label: '长剑', kind: 'prop', sceneId: '4-02', assetId: 'long', candidateIds: ['long', 'short'] },
        { key: 'token', label: '令牌', kind: 'prop', sceneId: '4-01', assetId: 'bronze', candidateIds: ['bronze', 'silver'] },
        { key: 'lantern', label: '纸灯', kind: 'prop', sceneId: '4-01', assetId: 'red', candidateIds: ['red', 'white'] },
      ],
      shots: actions.map((action, index) => ({
        ...shot(action),
        id: `shot-${index + 1}`,
        dialogue: '',
        get action() {
          actionReads[index]++
          return actions[index]
        },
      })),
    }),
    get prompt() {
      promptReads++
      return prompt
    },
  }
  const issues = () => scriptVideoAssetBindingIssues(card, props).map(issue => issue.requirement.key)

  assert.deepEqual(issues(), ['sword', 'token', 'lantern'])
  assert.ok(actionReads.every(reads => reads <= 1), `每个镜头最多读取一次，实际次数 ${actionReads.join(', ')}`)
  assert.equal(promptReads, 1)

  actions[1] = '手里握着@青铜令牌。'
  assert.deepEqual(issues(), ['sword', 'lantern'])
  prompt = earlyPrompt
  assert.deepEqual(issues(), [])
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

test('场次号规范化保留正式场号，跳过镜头范围、镜号范围和时间范围', () => {
  const scenes = scriptVideoAssetSourceScenes('场次：1-04\n场景：东院\n场次：1-05\n场景：正殿')
  const rangeOnly = '地点未定｜镜头1–4；镜号：１－５；镜头范围：1–4；时间1–5｜1–4秒；1s–5s；00:01–04:23'
  assert.deepEqual(scriptVideoCardSceneIds({ scene: rangeOnly }, scenes), [])
  assert.deepEqual(scriptVideoCardSceneIds({ scene: rangeOnly + '｜1-4｜' }, scenes), ['1-04'])
})

test('原场次号补零后匹配正式分镜，旧稿在同一场次内按镜头范围分别引用各背景', () => {
  const sceneAssets: ScriptVideoAsset[] = [
    { id: 'lobby', kind: 'scene', name: '临安·红尘客栈大堂', image: '/static/uploads/lobby.png' },
    { id: 'room', kind: 'scene', name: '红尘客栈·夏叶客房', image: '/static/uploads/room.png' },
    { id: 'corridor', kind: 'scene', name: '红尘客栈二楼客房走廊', image: '/static/uploads/corridor.png' },
    { id: 'coin', kind: 'prop', name: '铜钱', image: '/static/uploads/coin.png' },
  ]
  const sceneInput = { script: '场次：３－１\n场景：红尘客栈·大堂\n众人在谈话。\n场次：3-02\n场景：红尘客栈·夏叶客房\n房内安静。', episodeNumber: 3, assets: sceneAssets }
  const first = planScriptVideoCardBindings(board({ assetIds: [],
    scene: '场景一：红尘客栈·大堂（唯一空间）｜3-1｜清晨，内景；窗边日光斜入｜镜头1',
    shots: [{ ...shot('将铜钱放下。'), speakerAssetIds: [], dialogue: '' }] }), sceneInput,
  board({ assetIds: [], sourceSceneIds: ['3–1'], shots: [] }))
  assert.deepEqual(first.sourceSceneIds, ['3-01'])
  assert.deepEqual(first.shots[0].visualAssetIds, ['lobby'])
  const scene = '场景一：红尘客栈·夏叶客房｜3-2｜夜，内景；门缝透出光｜镜头1–2；场景二：红尘客栈二楼客房走廊｜3-2｜夜，内景；光线昏暗｜镜头3'
  const legacy = board({ assetIds: ['coin'], scene: '过期资料', sourceSceneIds: ['3-02'], duration: 30,
    shots: [{ ...shot('铜钱落地。', 'coin'), speakerAssetIds: [] }, shot('屋内安静。'), shot('走向楼梯。')].map(item => ({ ...item, dialogue: '' })) })
  legacy.prompt = scriptVideoStoryboardBody({ ...legacy, scene })
  const fixed = completeScriptVideoSceneReferences(legacy, sceneInput)
  assert.deepEqual(fixed.assetIds, ['coin', 'room', 'corridor'])
  assert.deepEqual(fixed.shots.map(item => item.visualAssetIds), [['coin', 'room'], ['room'], ['corridor']])
  assert.equal(fixed.prompt, legacy.prompt)
  assert.strictEqual(completeScriptVideoSceneReferences(fixed, sceneInput), fixed)
  assert.deepEqual(planScriptVideoCardBindings({ ...legacy, scene, prompt: '' }, sceneInput).shots.map(item => item.visualAssetIds),
    [['coin', 'room'], ['room'], ['corridor']])
  for (const promptMode of ['inline', 'reference-guide'] as const) {
    assert.deepEqual(new Set(buildScriptVideoDelivery(fixed, sceneAssets, { promptMode }).images.map(asset => asset.id)), new Set(['coin', 'room', 'corridor']))
  }
  const legacyWithoutArray = { ...legacy, scene: undefined, shots: [{ ...legacy.shots[0], visualAssetIds: undefined }],
    prompt: '场景：红尘客栈·大堂（唯一空间）｜3-1\n镜头1（0–10秒）\n画面与动作：铜钱落地。' }
  const retained = completeScriptVideoSceneReferences(legacyWithoutArray, sceneInput)
  assert.equal(retained.shots[0].visualAssetIds, undefined)
  assert.match(retained.prompt, /@临安·红尘客栈大堂/u)
  assert.deepEqual(new Set(buildScriptVideoDelivery(retained, sceneAssets, { promptMode: 'inline' }).images.map(asset => asset.id)), new Set(['coin', 'lobby']))
  assert.strictEqual(completeScriptVideoSceneReferences(retained, sceneInput), retained)
})

test('场景补齐保留人工排除、已有绑图和模糊候选', () => {
  const sceneAssets: ScriptVideoAsset[] = [
    { id: 'yard', kind: 'scene', name: '东院', image: '/static/uploads/yard.png' },
    { id: 'hall', kind: 'scene', name: '正殿', image: '/static/uploads/hall.png' },
  ]
  const sceneInput = { ...input, assets: sceneAssets }
  const card = board({ assetIds: [], scene: '东院｜场次 4-1｜镜头1', shots: [{ ...shot('在原地等待。'), dialogue: '' }] })
  const ignored = { ...card, excludedAssetIds: ['yard'] }
  assert.strictEqual(completeScriptVideoSceneReferences(ignored, sceneInput), ignored)
  assert.deepEqual(planScriptVideoCardBindings(ignored, sceneInput).excludedAssetIds, ['yard'])
  assert.deepEqual(planScriptVideoCardBindings(ignored, sceneInput).assetIds, [])
  const manuallyBound = { ...card, assetIds: ['hall'] }
  assert.strictEqual(completeScriptVideoSceneReferences(manuallyBound, sceneInput), manuallyBound)
  const manuallyConfirmed = { ...manuallyBound, assetBindingRequirements: [{ key: 'location', label: '东院', kind: 'scene' as const,
    sceneId: '4-01', candidateIds: ['yard', 'hall'], assetId: 'hall', confirmed: true as const }] }
  assert.deepEqual(completeScriptVideoSceneReferences(manuallyConfirmed, sceneInput).shots[0].visualAssetIds, ['hall'])
  assert.strictEqual(completeScriptVideoSceneReferences(card,
    { ...sceneInput, assets: [...sceneAssets, { ...sceneAssets[0], id: 'alternate', name: '王府·东院', aliases: ['东院'] }] }), card)
})

test('完整逐镜场景会排除旧自动候选，保留转场、手动引用与未覆盖镜头', () => {
  const sceneAssets: ScriptVideoAsset[] = Object.entries({ yard: '东院', hall: '正殿', extra: '西州县衙', manual: '书楼' })
    .map(([id, name]) => ({ id, name, kind: 'scene', image: `/static/uploads/${id}.png` }))
  sceneAssets.push({ id: 'ruler', name: '西州县衙刻字铜尺', kind: 'prop', image: '/static/uploads/ruler.png' })
  const scene = '场景一：东院｜4-01｜镜头1–1拍门缝，下一镜看全院｜镜头1–2。\n镜头3转场：从门口切入。\n场景二：正殿｜4-02｜清晨，内景；靠窗明亮｜镜头3。'
  const requirement = (key: string, label: string, candidateIds: string[], assetId?: string, confirmed?: true) =>
    ({ key, label, candidateIds, assetId, confirmed, kind: 'scene' as const, sceneId: '4-01' })
  const draft = board({ scene, sourceSceneIds: ['4-01', '4-02'], duration: 30, assetIds: ['yard', 'hall', 'extra', 'manual'],
    shots: ['yard', 'yard', 'hall'].map((id, index) => ({ ...shot('停在原地。'), id: `part-${index}`, dialogue: '', visualAssetIds: [id] })),
    assetBindingRequirements: [requirement('wrong', '县衙', ['extra'], 'extra'), requirement('alias', '院外', ['extra']),
      requirement('yard', '东院', ['extra', 'yard']), requirement('manual', '另选书楼', ['manual'], 'manual', true)] })
  draft.prompt = scriptVideoStoryboardBody(draft)
  const scope = { script, assets: sceneAssets }
  const fixed = completeScriptVideoSceneReferences(draft, scope)
  assert.deepEqual(fixed.assetIds, ['yard', 'hall', 'manual'])
  assert.deepEqual(fixed.assetBindingRequirements?.map(item => [item.key, item.assetId, item.candidateIds]), [['yard', 'yard', ['yard']], ['manual', 'manual', ['manual']]])
  assert.equal(fixed.prompt, draft.prompt)
  assert.deepEqual(new Set(buildScriptVideoDelivery(fixed, sceneAssets, { promptMode: 'reference-guide' }).images.map(asset => asset.id)), new Set(['yard', 'hall', 'manual']))
  const edited = { ...draft, prompt: draft.prompt.replace('画面与动作：', '画面与动作：远望@西州县衙，') }
  assert.ok(completeScriptVideoSceneReferences(edited, scope).assetIds.includes('extra'))
  const partial = { ...draft, shots: draft.shots.map((item, index) => index === 1 ? { ...item, visualAssetIds: [] } : item) }
  assert.ok(completeScriptVideoSceneReferences(partial, scope).assetIds.includes('extra'))
  const unbound = { ...draft, assetIds: [], assetBindingRequirements: [], shots: draft.shots.map(item => ({ ...item, visualAssetIds: [] })),
    prompt: draft.prompt.replace('靠窗明亮', '靠窗明亮，@西州县衙刻字铜尺受光') }
  assert.deepEqual(completeScriptVideoSceneReferences(unbound, scope).shots.map(item => item.visualAssetIds), [['yard'], ['yard'], ['hall']])
})

test('未绑定的场景标题返回准确的原文范围，已有配图、排除和显式引用不重复提示', () => {
  const sceneAssets: ScriptVideoAsset[] = [
    { id: 'east', kind: 'scene', name: '东院', image: '/static/uploads/east.png' },
    { id: 'east-alt', kind: 'scene', name: '王府·东院', aliases: ['东院'], image: '/static/uploads/east-alt.png' },
    { id: 'room', kind: 'scene', name: '正殿', image: '/static/uploads/room.png' },
    { id: 'prop', kind: 'prop', name: '东院', image: '/static/uploads/prop.png' },
  ]
  const unknown = '松月书楼'
  const prompt = '←承上：🎬 门外。\r\n场景：场景一：东院｜镜头1；场景二：' + unknown + '｜内景；门窗关着｜镜头2；场景三：@旧街巷｜镜头3；场景四：正殿｜镜头4\r\n\r\n镜头1（0–10秒）\r\n画面与动作：继续谈话。'
  const card = board({ prompt, assetIds: [], shots: Array.from({ length: 4 }, () => shot('继续谈话。')) })
  const problems = scriptVideoSceneReferenceProblems(card, sceneAssets)
  assert.deepEqual(problems.map(problem => [prompt.slice(problem.start, problem.end), problem.candidateIds]), [['东院', ['east', 'east-alt']], [unknown, []]])
  assert.deepEqual(scriptVideoSceneReferenceProblems({ ...card, excludedAssetIds: ['east'] }, sceneAssets).map(problem => problem.name), [unknown])
  assert.deepEqual(scriptVideoSceneReferenceProblems({ ...card, assetIds: ['east'] }, sceneAssets).map(problem => problem.name), [unknown])
  assert.deepEqual(scriptVideoSceneReferenceProblems({ ...card, status: 'ready' }, sceneAssets), [])
  assert.deepEqual(scriptVideoSceneReferenceProblems({ ...card, prompt: '走到东院边，看看松月书楼。' }, sceneAssets), [])
})

test('来源不接受从词中误提取的单字或角色泛称，原文角色清单可以提供明确证据', () => {
  const raw = '场次：3-1\n场景：客栈\n人物：店小二（周原）、艾\n艾放下手里的铜钱。店小二把酒端来。'
  const occurrence = (label: string, quote: string) => ({ label, quote, offset: raw.indexOf(quote), sourceTitle: '第三集', episodeNumber: 3, sceneId: '3-01' })
  const assets: ScriptVideoAsset[] = [
    { id: 'wrong', kind: 'character', name: '高大男子', aliases: ['头', '店小二'], occurrences: [occurrence('店小二', '店小二把酒端来。')] },
    { id: 'right', kind: 'character', name: '周原', aliases: ['店小二'], occurrences: [occurrence('店小二', '店小二把酒端来。')] },
    { id: 'ai', kind: 'character', name: '艾', occurrences: [occurrence('艾', '艾放下手里的铜钱。')] },
    { id: 'prop', kind: 'prop', name: '臂弯铜摆件', aliases: ['铜'], occurrences: [occurrence('铜', '艾放下手里的铜钱。')] },
  ]
  assert.deepEqual(scriptVideoSourceAssetMap({ script: raw, assets, episodeNumber: 3 }).requirements.filter(item => ['店小二', '艾', '头', '铜'].includes(item.label))
    .map(({ label, candidateIds }) => [label, candidateIds]), [['店小二', ['right']], ['艾', ['ai']]])
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
