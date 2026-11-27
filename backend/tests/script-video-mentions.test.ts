import assert from 'node:assert/strict'
import test from 'node:test'
import { isScriptVideoChibiAppearance, scriptVideoCharacterBase, scriptVideoCharacterName } from '../src/services/script-video-asset-identity'
import { annotateScriptVideoAssets as scan, type MentionAsset } from '../src/services/script-video-mentions'

const character = (name: string, id = name): MentionAsset => ({ name, id, kind: 'character' })
const cast = [character('顾凌天'), character('顾凌天_龙袍'), character('顾凌天_夜行'), character('火枪卫小旗_飞鱼服'), character('王禄')]
const bound = ['顾凌天_龙袍', '火枪卫小旗_飞鱼服', '王禄']
const options = { autoBind: true, characters: '@火枪卫小旗_飞鱼服（张浩）：立在阶前。' }

test('an earlier natural-language ambiguity cannot hide a later explicit reference problem', () => {
  const rooms = [
    { id: 'palace', name: '皇宫-御书房', kind: 'scene' },
    { id: 'annex', name: '别院-御书房', kind: 'scene' },
  ]
  for (const ids of [[], rooms.map(room => room.id)]) {
    const text = '画面与动作：走进御书房。\n画面与动作：推门进入@御书房。'
    const result = scan(text, rooms, ids, { autoBind: true })
    assert.deepEqual(result.ambiguous, ['御书房'])
    assert.deepEqual(result.problems.map(problem => text[problem.start]), ['御', '@'])
  }
})

test('persisted aliases automatically bind characters and visual assets and support explicit references without a cast declaration', () => {
  const assets = [
    { ...character('阿宁·官服', 'guard'), assetIdentity: '陆宁｜官服', aliases: ['小陆'] },
    { id: 'hall', kind: 'scene', name: '南院议事厅', aliases: ['议事堂'] },
    { id: 'sword', kind: 'prop', name: '包银佩剑', aliases: ['银剑'] },
  ]
  const text = '画面与动作：小陆在议事堂拔出@银剑。\n对白／音效：小陆：“把银剑放回议事堂。”'
  const result = scan(text, assets, [], { autoBind: true, detectUnboundSpeakers: true })
  assert.equal(result.text, '画面与动作：@阿宁·官服在@南院议事厅拔出@包银佩剑。\n对白／音效：@阿宁·官服：“把银剑放回议事堂。”')
  assert.deepEqual(result.assetIds, ['guard', 'hall', 'sword'])
  assert.deepEqual(result.unboundSpeakers, [])
  assert.equal(result.mentions.find(hit => hit.usage === 'speaker')?.id, 'guard')
  assert.deepEqual(scan('@小陆。', assets, []).assetIds, ['guard'])
})

test('shared aliases use known or same-shot bindings while exact explicit names and unresolved variants stay distinct', () => {
  const guard = { ...character('陆宁官服', 'guard'), assetIdentity: '陆宁｜官服', aliases: ['小陆', '陆宁便装'] }
  const casual = { ...character('陆宁便装', 'casual'), assetIdentity: '陆宁｜便装', aliases: ['小陆'] }
  const assets = [guard, casual]
  assert.deepEqual(scan('小陆抬眼。', assets, [guard.id], { autoBind: true }).assetIds, [guard.id])
  for (const name of ['小陆', '@小陆']) {
    const result = scan(name + '抬眼。', assets, [], { autoBind: true })
    assert.deepEqual(result.assetIds, [])
    assert.deepEqual(result.problems.map(problem => [problem.type, problem.candidates]),
      [['ambiguous', [guard.name, casual.name]]])
  }
  const scoped = { autoBind: true, card: { shots: [
    { visualAssetIds: [guard.id], speakerAssetIds: [guard.id] },
    { visualAssetIds: [casual.id], speakerAssetIds: [casual.id] },
  ] } }
  const text = [
    '镜头 01（0–5秒）',
    '画面与动作：小陆走近@陆宁便装。',
    '对白／音效：@小陆：“来吧。”',
    '镜头 02（5–10秒）',
    '画面与动作：@小陆回身。',
    '对白／音效：小陆：“走吧。”',
  ].join('\n')
  const result = scan(text, assets, assets.map(asset => asset.id), scoped)
  assert.deepEqual(result.mentions.map(({ id, usage }) => [id, usage]),
    [[guard.id, 'visual'], [casual.id, 'visual'], [guard.id, 'speaker'], [casual.id, 'visual'], [casual.id, 'speaker']])
  assert.deepEqual(result.problems, [])

  const emptyShot = { autoBind: true, card: { shots: [{ visualAssetIds: [] }] } }
  assert.equal(scan('镜头 01（0–5秒）\n画面与动作：小陆走近。', [guard], [], emptyShot).mentions[0]?.usage, 'context')
  assert.equal(scan('镜头 01（0–5秒）\n画面与动作：@小陆走近。', [guard], [], emptyShot).mentions[0]?.usage, 'visual')
})

test('structured identities preserve editable display names and separate a Q form from its live subject', () => {
  const live = { ...character('白衣妇人', 'live'), assetIdentity: '陆宁' }
  const q = { ...character('章纹小人偶', 'q'), assetIdentity: '陆宁｜3DＱ版', aliases: ['陆宁', '袖珍阿宁'] }
  assert.equal(scriptVideoCharacterName(q), q.name)
  assert.equal(scriptVideoCharacterBase(q), '陆宁')
  assert.equal(scriptVideoCharacterBase({ ...q, assetIdentity: '陆宁|常服' }), '陆宁')
  assert.equal(isScriptVideoChibiAppearance(q), true)
  assert.equal(isScriptVideoChibiAppearance({ ...q, assetIdentity: '陆宁｜常服', originalName: '陆宁_小剧场' }), true)
  assert.equal(isScriptVideoChibiAppearance(live), false)
  const result = scan('3DQ版小陆宁跳到陆宁右肩。@袖珍阿宁随后。', [live, q], [live.id, q.id], { autoBind: true })
  assert.deepEqual(result.mentions.map(hit => hit.id), [q.id, live.id, q.id])
  assert.deepEqual(scan('陆宁回头。', [q], [q.id], { autoBind: true }).assetIds, [])
  const disambiguated = { ...q, name: '陆宁-2', originalName: '陆宁' }
  assert.deepEqual(scan('陆宁回头，@陆宁-2跳起来。', [disambiguated], [q.id], { autoBind: true }).mentions.map(hit => hit.explicit), [true])
})

test('camera, action, OS attribution and established aliases bind to the same costume while literal dialogue is preserved', () => {
  const text = [
    '人物：@火枪卫小旗_飞鱼服（张浩）：立在阶前。',
    '景别／机位／运动：侧面跟随顾凌天',
    '画面与动作：顾凌天抬手，张浩望向王禄。',
    '对白／音效：顾凌天_龙袍(OS)【低声】：“张浩，王禄呢？”',
  ].join('\n')
  const result = scan(text, cast, bound, options)
  assert.equal(result.text, [
    '人物：@火枪卫小旗_飞鱼服（张浩）：立在阶前。',
    '景别／机位／运动：侧面跟随@顾凌天_龙袍',
    '画面与动作：@顾凌天_龙袍抬手，@火枪卫小旗_飞鱼服望向@王禄。',
    '对白／音效：@顾凌天_龙袍(OS)【低声】：“张浩，王禄呢？”',
  ].join('\n'))
  assert.deepEqual(result.mentions.filter(m => m.spoken).map(m => [text.slice(m.start, m.end), m.id]), [['张浩', '火枪卫小旗_飞鱼服'], ['王禄', '王禄']])
  assert.equal(scan(result.text, cast, result.assetIds, options).text, result.text)
})

test('sources, unbound variants, ambiguous bare roles and deliberate unbinding cannot fall back to a shorter or different costume', () => {
  const text = '顾凌天抬眼。@顾凌天_冬装走近。顾凌天_夜行随后。'
  const result = scan(text, cast, ['顾凌天_龙袍', '顾凌天_夜行'], options)
  assert.deepEqual(result.ambiguous, ['顾凌天'])
  assert.deepEqual(result.unknown, ['@顾凌天_冬装走近'])
  assert.equal(result.text, text.replace('顾凌天_夜行随后', '@顾凌天_夜行随后'))
  assert.equal(scan('顾凌天随后。', cast, ['顾凌天_龙袍'], {...options, excludedIds:['顾凌天']}).text, '顾凌天随后。')
  // Deliberately typing the precise @ name can always reselect it.
  assert.deepEqual(scan('@顾凌天随后。', cast, ['顾凌天_龙袍'], {...options, excludedIds:['顾凌天']}).assetIds, ['顾凌天'])
})

test('current location and prop override short generic names from other project assets; raw 群体 cannot pick an unrelated image', () => {
  const names = [
    ['偏殿','scene'], ['京城皇宫-后宫偏殿院落','scene'], ['京城别院-院落','scene'],
    ['金算盘','prop'], ['迷你金算盘','prop'], ['群体','character'], ['七天/角色/皇家亲军火枪卫/群体','character'],
  ]
  const assets = names.map(([name, kind]) => ({id:name, name, kind, originalName:name.split('/').at(-1)}))
  const ids = [names[1][0], names[4][0], names[6][0]]
  const result = scan('南侧偏殿院门；院落内，金算盘拨珠。皇家亲军火枪卫/群体回头，群体压低声音。', assets, ids, options)
  assert.deepEqual(result.assetIds,ids)
  assert.deepEqual(result.ambiguous, [])
  assert.equal(result.text,'南侧@京城皇宫-后宫偏殿院落院门；@京城皇宫-后宫偏殿院落内，@迷你金算盘拨珠。@七天/角色/皇家亲军火枪卫/群体回头，@七天/角色/皇家亲军火枪卫/群体压低声音。')
  assert.deepEqual(scan('群体压低声音。', assets, [], options).assetIds,[])
})

test('unquoted sound-column dialogue, quoted screen lettering and the verbatim style prefix are protected', () => {
  const result = scan('王禄的风格\r\n\r\n对白／音效：顾凌天(OS)：王禄看见张浩。\n画面与动作：王禄的牌上印着“张浩”。', cast, bound, {...options, protectedPrefix: '王禄的风格'})
  assert.equal(result.text, '王禄的风格\r\n\r\n对白／音效：@顾凌天_龙袍(OS)：王禄看见张浩。\n画面与动作：@王禄的牌上印着“张浩”。')
  assert.equal(result.mentions.filter(m=>m.spoken).length,3)
  assert.equal(scan('顾凌天(OS)：王禄看见张浩。', cast, bound, {...options, dialogue:true}).text,'@顾凌天_龙袍(OS)：王禄看见张浩。')
})

test('a location suggested in the event summary or dialogue does not add or require a scene reference', () => {
  const courtyard = { id: 'court', name: '京城皇宫-后宫偏殿院落', kind: 'scene' }
  const rooms = [
    { id: 'palace-study', name: '京城皇宫-御书房', kind: 'scene' },
    { id: 'study', name: '御书房', kind: 'scene' },
  ]
  const text = [
    '场景：@京城皇宫-后宫偏殿院落。',
    '独立生成：萧容鱼开口劝说。',
    '她劝其回御书房，顾凌天拒绝。',
    '镜头 01（0–5秒）',
    '对白／音效：萧容鱼：“要不您先回御书房吧？”',
  ].join('\r\n')
  for (const assets of [[courtyard, rooms[0]], [courtyard, ...rooms]]) {
    const result = scan(text, assets, [courtyard.id], options)
    assert.deepEqual(result.ambiguous, [])
    assert.deepEqual(result.assetIds, [courtyard.id])
    assert.equal(result.text, text)
  }
  assert.deepEqual(scan('画面与动作：镜头切入御书房。', [courtyard, ...rooms], [courtyard.id], options).ambiguous, ['御书房'])
  assert.deepEqual(scan('画面与动作：院落内拍阶梯。\n导演备注：御书房的效果供另一个片段讨论。', [courtyard, ...rooms], [courtyard.id], options).ambiguous, [])
  assert.deepEqual(scan('镜头 02（5–10秒）\n镜头切入御书房。', [courtyard, ...rooms], [courtyard.id], options).ambiguous, ['御书房'])
  assert.deepEqual(scan('独立生成：@京城皇宫-御书房。', rooms, [], options).assetIds, ['palace-study'])
})

test('only current visual references bind beside quoted text, offscreen sound, and future handoffs', () => {
  const courtyard = { id: 'court', name: '偏殿院落', kind: 'scene' }
  const scenes = [courtyard, { id: 'study', name: '皇宫-御书房', kind: 'scene' },
    { id: 'other-study', name: '内廷-御书房', kind: 'scene' }, { id: 'belfry', name: '钟房', kind: 'scene' }]
  const props = [{ id: 'offscreen', name: '玉佩', kind: 'prop' }, { id: 'visible', name: '金封密信', kind: 'prop' }]
  const assets = [...scenes, ...props, ...cast]
  const selection = [courtyard.id, 'offscreen', 'belfry', '顾凌天_龙袍']
  const lines = [
    '场景：@偏殿院落。',
    '独立生成：顾凌天想起玉佩，提议稍后去御书房。',
    '镜头 01（0–5秒）',
    '画面与动作：顾凌天手持@金封密信，不展示@玉佩。',
    '对白／音效：顾凌天(OS)：“@玉佩还在@御书房，@未知标记原样留着。”；音效：从远处@钟房传来三声钟响。',
    '→衔接至第2段：切到@皇宫-御书房，取出@下一段专用道具。',
  ]
  const result = scan(lines.join('\n'), assets, selection, options)
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.ambiguous, [])
  assert.deepEqual([...result.assetIds].sort(), ['court', 'visible', '顾凌天_龙袍'].sort())
  assert.ok(result.text.includes('手持@金封密信'))
  assert.ok(result.text.includes('不展示@玉佩。'))
  assert.ok(result.text.includes('@顾凌天_龙袍(OS)：“@玉佩还在@御书房，@未知标记原样留着。”'))
  assert.ok(result.text.endsWith(lines.at(-1)!))
  assert.deepEqual(scan('画面与动作：镜头切入御书房。', assets, selection, options).ambiguous, ['御书房'])
  assert.deepEqual(scan('画面与动作：镜头切到@皇宫-御书房。', assets, selection, options).assetIds, ['study'])
})

test('same-line explicit selections bind without changing spoken, sound and handoff references', () => {
  const assets = [
    { id: 'hall', name: '京兆府-大堂', kind: 'scene' },
    { id: 'bird', name: '麻雀', kind: 'creature' },
    { id: 'bell', name: '钟房', kind: 'scene' },
    { id: 'next', name: '院落', kind: 'scene' },
    character('侍卫'),
  ]
  const select = '对白／音效：无对白。仅保留旗布轻响 @麻雀  @京兆府-大堂 '
  const line = select + '；音效：从远处 @钟房 传来钟声；→衔接至第2段：切到 @院落 。'
  assert.deepEqual(scan(line, assets, [], options).mentions.map(hit => [hit.id, hit.usage]),
    [['bird', 'visual'], ['hall', 'visual'], ['bell', 'context'], ['next', 'context']])
  assert.deepEqual(scan('对白／音效：@侍卫：“@麻雀 和 @京兆府-大堂 。”', assets, [], options).assetIds, ['侍卫'])
  assert.deepEqual(scan('对白／音效：@侍卫：在 @京兆府-大堂 听见 @麻雀 。', assets, [], options).assetIds, ['侍卫'])
  assert.deepEqual(scan(select, assets, [], { ...options, dialogue: true }).assetIds, [])
})

test('short role names use only bound cast members and keep a crowd distinct from its flag bearer', () => {
  const royal = character('七天/角色/皇家亲军火枪卫/群体'), privateGuard = character('七天/角色/北城火枪卫/群体')
  const dead = character('七天/角色/黑衣死士/群体'), flag = character('火枪卫小旗_飞鱼服')
  const assets = [royal, privateGuard, dead, flag, character('群体')]
  const line = '九名火枪卫点头，火枪卫众人看向小旗，死士倒地。火枪卫小旗(OS)：“火枪卫来了。”'
  const result = scan(line, assets, [royal.id, dead.id, flag.id], options)
  assert.deepEqual(result.mentions.map(m=>m.id), [royal.id,royal.id,flag.id,dead.id,flag.id,royal.id])
  assert.equal(result.mentions.at(-1)?.spoken,true)
  assert.equal(result.text,`九名@${royal.name}点头，@${royal.name}众人看向@${flag.name}，@${dead.name}倒地。@${flag.name}(OS)：“火枪卫来了。”`)
  assert.deepEqual(scan('九名火枪卫',assets,[royal.id,privateGuard.id],options).ambiguous,['火枪卫'])
})

test('Q版 aliases bind the stylized figure separately from the live role in the same shot', () => {
  const live = character('咖妃')
  const q = character('咖妃_3DQ版')
  const injured = character('咖妃_素色宫装_撞柱染血')
  const assets = [live, q, injured]
  for (const alias of ['3DQ版小咖妃', '3DQ版咖妃', 'Q版小咖妃', 'Q版咖妃']) {
    const result = scan(alias + '跳到咖妃右肩上。咖妃(OS)：“她来了。”', assets, [live.id, q.id], options)
    assert.deepEqual(result.mentions.map(m => m.id), [q.id, live.id, live.id])
    assert.equal(result.text, '@咖妃_3DQ版跳到@咖妃右肩上。@咖妃(OS)：“她来了。”')
  }
  assert.deepEqual(scan('咖妃(OS)：“她来了。”', [live, q], [q.id], options).assetIds, [live.id])
  assert.deepEqual(scan('3DQ版小咖妃跳起。', [live], [live.id], options).assetIds, [])
})

test('a Q版 alias uses the selected stylized costume or remains ambiguous', () => {
  const live = character('咖妃')
  const q = character('咖妃_3DQ版')
  const other = character('咖妃_素色宫装_Q版')
  const assets = [live, q, other]
  assert.deepEqual(scan('3DQ版小咖妃跳起。', assets, [live.id, other.id], options).assetIds, [other.id])
  const unresolved = scan('3DQ版小咖妃跳到咖妃右肩。', assets, [live.id, q.id, other.id], options)
  assert.deepEqual(unresolved.ambiguous, ['3DQ版小咖妃'])
  assert.deepEqual(unresolved.assetIds, [live.id])
})

test('回顾、事件说明和衔接中的人物正式引用素材，保持 context 分类和对白原话', () => {
  const assets = [...cast, { id: 'study', name: '御书房', kind: 'scene' }, { id: 'token', name: '玉佩', kind: 'prop' }]
  const text = [
    '前镜回顾：顾凌天曾在御书房。',
    '独立生成：顾凌天想起玉佩。',
    '镜头 01（0–5秒）',
    '对白／音效：无对白。',
    '→衔接至第2段：顾凌天走向王禄。',
  ].join('\n')
  const result = scan(text, assets, ['顾凌天_龙袍', '王禄'], options)
  assert.equal(result.text, [
    '前镜回顾：@顾凌天_龙袍曾在御书房。',
    '独立生成：@顾凌天_龙袍想起玉佩。',
    '镜头 01（0–5秒）',
    '对白／音效：无对白。',
    '→衔接至第2段：@顾凌天_龙袍走向@王禄。',
  ].join('\n'))
  const roles = result.mentions.filter(hit => assets.find(asset => asset.id === hit.id)?.kind === 'character')
  assert.ok(roles.every(hit => hit.usage === 'context' && !hit.literal && !hit.spoken))
  assert.deepEqual(result.assetIds, ['顾凌天_龙袍', '王禄'])
  assert.ok(result.mentions.filter(hit => hit.id === 'study' || hit.id === 'token').every(hit => hit.literal && hit.usage === 'context'))
  const normalized = scan(result.text, assets, result.assetIds, options)
  assert.equal(normalized.text, result.text)
  assert.ok(normalized.mentions.filter(hit => assets.find(asset => asset.id === hit.id)?.kind === 'character')
    .every(hit => hit.usage === 'context' && !hit.literal))

  const spoken = '对白／音效：顾凌天：“张浩在御书房，王禄拿着玉佩。”'
  const dialogue = scan(spoken, assets, bound, options)
  assert.equal(dialogue.text, spoken.replace('顾凌天：', '@顾凌天_龙袍：'))
  assert.deepEqual(dialogue.assetIds, ['顾凌天_龙袍'])
  assert.ok(dialogue.mentions.filter(hit => hit.spoken).every(hit => hit.literal))
})

test('笑声等发声主体正式引用完整人物素材，别名定义继续保留原文', () => {
  const text = '人物：@火枪卫小旗_飞鱼服（张浩）：立在阶前。\n对白／音效：张浩低笑一声，王禄叹息。'
  const result = scan(text, cast, bound, options)
  assert.equal(result.text, '人物：@火枪卫小旗_飞鱼服（张浩）：立在阶前。\n对白／音效：@火枪卫小旗_飞鱼服低笑一声，@王禄叹息。')
  assert.ok(result.mentions.filter(hit => hit.vocalization).every(hit => !hit.literal && hit.usage === 'speaker'))
  assert.deepEqual(result.assetIds, ['火枪卫小旗_飞鱼服', '王禄'])
  assert.equal(scan(result.text, cast, result.assetIds, options).text, result.text)
})

test('回顾中的显式人物引用保持精确造型，多造型简称不擅自选取且尊重排除', () => {
  const text = '前镜回顾：顾凌天先前出镜，@顾凌天_夜行曾在门外。'
  const result = scan(text, cast, ['顾凌天_龙袍', '顾凌天_夜行'], options)
  assert.equal(result.text, text)
  assert.deepEqual(result.assetIds, ['顾凌天_夜行'])
  assert.deepEqual(result.ambiguous, ['顾凌天'])
  assert.deepEqual(result.mentions.map(hit => [hit.id, hit.usage, hit.literal]), [['顾凌天_夜行', 'context', false]])

  const excluded = { ...options, excludedIds: ['顾凌天', '顾凌天_夜行'] }
  assert.equal(scan('前镜回顾：顾凌天先前出镜。', cast, [], excluded).text, '前镜回顾：顾凌天先前出镜。')
  assert.deepEqual(scan('前镜回顾：@顾凌天_夜行曾在门外。', cast, [], excluded).assetIds, ['顾凌天_夜行'])
})

test('非对白的人物 context 多造型必须报歧义，原话和场景道具仍保持原有保护', () => {
  const assets = [
    character('赵峰_便装'), character('赵峰_官服'), character('王禄'),
    { id: 'hall', name: '府邸-前厅', kind: 'scene' }, { id: 'other-hall', name: '官署-前厅', kind: 'scene' },
    { id: 'old-jade', name: '旧玉佩', originalName: '玉佩', kind: 'prop' },
    { id: 'new-jade', name: '新玉佩', originalName: '玉佩', kind: 'prop' },
  ]
  const selected = assets.map(asset => asset.id)
  for (const text of [
    '前镜回顾：赵峰曾在门前。',
    '独立生成：赵峰想起前事。',
    '→衔接至第2段：赵峰走来。',
    '对白／音效：〈衣料摩擦，赵峰的脚步声渐远。〉',
  ]) {
    const result = scan(text, assets, selected, options)
    assert.deepEqual(result.ambiguous, ['赵峰'], text)
    assert.deepEqual(result.problems.map(problem => [problem.type, problem.name, problem.candidates]),
      [['ambiguous', '赵峰', ['赵峰_便装', '赵峰_官服']]], text)
    assert.deepEqual(result.assetIds, [], text)
    assert.equal(result.text, text)
  }
  for (const text of [
    '对白／音效：王禄：“赵峰还在前厅，玉佩也在那里。”',
    '对白／音效：王禄：赵峰还在前厅，玉佩也在那里。',
    '对白／音效：〈录音里提到“赵峰”。〉',
    '前镜回顾：前厅里曾放着玉佩。',
  ]) {
    const result = scan(text, assets, selected, options)
    assert.deepEqual(result.ambiguous, [], text)
    assert.deepEqual(result.problems, [], text)
  }
})
