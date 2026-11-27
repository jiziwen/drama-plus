import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractScriptVideoAssets,
  isScriptVideoAssetExtractionResultUnknown,
  type ScriptVideoAssetExtractionCheckpoint,
  type ScriptVideoAssetExtractionRunner,
} from '../src/services/script-video-asset-extraction.js'
import { mergeScriptVideoVoiceDrafts, scriptVideoVoiceProfileDraftSchema } from '../src/services/script-video-voice-profile.js'

const asset = (
  kind: 'character' | 'scene' | 'prop' | 'creature',
  name: string,
  fields: { identity?: string; aliases?: string[]; reuseId?: string; prompt?: string; voice?: unknown; occurrences?: unknown } = {},
) => ({
  kind, name, assetIdentity: fields.identity || name, aliases: fields.aliases || [],
  imagePrompt: fields.prompt || `为${name}制作完整的中文参考图，统一项目画风。`,
  reuseId: fields.reuseId,
  voice: fields.voice,
  occurrences: fields.occurrences,
})
const scenePrompt = [
  '[0.画风与光影] 写实风格，冷白灯照亮老街铺子。',
  '[1.空间档案] 狭长的老街检修铺。',
  '[2.建筑骨架] 门口朝内通向柜台，水泥地面。',
  '[3.五方十字坐标陈设] 前方为门，后方为柜台，左侧为货架，右侧为工作台，中间是过道。',
  '[4.光影与色彩] 顶部冷白灯，灰色墙面和深色木制柜台。纯空镜。',
].join('\n')

test('资产分段提取记住前段，用别名和项目已存在资产去重，保留明确的不同造型', async () => {
  const existing = { id: 'store', name: '老街铺子', kind: 'scene', aliases: ['小店'] }
  const progress: number[][] = []
  let calls = 0
  const extracted = await extractScriptVideoAssets({
    sources: [
      { title: '首集', episodeNumber: 1, script: '第1场 日 内 小店\n陆宁提着木盒进门检修。\n'.repeat(20) },
      { title: '次集', episodeNumber: 2, script: '深夜，小陆带着同一只木盒回到小店，换上夜行衣。附近的黑猫跟了进来。' },
    ],
    existingAssets: [existing],
    onProgress: (done, total) => progress.push([done, total]),
  }, async ({ instructions, message }) => {
    assert.match(instructions, /原始分镜条例/u)
    assert.match(instructions, /空场景参考母版/u)
    assert.match(instructions, /左侧约占 38%.+正面头部与上半身/u)
    assert.match(instructions, /中央约占 50%/u)
    assert.match(instructions, /严格正面、90 度侧面、180 度背面/u)
    assert.match(instructions, /从颈根展示至鞋底，省略头部/u)
    assert.match(instructions, /背面从头顶到鞋底完整入镜/u)
    assert.match(instructions, /鞋底基线对齐/u)
    assert.match(instructions, /双臂自然垂落，双手放松/u)
    assert.match(instructions, /最右侧约占 12%.+三个矩形细节特写/u)
    assert.doesNotMatch(instructions, /隐形模特|空袖口/u)
    assert.match(instructions, /模型只需返回人物要素和画风，不要重复输出版式或构图要求/u)
    for (const section of ['0.画风与光影', '1.空间档案', '2.建筑骨架', '3.五方十字坐标陈设', '4.光影与色彩']) {
      assert.ok(instructions.includes(`[${section}]`))
    }
    const { episode, known } = JSON.parse(message)
    calls++
    if (calls === 1) return '{"assets":[{"kind":"character","name":"陆'
    if (episode === 1) return JSON.stringify({
      assets: [
        asset('character', '陆宁', { aliases: ['小陆'] }),
        asset('scene', '小店', { prompt: scenePrompt }),
        asset('prop', '木盒'),
      ],
    })
    const normal = known.find((item: { name: string }) => item.name === '陆宁')
    assert.ok(normal.aliases.includes('小陆'))
    assert.ok(known.some((item: { id: string }) => item.id === 'existing-store'))
    return JSON.stringify({
      assets: [
        asset('character', '小陆', { reuseId: normal.id, prompt: '陆宁，平常穿深蓝检修工作服。' }),
        asset('character', '陆宁（夜行衣）', { identity: '陆宁｜夜行衣', aliases: ['小陆'], prompt: '陆宁，换穿黑色夜行衣与软底鞋。' }),
        asset('scene', '老街铺子', { reuseId: 'existing-store', prompt: scenePrompt }),
        asset('prop', '木盒'),
        asset('creature', '黑猫'),
      ],
    })
  })
  assert.equal(calls, 4)
  assert.deepEqual(progress, [[0, 2], [0, 3], [1, 3], [2, 3], [3, 3]])
  assert.equal(extracted.length, 5)
  const regular = extracted.find(item => item.name === '陆宁')
  assert.deepEqual(regular?.sourceEpisodes, [1, 2])
  assert.deepEqual(regular?.sourceTitles, ['首集', '次集'])
  const night = extracted.find(item => item.name === '陆宁（夜行衣）')
  for (const character of [regular, night]) {
    assert.ok(character)
    assert.match(character.imagePrompt, /角色设定参考图（正脸特写＋服装三视图＋细节特写）/u)
    assert.match(character.imagePrompt, /16:9/u)
    assert.match(character.imagePrompt, /严格正面、严格 90 度侧面、严格 180 度背面/u)
    assert.match(character.imagePrompt, /从颈根展示至鞋底/u)
    assert.match(character.imagePrompt, /背面从头顶到鞋底完整入镜/u)
    assert.match(character.imagePrompt, /鞋底基线对齐/u)
    assert.match(character.imagePrompt, /双臂自然垂落，双手放松/u)
    assert.doesNotMatch(character.imagePrompt, /隐形模特|空袖口/u)
    assert.match(character.imagePrompt, /最右侧/u)
    assert.match(character.imagePrompt, /三个矩形细节特写/u)
    assert.doesNotMatch(character.imagePrompt, /\[5\.四宫格多机位排版\]/u)
  }
  assert.ok(regular.imagePrompt.endsWith('陆宁，平常穿深蓝检修工作服。'))
  assert.ok(night.imagePrompt.endsWith('陆宁，换穿黑色夜行衣与软底鞋。'))
  assert.deepEqual(night.sourceEpisodes, [2])
  const scene = extracted.find(item => item.kind === 'scene')
  const prop = extracted.find(item => item.name === '木盒')
  assert.equal(scene?.existingAssetId, 'store')
  assert.ok(scene)
  assert.ok(scene.imagePrompt.includes(scenePrompt))
  assert.match(scene.imagePrompt, /\[5\.四宫格多机位排版\]/u)
  for (const position of ['左上', '右上', '左下', '右下']) assert.ok(scene.imagePrompt.includes(position))
  assert.match(scene.imagePrompt, /左上【老街铺子-正视（朝内）】/u)
  assert.match(scene.imagePrompt, /右上【90°侧视】/u)
  assert.match(scene.imagePrompt, /左下【180°反打（朝入口）】/u)
  assert.match(scene.imagePrompt, /右下【45°全局俯视】/u)
  assert.equal(prop?.imagePrompt, '为木盒制作完整的中文参考图，统一项目画风。')
  assert.deepEqual(prop?.sourceEpisodes, [1, 2])
})

test('长文件按输入长度切分，输入空间不足时继续缩小单批范围', async () => {
  const script = '在老街的小店里，陆宁反复检查柜台上的木盒。\n'.repeat(390)
  let limited = 0
  let processed = 0
  const result = await extractScriptVideoAssets({
    sources: [{ title: '长剧本', script }], existingAssets: [],
  }, async ({ message }) => {
    const { script: part, known } = JSON.parse(message)
    assert.ok(part.length <= 4800)
    if (part.length > 2600) {
      limited++
      throw Object.assign(new Error('上下文超过模型上限'), { code: 'context_length_exceeded' })
    }
    processed++
    if (processed > 1) assert.ok(known.some((item: { name: string }) => item.name === '陆宁'))
    return JSON.stringify({ assets: [asset('character', '陆宁')] })
  })
  assert.ok(limited >= 1)
  assert.ok(processed >= 4)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sourceTitles, ['长剧本'])
})

test('沿用原有提取调用合并同一人物的换装声线，年龄明确不同的造型分别保留', async () => {
  const adult = '陆宁今年三十一岁，说起话来向来语速从容偏慢。'
  const overnight = '小陆换上夜行衣，逐字报出门牌和方位。'
  const memory = '十岁的陆宁第一次站在台上咬字清楚地念完诗。'
  const unclear = '陆宁换上新做的礼服。'
  const sources = [adult, overnight, memory, unclear].map((script, index) => ({ script, title: `第${index + 1}集`, episodeNumber: index + 1 }))
  const variants = [
    asset('character', '陆宁', {
      aliases: ['小陆'],
      voice: {
        character: '陆宁', age: { stage: 'adult', quote: '陆宁今年三十一岁' },
        clues: [{ facet: 'pace', value: '语速从容偏慢', source: 'explicit', quote: adult }],
      },
    }),
    asset('character', '小陆（夜行衣）', {
      identity: '陆宁｜夜行衣',
      voice: {
        character: '小陆',
        clues: [{ facet: 'articulation', value: '咬字清楚', source: 'habit', quote: overnight }],
      },
    }),
    asset('character', '陆宁（童年）', {
      identity: '陆宁｜童年',
      voice: { character: '陆宁', age: { stage: 'child', quote: '十岁的陆宁' } },
    }),
    asset('character', '陆宁（礼服）', { identity: '陆宁｜礼服' }),
  ]
  let calls = 0
  const run = async ({ instructions, message }: { instructions: string; message: string }) => {
    calls++
    assert.match(instructions, /表演情绪、单场哭喊/u)
    const request = JSON.parse(message)
    if (request.episode === 2) assert.equal(request.known[0].voice.character, '陆宁')
    return JSON.stringify({ assets: [variants[request.episode - 1]] })
  }

  const first = await extractScriptVideoAssets({ sources: sources.slice(0, 2), existingAssets: [] }, run)
  assert.equal(calls, 2)
  assert.deepEqual(first.map(item => item.voiceProfile?.key), ['陆宁:adult', '陆宁:adult'])
  assert.deepEqual(first.map(item => item.observedVoiceAge), ['adult', undefined])
  assert.deepEqual(first[0].voiceProfile, first[1].voiceProfile)
  const stored = first.map((item, index) => ({ ...item, id: `asset-${index}` }))
  const second = await extractScriptVideoAssets({ sources: sources.slice(2), existingAssets: stored }, run)
  assert.equal(calls, 4)
  assert.deepEqual(second.map(item => item.voiceProfile?.key), ['陆宁:child', '陆宁:unknown'])
  assert.deepEqual(second.map(item => item.observedVoiceAge), ['child', undefined])
  assert.deepEqual(second[1].voiceProfile?.ageConflict, ['child', 'adult'])
  assert.deepEqual(second[0].voiceProfile?.clues, [])
  assert.deepEqual(second[1].voiceProfile?.clues, [])
  for (const item of [...first, ...second]) assert.ok(scriptVideoVoiceProfileDraftSchema.safeParse(item.voiceProfile).success)
})

test('只累计有原文依据的稳定声音线索，优先明确设定并标出同等级冲突', async () => {
  const lines = [
    '陆宁一字一顿地报出姓名。他在情急之下怒吼。',
    '陆宁在柜台前一字一顿地交代约定。',
    '人物设定：陆宁讲话利落，语速偏快。',
    '人物设定：陆宁平时说得很慢，语速偏慢。',
  ]
  const clues = [
    [
      { facet: 'pace', value: '有明显停顿', source: 'habit', quote: lines[0].split('。')[0] },
      { facet: 'timbre', value: '暴躁尖锐', source: 'explicit', quote: '他在情急之下怒吼' },
      { facet: 'register', value: '高音', source: 'explicit', quote: '这句并未出现在剧本里' },
    ],
    [{ facet: 'pace', value: '有明显停顿。', source: 'habit', quote: lines[1] }],
    [{ facet: 'pace', value: '语速偏快', source: 'explicit', quote: lines[2] }],
    [{ facet: 'pace', value: '语速偏慢', source: 'explicit', quote: lines[3] }],
  ]
  const draft = async (index: number) => {
    const assets = await extractScriptVideoAssets({
      sources: [{ title: `第${index + 1}集`, episodeNumber: index + 1, script: lines[index] }], existingAssets: [],
    }, async () => JSON.stringify({ assets: [asset('character', '陆宁', { voice: { character: '陆宁', clues: clues[index] } })] }))
    const result = assets[0].voiceProfile
    assert.ok(result)
    return result
  }
  const [first, second, third, fourth] = await Promise.all(lines.map((_, index) => draft(index)))
  assert.deepEqual(first.clues, [])
  assert.deepEqual(first.observations?.map(clue => clue.value), ['有明显停顿'])
  assert.deepEqual(mergeScriptVideoVoiceDrafts([first, first]).clues, [])
  const recalled = mergeScriptVideoVoiceDrafts([first, second])
  assert.deepEqual(recalled.clues[0].evidence.map(item => item.episodeNumber), [1, 2])
  const explicit = mergeScriptVideoVoiceDrafts([recalled, third])
  assert.deepEqual(explicit.clues.map(({ value, source }) => [value, source]), [['语速偏快', 'explicit']])
  const conflict = mergeScriptVideoVoiceDrafts([explicit, fourth])
  assert.deepEqual(conflict.clues, [])
  assert.deepEqual(conflict.conflicts.map(clue => clue.value), ['语速偏快', '语速偏慢'])
  assert.deepEqual(conflict, mergeScriptVideoVoiceDrafts([fourth, third, second, first]))
})

test('同一视觉资产的明确年龄冲突保留资产 ID 并等待选择，坏声音字段不影响视觉提取', async () => {
  const sources = [
    { title: '回忆', episodeNumber: 1, script: '八岁的陆宁走进剧场。' },
    { title: '现在', episodeNumber: 2, script: '三十岁的陆宁走进剧场。' },
  ]
  const extracted = await extractScriptVideoAssets({
    sources, existingAssets: [{ id: 'existing-visual', name: '陆宁', kind: 'character', assetIdentity: '陆宁' }],
  }, async ({ message }) => {
    const request = JSON.parse(message)
    return JSON.stringify({ assets: [
      asset('character', '陆宁', {
        voice: {
          age: { stage: request.episode === 1 ? 'child' : 'adult', quote: request.script },
          clues: [{ facet: 'accent', value: 4, source: 'explicit', quote: request.script }],
        },
      }),
      asset('character', '台下观众', { voice: 'invalid' }),
      asset('scene', '剧场', { voice: { character: '陆宁' } }),
    ] })
  })
  assert.equal(extracted.length, 3)
  const character = extracted.find(asset => asset.name === '陆宁')
  assert.equal(character?.existingAssetId, 'existing-visual')
  assert.deepEqual(character?.sourceEpisodes, [1, 2])
  assert.equal(character?.voiceProfile?.ageStage, 'unknown')
  assert.equal(character?.observedVoiceAge, undefined)
  assert.deepEqual(character?.voiceProfile?.ageConflict, ['child', 'adult'])
  assert.deepEqual(character?.voiceProfile?.ageEvidence?.map(({ title, quote }) => [title, quote]), sources.map(({ title, script }) => [title, script]))
  assert.deepEqual(character?.voiceProfile?.clues, [])
  assert.equal(extracted.find(asset => asset.kind === 'scene')?.voiceProfile, undefined)
})

test('保留已有音色的未分类角色为一般换装默认项，避免跟随新增童年造型', async () => {
  const extracted = await extractScriptVideoAssets({
    sources: [{ title: '交替出场', script: '十岁的陆宁接受考核。陆宁换上黑色夜行衣。' }],
    existingAssets: [{
      id: 'existing-visual', name: '陆宁', kind: 'character', assetIdentity: '陆宁', voiceLocked: true,
      voiceProfile: { key: '陆宁:unknown', character: '陆宁', ageStage: 'unknown', clues: [], conflicts: [] },
    }],
  }, async () => JSON.stringify({ assets: [
    asset('character', '陆宁（童年）', {
      identity: '陆宁｜童年', voice: { age: { stage: 'child', quote: '十岁的陆宁' } },
    }),
    asset('character', '陆宁（夜行衣）', { identity: '陆宁｜夜行衣' }),
  ] }))
  assert.deepEqual(extracted.map(item => item.voiceProfile?.key), ['陆宁:child', '陆宁:unknown'])
  assert.equal(extracted[1].voiceProfile?.ageConflict, undefined)
})

test('从同一轮提取保存逐字出现证据，按原文章节边界定位且忽略坏字段', async () => {
  const first = '小师姐扣好衣襟。'
  const second = '小师姐停在桥头。'
  const duplicate = '小师姐往里走。'
  const script = [
    '阿宁在片头起身。', '**场次**：4-01', '**场景**：药房', first, duplicate, duplicate,
    '店员端药。', '**场次**：4-02', '**场景**：桥头', second,
  ].join('\n')
  const sources = [{ title: '第4集', script, episodeNumber: 4 }, { title: '番外', script: '林宁开门。' }]
  let calls = 0
  const extracted = await extractScriptVideoAssets({ sources, existingAssets: [] }, async ({ message, instructions }) => {
    calls++
    assert.match(instructions, /occurrences.*逐字/u)
    const { episode } = JSON.parse(message)
    return JSON.stringify({ assets: [
      asset('character', '林宁（夜行衣）', { identity: '林宁｜夜行衣', aliases: ['小师姐', '阿宁'], occurrences: episode === 4 ? [
        { label: '阿宁', quote: '阿宁在片头起身。', sceneId: '9-99' },
        { label: '小师姐', quote: first, sceneId: '9-99', sceneTitle: '捏造地点' },
        { label: '小师姐', quote: first },
        { label: '小师姐', quote: second },
        { label: '小师姐', quote: duplicate },
        { label: '小师姐', quote: '小师姐在宫里休息。' },
        { label: '店员', quote: '店员端药。' },
        { label: '老师姐', quote: '小师姐停在桥头。' },
        { label: '小师姐', quote: script.slice(script.indexOf('店员端药。')) },
        { label: 3, quote: '小师姐停在桥头。' },
      ] : [{ label: '林宁', quote: '林宁开门。' }] }),
      asset('scene', '桥头', { occurrences: episode === 4 ? '旧版格式' : undefined }),
    ] })
  })
  assert.equal(calls, 2)
  assert.deepEqual(extracted[0].occurrences, [
    { label: '阿宁', quote: '阿宁在片头起身。', offset: 0, sourceTitle: '第4集', episodeNumber: 4 },
    { label: '小师姐', quote: first, offset: script.indexOf(first), sourceTitle: '第4集', episodeNumber: 4, sceneId: '4-01', sceneTitle: '药房' },
    { label: '小师姐', quote: second, offset: script.indexOf(second), sourceTitle: '第4集', episodeNumber: 4, sceneId: '4-02', sceneTitle: '桥头' },
    { label: '林宁', quote: '林宁开门。', offset: 0, sourceTitle: '番外' },
  ])
  assert.deepEqual(extracted[1].sourceEpisodes, [4])
  assert.equal(extracted[1].occurrences, undefined)
})

test('从持久化分段恢复，保留拆分顺序、资产记忆和此前声音依据', async () => {
  const opening = '三十岁的陆宁一字一顿地报出姓名。'
  const later = '小陆一字一顿地告诉同伴约定。'
  const setup = {
    sources: [
      { title: '开场', episodeNumber: 1, script: opening },
      { title: '续集', episodeNumber: 2, script: `${'众人在小店重新收好货品。'.repeat(22)}\n\n  ${later}${'店员放下货箱。'.repeat(25)}` },
    ],
    existingAssets: [{ id: 'store', name: '老街铺子', kind: 'scene', aliases: ['小店'] }],
    style: '写实风格',
  }
  const snapshots: ScriptVideoAssetExtractionCheckpoint[] = []
  const progress: number[][] = []
  let failedRequest: string | undefined
  let acceptedParts = 0
  const respond = ({ message }: { message: string }) => {
    const { script, known, episode } = JSON.parse(message)
    if (episode === 1) return JSON.stringify({ assets: [
      asset('character', '陆宁', { aliases: ['小陆'], occurrences: [{ label: '陆宁', quote: opening }], voice: {
        character: '陆宁', age: { stage: 'adult', quote: '三十岁的陆宁' },
        clues: [{ facet: 'pace', value: '语速分明', source: 'habit', quote: opening }],
      } }),
      asset('scene', '小店', { reuseId: 'existing-store', prompt: scenePrompt }),
    ] })
    if (script.length > 360) return JSON.stringify({ assets: [], incomplete: true })
    if (!script.includes(later)) return JSON.stringify({ assets: [asset('prop', '货箱')] })
    const remembered = known.find((item: { name: string }) => item.name === '陆宁')
    assert.deepEqual(remembered.aliases, ['小陆'])
    assert.equal(remembered.voice.ageStage, 'adult')
    return JSON.stringify({ assets: [asset('character', '小陆', { reuseId: remembered.id, occurrences: [{ label: '小陆', quote: later }], voice: {
      character: '陆宁', clues: [{ facet: 'pace', value: '语速分明', source: 'habit', quote: later }],
    } })] })
  }
  const disconnected = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  await assert.rejects(extractScriptVideoAssets({
    ...setup, model: 'first-model', configId: 1,
    onCheckpoint: async checkpoint => {
      await Promise.resolve()
      snapshots.push(checkpoint)
    },
    onProgress: (done, total) => progress.push([done, total]),
  }, async request => {
    assert.ok(snapshots.length)
    const { episode, script } = JSON.parse(request.message)
    assert.equal(snapshots.at(-1)?.pending[0]?.sourceIndex, episode - 1)
    if (episode === 2 && script.length <= 360 && script.includes(later)) {
      failedRequest = request.message
      throw disconnected
    }
    const result = respond(request)
    if (episode === 1 || script.length <= 360) acceptedParts++
    return result
  }), error => error === disconnected)

  assert.equal(acceptedParts, 2)
  assert.deepEqual(progress, [[0, 2], [1, 2], [1, 3], [2, 3]])
  assert.equal(snapshots[0].pending.length, 2)
  const stopped = snapshots.at(-1)
  assert.ok(stopped && failedRequest)
  const serialized = JSON.stringify(stopped)
  assert.ok(!serialized.includes('众人在小店重新收好货品。'.repeat(22)))
  assert.ok(!serialized.includes('"existing":'))
  const checkpoint: ScriptVideoAssetExtractionCheckpoint = JSON.parse(serialized)
  let resumedCalls = 0
  let complete: ScriptVideoAssetExtractionCheckpoint | undefined
  const resumed = await extractScriptVideoAssets({
    ...setup, model: 'backup-model', configId: 2, checkpoint,
    onCheckpoint: state => { complete = JSON.parse(JSON.stringify(state)) },
  }, async request => {
    resumedCalls++
    assert.equal(request.message, failedRequest)
    return respond(request)
  })
  assert.equal(resumedCalls, 1)
  assert.ok(complete)
  assert.deepEqual(complete.pending, [])
  const expected = await extractScriptVideoAssets(setup, async request => respond(request))
  assert.deepEqual(JSON.parse(JSON.stringify(resumed)), JSON.parse(JSON.stringify(expected)))
  assert.deepEqual(resumed.map(item => item.kind), ['scene', 'character', 'prop'])
  assert.deepEqual(resumed[1].occurrences?.map(item => [item.label, item.episodeNumber]), [['陆宁', 1], ['小陆', 2]])
  assert.deepEqual(resumed[1].voiceProfile?.clues[0].evidence.map(item => item.episodeNumber), [1, 2])
  assert.deepEqual(await extractScriptVideoAssets({ ...setup, checkpoint: complete, model: 'missing-config', configId: -1 }), resumed)

  // The previous checkpoint format stores source episodes without occurrence evidence.
  const legacy = structuredClone(checkpoint)
  for (const saved of legacy.known) delete saved.extracted.occurrences
  const upgraded = await extractScriptVideoAssets({ ...setup, checkpoint: legacy }, async request => {
    assert.equal(request.message, failedRequest)
    return respond(request)
  })
  assert.deepEqual(upgraded[1].sourceEpisodes, [1, 2])
  assert.deepEqual(upgraded[1].occurrences?.map(item => [item.label, item.episodeNumber]), [['小陆', 2]])

  await assert.rejects(extractScriptVideoAssets({ ...setup, style: '其他风格', checkpoint }, async () => assert.fail('invalid checkpoint sent a request')), /进度与原任务不一致/u)
})

test('分段仅对明确未发送或临时限流补试一次，并与无效 JSON 共享两次请求上限', async () => {
  const input = { sources: [{ title: '试读', script: '陆宁走进店里。' }], existingAssets: [] }
  const beforeTls = new Error('transport', { cause: Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }) })
  const rateLimit = Object.assign(new Error('Too Many Requests'), { statusCode: 429, data: { error: { code: 'rate_limit_exceeded' } } })
  await Promise.all([beforeTls, rateLimit].map(async error => {
    let attempts = 0
    const results = await extractScriptVideoAssets(input, async ({ instructions }) => {
      assert.doesNotMatch(instructions, /上一次回复无法读取/u)
      if (++attempts === 1) throw error
      return JSON.stringify({ assets: [asset('character', '陆宁')] })
    })
    assert.equal(isScriptVideoAssetExtractionResultUnknown(error), false)
    assert.equal(attempts, 2)
    assert.equal(results.length, 1)
  }))

  const scenarios: { first?: string; error: unknown; expected: number }[] = [
    { error: Object.assign(new Error('quota rejected'), { statusCode: 429, data: { error: { code: 'insufficient_quota' } } }), expected: 1 },
    { error: Object.assign(new Error('Too Many Requests'), { statusCode: 429, responseHeaders: { 'Retry-After': '30' } }), expected: 1 },
    { error: Object.assign(new Error('unauthorized'), { statusCode: 401 }), expected: 1 },
    { error: new Error('could not connect', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }), expected: 2 },
    { first: 'not JSON', error: beforeTls, expected: 2 },
    { first: 'not JSON', error: rateLimit, expected: 2 },
  ]
  await Promise.all(scenarios.map(async ({ first, error, expected }) => {
    let attempts = 0
    const run: ScriptVideoAssetExtractionRunner = async ({ instructions }) => {
      attempts++
      if (attempts === 1 && first) return first
      if (first) assert.match(instructions, /上一次回复无法读取/u)
      throw error
    }
    await assert.rejects(extractScriptVideoAssets(input, run), caught => caught === error)
    assert.equal(attempts, expected)
  }))
})

test('可能已经送达的请求不自动重发，保留未完成分段和原检查点', async () => {
  const input = { sources: [{ title: '试读', script: '陆宁走进店里。' }], existingAssets: [] }
  for (const error of [
    new Error('Cannot connect to API: other side closed'),
    new Error('transport', { cause: Object.assign(new Error('socket cut'), { code: 'ECONNRESET' }) }),
    new Error('transport', { cause: Object.assign(new Error('socket cut'), { code: 'UND_ERR_SOCKET', socket: { bytesWritten: 2400, bytesRead: 0 } }) }),
    Object.assign(new Error('headers expired'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    Object.assign(new Error('body expired'), { code: 'UND_ERR_BODY_TIMEOUT' }),
    new TypeError('terminated'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    ...[408, 502, 503, 504, 524].map(statusCode => Object.assign(new Error('gateway response'), { statusCode })),
    Object.assign(new Error('gateway response'), { statusCode: 524, responseBody: 'maximum context length exceeded' }),
    new Error('Error code 524: A timeout occurred'),
  ]) {
    let attempts = 0
    const checkpoints: ScriptVideoAssetExtractionCheckpoint[] = []
    assert.equal(isScriptVideoAssetExtractionResultUnknown(error), true, error.message)
    await assert.rejects(extractScriptVideoAssets({ ...input, onCheckpoint(state) { checkpoints.push(state) } }, async () => {
      attempts++
      throw error
    }), caught => caught === error)
    assert.equal(attempts, 1, error.message)
    assert.deepEqual(checkpoints.map(state => [state.done, state.pending.length]), [[0, 1]])
  }
})

test('分段进度写入失败时不发送下一次模型请求', async () => {
  let attempts = 0
  const writeError = new Error('write failed')
  await assert.rejects(extractScriptVideoAssets({
    sources: [{ title: '1', script: '陆宁出现。' }, { title: '2', script: '陆宁离开。' }],
    existingAssets: [],
    onCheckpoint: async state => {
      if (state.done === 1) throw writeError
    },
  }, async () => {
    attempts++
    return JSON.stringify({ assets: [asset('character', '陆宁')] })
  }), error => error === writeError)
  assert.equal(attempts, 1)
})

test('一键提取使用所选模型的流式文本响应，整段完成后才写入资产', async t => {
  const previousDb = process.env.SQLITE_PATH
  const previousImport = process.env.MYSQL_AUTO_IMPORT
  process.env.SQLITE_PATH = ':memory:'
  process.env.MYSQL_AUTO_IMPORT = 'false'
  t.after(() => {
    if (previousDb === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = previousDb
    if (previousImport === undefined) delete process.env.MYSQL_AUTO_IMPORT
    else process.env.MYSQL_AUTO_IMPORT = previousImport
  })
  const { db, schema } = await import('../src/db/index.js')
  const baseUrl = 'https://asset-extraction.invalid'
  const now = new Date().toISOString()
  const { id: configId } = db.insert(schema.aiServiceConfigs).values({
    name: '资产流式测试', serviceType: 'text', provider: 'openai', apiKey: 'fixture',
    baseUrl, model: '["large-asset-model","small-asset-model"]', isActive: true, createdAt: now, updatedAt: now,
  }).returning().get()
  const input = { configId, model: 'large-asset-model', sources: [{ title: '试读', script: '小禾拾起木盒。' }], existingAssets: [] }
  const candidate = JSON.stringify({ assets: [asset('prop', '木盒')] })
  const requests: Array<{ model: string; stream: boolean; max_tokens: number; messages: { role: string; content: string }[] }> = []
  const replies: Response[] = []
  const sseHeaders = { 'content-type': 'text/event-stream' }
  const delta = (content: string, finish: 'stop' | 'length' | null = null) => 'data: ' + JSON.stringify({
    id: 'extraction', created: 1, model: input.model,
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  }) + '\n\n'
  const done = 'data: [DONE]\n\n'
  t.mock.method(globalThis, 'fetch', async (raw: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(raw instanceof Request ? raw.url : String(raw))
    assert.equal(url.origin, baseUrl)
    if (init?.method === 'GET') {
      const model = url.pathname.split('/').at(-1)!
      return Response.json({ id: model, max_output_tokens: model === input.model ? 64000 : 4096, max_input_tokens: 99000 })
    }
    assert.equal(url.pathname, '/v1/chat/completions')
    requests.push(JSON.parse(String(init?.body)))
    const reply = replies.shift()
    assert.ok(reply, 'unexpected generation request')
    return reply
  })

  await t.test('单个流式请求拼接文本并遵守提取预算', async () => {
    const body = new TransformStream<Uint8Array, Uint8Array>()
    const writer = body.writable.getWriter()
    replies.push(new Response(body.readable, { headers: sseHeaders }))
    const snapshots: ScriptVideoAssetExtractionCheckpoint[] = []
    const completed = extractScriptVideoAssets({ ...input, onCheckpoint(state) { snapshots.push(state) } })
    const encoder = new TextEncoder()
    await writer.write(encoder.encode(delta('```json\n' + candidate.slice(0, 27))))
    await writer.write(encoder.encode(delta(candidate.slice(27) + '\n```')))
    assert.deepEqual(snapshots.map(s => [s.done, s.known.length]), [[0, 0]])
    await writer.write(encoder.encode(delta('', 'stop') + done))
    await writer.close()
    const result = await completed
    assert.deepEqual(result.map(item => item.name), ['木盒'])
    assert.deepEqual(snapshots.map(s => [s.done, s.known.length]), [[0, 0], [1, 1]])
    assert.equal(requests.length, 1)
    assert.equal(requests[0].stream, true)
    assert.equal(requests[0].max_tokens, 12000)
    assert.equal(requests[0].model, input.model)
    assert.deepEqual(requests[0].messages.map(m => m.role), ['system', 'user'])
  })

  await t.test('可解析的清单遇到提前结束仍保留原检查点并等待显式续跑', async () => {
    const text = delta(candidate)
    const brokenSocket = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(text)) },
      pull(controller) { controller.error(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })) },
    })
    const rateLimit = { error: { message: 'HTTP 429 too many requests', type: 'rate_limit_error', code: 'rate_limit_error' } }
    const lateRateLimit = delta('{"assets":[') + 'data: ' + JSON.stringify(rateLimit) + '\n\n' + done
    for (const body of [text, brokenSocket, lateRateLimit]) {
      const start = requests.length
      replies.push(new Response(body, { headers: sseHeaders }))
      const snapshots: ScriptVideoAssetExtractionCheckpoint[] = []
      await assert.rejects(extractScriptVideoAssets({
        ...input, onCheckpoint(state) { snapshots.push(state) },
      }), isScriptVideoAssetExtractionResultUnknown)
      assert.deepEqual(snapshots.map(s => [s.done, s.known.length, s.pending.length]), [[0, 0, 1]])
      assert.equal(requests.length, start + 1)
    }
  })

  await t.test('首个流事件返回供应商错误时显示错误信息并保留原始原因', async () => {
    const start = requests.length
    const failure = { message: '账户可用额度不足', type: 'insufficient_quota', code: 'insufficient_quota', param: null }
    replies.push(new Response('data: ' + JSON.stringify({ error: failure }) + '\n\n' + done, { headers: sseHeaders }))
    await assert.rejects(extractScriptVideoAssets(input), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, failure.message)
      assert.deepEqual(error.cause, failure)
      assert.equal(isScriptVideoAssetExtractionResultUnknown(error), false)
      return true
    })
    assert.equal(requests.length, start + 1)
  })

  await t.test('明确的长度截断拆成较短两段，模型上限低于提取预算时取模型上限', async () => {
    const start = requests.length
    const script = '小禾走进房间，拾起木盒。'.repeat(27)
    const discarded = JSON.stringify({ assets: [asset('prop', '废稿')] })
    replies.push(...[delta(discarded, 'length'), delta(candidate, 'stop'), delta(candidate, 'stop')]
      .map(s => new Response(s + done, { headers: sseHeaders })))
    const result = await extractScriptVideoAssets({ ...input, model: 'small-asset-model', sources: [{ title: '长段', script }] })
    assert.deepEqual(result.map(item => item.name), ['木盒'])
    const sent = requests.slice(start)
    assert.equal(sent.length, 3)
    assert.ok(sent.every(r => r.stream && r.max_tokens === 4096 && r.model === 'small-asset-model'))
    const parts = sent.map(r => JSON.parse(r.messages.find(m => m.role === 'user')!.content).script)
    assert.equal(parts[0], script)
    assert.ok(parts[1].length > 0 && parts[2].length > 0)
    assert.equal(parts[1] + parts[2], script)
  })
})
