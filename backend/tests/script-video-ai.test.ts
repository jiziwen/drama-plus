import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  assertScriptVideoCards,
  assertScriptVideoFormal,
  generateScriptVideoCards,
  generateScriptVideoOutline,
  reviseScriptVideoCard,
  reviewScriptVideoEpisode,
  ScriptVideoAIError,
  type ScriptVideoModelRequest,
  type ScriptVideoStoryboardCheckpoint,
} from '../src/services/script-video-ai.js'
import {
  renderScriptVideoPrompt,
  replaceScriptVideoPromptStyle,
} from '../src/services/script-video-format.js'
import {
  SCRIPT_VIDEO_STYLE_PRESETS,
  getScriptVideoStylePreset,
  formatScriptVideoStylePreset,
  scriptVideoPromptStylePrefix,
  isScriptVideoStylePreset,
} from '../src/services/script-video-style.js'
import {
  scriptVideoCharacterBase,
  scriptVideoCharacterName,
} from '../src/services/script-video-asset-identity.js'
import { loadScriptVideoSkill } from '../src/services/script-video-skill.js'
import { buildScriptVideoDelivery } from '../src/services/script-video-delivery.js'
import { scriptVideoCultivationFinalShot, scriptVideoCultivationVoiceSummary } from '../src/services/script-video-cultivation.js'
import {
  resolveScriptVideoMentions,
  getScriptVideoOutlineDurationIssues,
  getScriptVideoContentWarnings,
  sourceDialogue,
  type ScriptVideoCard,
} from '../src/services/script-video-types.js'

const input = {
  projectTitle: '归途',
  episodeNumber: 2,
  script: '场景：旧院 门-清晨\n小禾（轻声）：“我回来了。”\n她推开院门。\n小白：等等我！',
  assets: [
    {
      id: 'yuan',
      name: '旧院 门-清晨',
      kind: 'scene',
      image: 'blob:private',
      sourcePath: '/Users/private/file.png',
    },
  ],
  configId: 15,
  model: 'actual-text-model',
}
const outline = {
  id: 'card-1',
  title: '院门相逢',
  duration: 4.5,
  summary: '小禾推门，小白追上。',
  assetIds: ['yuan'],
  combat: false,
  prompt: '',
  shots: [],
  status: 'draft',
  version: 1,
} satisfies ScriptVideoCard
const production = {
  coreRhythm: '小禾先推门，小白随后追到。',
  visualSpecs: '画幅依项目设定，清晨自然光。',
  shotRhythm: '推门切到门外反打。',
  dialogueRules: '现场原词逐字。',
  interfaceRules: '本场无界面。',
  costumeRules: '不新增服饰。',
  sceneAndCamera: '屋内看院门时小禾在画右；门外反打保持朝向。',
  soundAndEditing: '门轴轻响后听见小白的声音。',
  continuityReview: '前镜门扇尚在转动，后镜小白到门口。',
  characters: [
    { name: '小禾', appearance: '站在门内右侧', voice: '轻柔女声；推门时轻声开口。' },
    { name: '小白', appearance: '由门外靠近', voice: '远处急呼' },
  ],
}
const card: ScriptVideoCard = {
  ...outline,
  opening: '没有前场末帧，起于清晨小禾站在门内。',
  scene: '2-01｜旧院 门-清晨｜门扇紧闭。',
  characters: '小禾在门内，小白在门外。',
  independentGeneration: '先见小禾推开右侧门扇，后见小白从门外追来。',
  ending: '门扇朝内，小白的左手刚扶上门框。',

  prompt: '@旧院 门-清晨，小禾说：“我回来了。” 小白喊：“等等我！”',
  shots: [
    {
      id: 's1',
      duration: 2.2,
      camera: '近景推',
      action: '小禾推门',
      dialogue: '门轴轻响。小禾【低声】：“我回来了。”',
    },
    {
      id: 's2',
      duration: 2.3,
      camera: '中景固定',
      action: '小白从门外追上',
      dialogue: '小白【急声】：“等等我！”脚步声停在门外。',
    },
  ],
}
const hasIssue = (code: string) => (e: unknown) =>
  e instanceof ScriptVideoAIError && e.issues.some((issue) => issue.code === code)
function assertContentWarning(data: Parameters<typeof assertScriptVideoCards>[0], code: string) {
  assert.doesNotThrow(() => assertScriptVideoCards(data))
  assert.ok(getScriptVideoContentWarnings(data).some(issue => issue.code === code), code)
}

test('outline consumes shared planning instructions and emits editable outline cards', async () => {
  const result = await generateScriptVideoOutline(input, async (request) => {
    assert.equal(request.stage, 'outline')
    assert.equal(request.configId, 15)
    assert.equal(request.model, 'actual-text-model')
    const modelData = JSON.parse(request.message)
    assert.deepEqual(modelData.sourceSpokenLines, [
      { speaker: '小禾', text: '我回来了。' },
      { speaker: '小白', text: '等等我！' },
    ])
    assert.deepEqual(modelData.assets, [{ id: 'yuan', name: '旧院 门-清晨', kind: 'scene' }])
    assert.ok(!request.message.includes('blob:') && !request.message.includes('/Users/'))
    assert.match(request.instructions, /剧本转视频分段大纲/u)
    assert.match(request.instructions, /大纲包含每段目标时长/u)
    assert.ok(
      request.instructions.includes(
        await request.readSkill('分段大纲.md'),
      ),
    )
    await assert.rejects(request.readSkill('SKILL.md'))
    await assert.rejects(request.readSkill('../.env'))
    await assert.rejects(
      request.readSkill('references/sd25-v2.1/scripts/check_storyboard_duration.py'),
    )
    return { cards: [card] }
  })
  assert.equal(result.cards.length, 1)
  assert.notEqual(result.cards[0].id, card.id)
  assert.deepEqual(result.cards[0].shots, [])
  assert.equal(result.cards[0].prompt, '')
  assert.equal(result.attempts, 1)
  assert.ok(result.skillReads.some((p) => p.includes('03-项目设定卡')))
  assert.ok(
    !result.skillReads.some((p) => p.includes('v8-core') || p.includes('fight-choreography')),
  )
})

test('cultivation uses the full supplied skill and renders its timeline and voice lines from validated shots', async () => {
  const file = 'cultivation/SD2.5_30秒连续3D动漫分镜第三版.txt'
  const source = await readFile(new URL('../workspace/skills/script-to-video/' + file, import.meta.url))
  assert.equal(createHash('sha256').update(source).digest('hex'), 'cfeab082728131a020972cf464df003815fdeab9dbcd52dd58681efe64854589')
  const script = input.script.replace('小白：', '小白（OS）：')
  await generateScriptVideoOutline({ ...input, script, storyboardMode: 'cultivation' }, async request => {
    assert.match(request.instructions, /剧本转视频分段大纲/u)
    assert.ok(!request.instructions.includes('连续3D动漫交互式分镜'))
    return { cards: [outline] }
  })
  const draft = {
    ...card,
    shots: [
      { ...card.shots[0], action: '小禾推门。\n情绪提示：神情谨慎。',
        dialogue: '小禾【女｜青年感｜清亮女声｜谨慎｜轻声｜正常语速｜对白（1/1）｜中文普通话】：「我回来了。」\n音效：门轴轻响。' },
      { ...card.shots[1], action: '小白从门外追上。\n情绪提示：眼神急切。',
        dialogue: '小白 (OS)【男｜青年感｜清朗男声｜急切｜中等音量｜正常偏快｜OS（1/1）｜中文普通话】：「等等我！」\n音效：脚步停在门外。' },
    ],
  }
  const result = await generateScriptVideoCards({ ...input, script, outline: [outline], storyboardMode: 'cultivation' }, async request => {
    assert.equal(request.mode, 'episode')
    assert.ok(request.instructions.includes(source.toString('utf8')))
    assert.match(request.instructions, /修仙分镜项目适配/u)
    assert.ok(!request.instructions.includes('原版完整资料清单'))
    return { production, cards: [draft] }
  })
  const delivery = buildScriptVideoDelivery(result.cards[0], input.assets)
  assert.match(delivery.prompt, /【0s-2\.2s】\n运镜：[^\n]+\n动作：[^\n]+\n【配音指令】：小禾｜女｜[^\n]+「我回来了。」\n声效：门轴轻响。\n情绪提示：神情谨慎。/u)
  assert.match(delivery.prompt, /【2\.2s-4\.5s】[\s\S]+【配音指令】：小白｜男｜[^\n]+OS（1\/1）｜中文普通话｜「等等我！」/u)
  assert.ok(!delivery.prompt.includes('人物声音统计'))
  assert.deepEqual(scriptVideoCultivationFinalShot(delivery.prompt), { number: 2, start: 2.2, end: 4.5 })
  assert.deepEqual(scriptVideoCultivationVoiceSummary(result.cards[0].shots)?.map(role => [role.name, role.dialogue, role.innerVoice]),
    [['小禾', 1, 0], ['小白', 0, 1]])

  const assets = [...input.assets, { id: 'he', name: '小禾', kind: 'character', image: 'blob:he',
    voiceAudio: { name: '小禾原声', url: 'blob:voice' } }]
  const voiced = { ...result.cards[0], assetIds: ['yuan', 'he'] }
  voiced.prompt = renderScriptVideoPrompt(voiced, assets)
  const withVoice = buildScriptVideoDelivery(voiced, assets, { model: 'doubao-seedance-2-5-260628', provider: 'volcengine' })
  assert.equal(withVoice.voices[0]?.roles[0]?.id, 'he')
  assert.match(withVoice.prompt, /【配音指令】：@图片\d+小禾｜女｜青年感｜[^｜]+音色参考@音频1｜/u)
})

test('formal generation enforces exact decimals, repaired candidates use same script/config and invalid drafts never escape', async () => {
  const seen: ScriptVideoModelRequest[] = []
  const result = await generateScriptVideoCards({ ...input, outline: [outline] }, async (req) => {
    seen.push(req)
    if (seen.length === 1)
      return {
        production,
        cards: [
          {
            ...card,
            prompt: card.prompt.replace('等等我', '别走'),
            shots: [
              { ...card.shots[0], duration: 2.1 },
              { ...card.shots[1], dialogue: '小白【急声】：“别走！”' },
            ],
          },
        ],
      }
    assert.match(req.message, /DUR009/)
    assert.doesNotMatch(req.message, /DIALOGUE_CHANGED/)
    return { patches: [{ id: card.id, shots: [{ index: 1, duration: 2.2 }] }] }
  })
  assert.equal(result.attempts, 2)
  assert.equal(seen[1].configId, seen[0].configId)
  assert.equal(result.cards[0].id, outline.id)
  assert.ok(result.cards[0].shots.every((shot) => shot.id))
  assert.ok(result.warnings.some(issue => issue.code === 'DIALOGUE_CHANGED'))
  assert.ok(result.skillReads.some((p) => p.includes('08-交付前自检表')))
  let attempts = 0
  await assert.rejects(
    generateScriptVideoCards({ ...input, outline: [outline] }, async req => {
      attempts++
      if (req.mode === 'repair') {
        assert.match(req.instructions, /内心 OS.*仅在这句心声期间闭口、嘴唇不动、不对口型/u)
        assert.match(req.instructions, /说话或出列的镜头.*站位.*服色、头饰、伤势位置/u)
        assert.match(req.instructions, /只有内心 OS 的镜头.*让嘴不入画/u)
        return { patches: [{ id: card.id, shots: [{ index: 1, duration: 2.1 }] }] }
      }
      return { production, cards: [{ ...card, scene: '2-01｜@旧院 门-黄昏｜门扇紧闭',
        shots: [{ ...card.shots[0], duration: 2.1 }, card.shots[1]] }] }
    }),
    hasIssue('DUR009'),
  )
  assert.equal(attempts, 4)
  const advisory = await generateScriptVideoCards({ ...input, outline: [outline] }, async request => {
    assert.equal(request.mode, 'episode')
    return { production, cards: [{ ...card, scene: '2-01｜@旧院 门-黄昏｜门扇紧闭' }] }
  })
  assert.equal(advisory.attempts, 1)
  assert.ok(advisory.warnings.some(issue => issue.code === 'ASSET_MENTION_UNKNOWN'))
})

test('preflight keeps dialogue differences advisory and supports split lines', () => {
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input, cards: [card] }))
  const split = {
    ...card,
    shots: [
      { ...card.shots[0], duration: 1, dialogue: '小禾：“我回”' },
      { ...card.shots[0], id: 's1-continuation', duration: 1.2, dialogue: '小禾：“来了。”' },
      card.shots[1],
    ],
  }
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input, cards: [split] }))
  const changed = {
    ...card,
    shots: [{ ...card.shots[0], dialogue: '小禾：“我回了。”' }, card.shots[1]],
  }
  assertContentWarning({ ...input, cards: [changed] }, 'DIALOGUE_CHANGED')
  const wrongSpeaker = {
    ...card,
    shots: [{ ...card.shots[0], dialogue: '小白：“我回来了。”' }, card.shots[1]],
  }
  assertContentWarning({ ...input, cards: [wrongSpeaker] }, 'DIALOGUE_SPEAKER')
  assertContentWarning({ ...input,
    cards: [{ ...card, shots: [{ ...card.shots[0], duration: 4.5 }] }],
  }, 'DIALOGUE_MISSING')
  const late = {
    ...card,
    prompt: '@旧院 门-清晨，小白喊：“等等我！”',
    shots: [{ ...card.shots[1], duration: 4.5 }],
  }
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input, cards: [late], scope: 'card' }))
  assertContentWarning({ ...input,
    cards: [{ ...card, prompt: card.prompt + ' 他喊：“新加的誓言！”' }],
  }, 'PROMPT_DIALOGUE_NEW')
})
test('reject unknown asset suffix, duplicate/missing binding, prefer full imported name including spaces', () => {
  const assets = [{ id: 'short', name: '旧院' }, ...input.assets]
  const { mentions, unknown } = resolveScriptVideoMentions(
    '@旧院 门-清晨 中景 @旧院-不存在 @ghost',
    assets,
  )
  assert.deepEqual(mentions, [{ id: 'yuan', name: '旧院 门-清晨', start: 0, end: 8 }])
  assert.deepEqual(unknown, ['@旧院-不存在', '@ghost'])
  assertContentWarning({ ...input, cards: [{ ...card, assetIds: [] }] }, 'ASSET_UNBOUND')
  assertContentWarning({ ...input, cards: [{ ...card, assetIds: ['yuan', 'yuan'] }] }, 'ASSET_DUPLICATE')
})

test('corrects an unambiguous model ID locally and preserves the confirmed costume rules', async () => {
  let calls = 0
  const fixed = await generateScriptVideoCards({ ...input, outline: [outline] }, async () => {
    calls++
    return { production, cards: [{ ...card, id: 'others' }] }
  })
  assert.equal(calls, 1)
  assert.equal(fixed.cards[0].id, outline.id)
  const assets = [
    { id: 'a', name: '小禾-便服', kind: 'character' },
    { id: 'b', name: '小禾-礼服', kind: 'character' },
  ]
  const drafted = await generateScriptVideoOutline({ ...input, assets }, async () => ({
    cards: [{ ...outline, assetIds: ['b'] }],
  }))
  assert.deepEqual(drafted.cards[0].assetIds, ['b'])
  assert.equal(drafted.attempts, 1)
  const result = await generateScriptVideoCards(
    { ...input, assets, outline: [{ ...outline, assetIds: ['a'] }] },
    async () => ({
      production,
      cards: [{ ...card, assetIds: ['a'], characters: '小禾-便服站在门内，小白在门外。' }],
    }),
  )
  assert.deepEqual(result.cards[0].assetIds, ['a'])
})
test('single-card revision receives preceding end and only applicable combat/ref chapters, protects source and timing', async () => {
  const inputCard = { ...card, combat: true }
  const changed = {
    ...inputCard,
    shots: [{ ...card.shots[0], camera: '侧方移轨' }, card.shots[1]],
    prompt: card.prompt + ' 侧方移轨。',
  }
  const result = await reviseScriptVideoCard(
    { ...input, card: inputCard, previousCard: card, instruction: '细化拔刀动作和运镜' },
    async (req) => {
      assert.deepEqual(JSON.parse(req.message).previousEnding, card.shots[1])
      assert.match(req.instructions, /现场对白可正常张口.*VO／OV保留为画外音/u)
      const content = await req.readSkill('fight-choreography/references/13-close-ups.md')
      assert.ok(content.length > 100)
      return { card: changed, summary: '将首镜改为侧方移轨。' }
    },
  )
  assert.equal(result.card.shots[0].id, card.shots[0].id)
  assert.equal(result.card.shots[0].camera, '侧方移轨')
  assert.equal(result.card.version, 2)
  assert.ok(result.skillReads.some((f) => f.includes('v8-core-template')))
  assert.ok(result.skillReads.some((f) => f.includes('07-08-weapons')))
  assert.ok(result.skillReads.some((f) => f.includes('13-close-ups')))
  assert.ok(!result.skillReads.some((f) => f.includes('12-11-gravity')))
  await assert.rejects(
    reviseScriptVideoCard({ ...input, card, instruction: '侧拍' }, async () => ({
      card: { ...changed, shots: changed.shots.map((s) => ({ ...s, duration: 1 })) },
      summary: '改到侧面',
    })),
    hasIssue('REVISION_TIMELINE'),
  )
})
test('skill directory honors runtime overrides, falls back per-file and blocks symlink escapes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'script-video-skill-'))
  const old = process.env.WORKSPACE_PATH
  try {
    const root = path.join(dir, 'skills/script-to-video')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'SKILL.md'), '定制工作区入口', 'utf8')
    process.env.WORKSPACE_PATH = dir
    const skill = await loadScriptVideoSkill('outline', {
      scene: '学生在校园告白，手机响了。',
      combatEnabled: false,
    })
    assert.ok(skill.instructions.includes('定制工作区入口'))
    assert.ok(
      skill.reads().some((p) => p.includes('06-校园')) &&
        skill.reads().some((p) => p.includes('07-心声')),
    )
    await assert.rejects(skill.readSkill('fight-choreography/SKILL.md'))
    await mkdir(path.join(root, 'references'), { recursive: true })
    await symlink(path.join(dir, 'external.md'), path.join(root, 'references/validation.md'))
    await writeFile(path.join(dir, 'external.md'), 'external file', 'utf8')
    await assert.rejects(skill.readSkill('references/validation.md'), /路径超出/)
  } finally {
    if (old === undefined) delete process.env.WORKSPACE_PATH
    else process.env.WORKSPACE_PATH = old
    await rm(dir, { recursive: true, force: true })
  }
})
test('upstream failures do not masquerade as successful AI output or leak credentials', async () => {
  let attempts = 0
  await assert.rejects(
    generateScriptVideoOutline(input, async () => {
      attempts++
      throw new Error('Bearer my-secret')
    }),
    (err: unknown) => {
      assert.ok(err instanceof ScriptVideoAIError)
      assert.equal(err.code, 'MODEL_FAILED')
      assert.doesNotMatch(err.message, /my-secret/)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test('2.5 guidance is selected locally by model, stage and actual writing needs', async () => {
  const model = 'doubao-seedance-2-5-flash-261115'
  const docs = async (stage: 'outline' | 'storyboard' | 'revision', scene: string, instruction = '', videoModel = model) =>
    (await loadScriptVideoSkill(stage, { scene, videoModel, instruction })).reads()
      .filter(name => name.includes('references/seedance-2.5/')).map(name => name.split('/').at(-1))
  assert.deepEqual(await docs('outline', '圣旨'), [])
  assert.deepEqual(await docs('storyboard', '他望向院门。'), ['片段与镜头.md'])
  assert.deepEqual(await docs('storyboard', '顾凌天(OS)：“她到了。”'), ['片段与镜头.md', '声音与画内文字.md'])
  assert.deepEqual(await docs('storyboard', '角色把“视频编辑”写在白纸上。'), ['片段与镜头.md', '声音与画内文字.md'])
  assert.deepEqual(await docs('revision', '他走进院子。', '已有视频编辑后宽高比错了'), [
    '片段与镜头.md', '参考图与视频任务.md', '成片问题对照.md',
  ])
  assert.deepEqual(await docs('storyboard', '对白', '', 'wf-minimax-h3'), [])
})

test('single episode request keeps camera text and marks action, costume and OS speaker without changing spoken names', async () => {
  const model = 'doubao-seedance-2-5-260628'
  const assets = [
    ...input.assets,
    { id: 'robe', kind: 'character', name: '顾凌天_龙袍' },
    { id: 'other', kind: 'character', name: '顾凌天_便服' },
    { id: 'bowl', kind: 'prop', name: '毒酒碗' },
    { id: 'lamp', kind: 'prop', name: '玄纹铜灯' },
    { id: 'screen', kind: 'prop', name: '绣花屏风' },
    { id: 'manual', kind: 'prop', name: '手绘地图' },
  ]
  const approved = { ...outline, duration: 8, assetIds: ['robe', 'yuan', 'manual'], manualAssetIds: ['manual'] }
  const camera = '近景／顾凌天面部，从@玄纹铜灯旁平摇。\n停在绣花屏风与手绘地图的方向。'
  const dialogue = '顾凌天_龙袍(OS)【低沉】：当心毒酒碗。'
  let calls = 0
  const result = await generateScriptVideoCards({
    ...input, script: '场景：旧院 门-清晨\n顾凌天_龙袍(OS)：当心毒酒碗。',
    assets, outline: [approved], deliverySpecs: { videoModel: model },
  }, async request => {
    calls++
    assert.match(request.instructions, /片段与镜头\.md/)
    assert.match(request.instructions, /逐镜核对上一镜或上一段末镜留下的状态/)
    assert.match(request.instructions, /下一段从本段尾帧继续.*同一镜头续接上一段尾帧.*同场切镜/)
    assert.match(request.instructions, /道具由哪只手持握/)
    assert.match(request.instructions, /运镜、反打、透过门窗看见别处仅改变机位或视野/)
    assert.match(request.instructions, /原文确有换场时，写清切点或入场动作/)
    assert.match(request.instructions, /资产全名紧接“（唯一空间）”/)
    assert.match(request.instructions, /提交前逐镜对照剧本/)
    assert.match(request.instructions, /只在 camera 中提到的对象不计入素材 ID/u)
    assert.match(request.instructions, /统一写为“@角色素材全名【原有简短表演提示】\(OS\) ：“原句””/u)
    assert.match(request.instructions, /不追加闭口、嘴唇不动、不对口型等解释/u)
    assert.match(request.instructions, /相似人物在场时.*留在原位静立/u)
    assert.match(request.instructions, /不因OS另改机位或动作/u)
    return { production, cards: [{
      ...card, id: approved.id, duration: approved.duration, assetIds: ['robe', 'yuan', 'lamp', 'screen'],
      characters: '顾凌天_龙袍', opening: '顾凌天站在院中。',
      scene: '旧院 门-清晨', independentGeneration: '顾凌天看着毒酒碗。',
      ending: '顾凌天垂手。', shots: [{
        duration: 8, camera, action: '顾凌天抬手托住毒酒碗。', dialogue,
        visualAssetIds: ['robe', 'bowl', 'lamp', 'screen'],
      }],
    }] }
  })
  const [draft] = result.cards
  assert.equal(calls, 1)
  assert.deepEqual(new Set(draft.assetIds), new Set(['robe', 'yuan', 'bowl', 'manual']))
  assert.deepEqual(draft.manualAssetIds, ['manual'])
  assert.equal(draft.shots[0].camera, camera.replace('@', ''))
  assert.deepEqual(new Set(draft.shots[0].visualAssetIds), new Set(['robe', 'bowl', 'yuan']))
  assert.ok(draft.prompt.includes('景别／机位／运动：' + camera.replace('@', '')))
  assert.match(draft.prompt, /@顾凌天_龙袍抬手托住@毒酒碗。/u)
  assert.match(draft.prompt, /@顾凌天_龙袍【低沉】\(OS\) ：当心毒酒碗。/u)
  assert.equal(draft.shots[0].dialogue, dialogue)
})

test('outline confirmation streams draft and repair calls, preserves tools and limits, and cancels stalled requests', async (t) => {
  const { createServer } = await import('node:http')
  const dir = await mkdtemp(path.join(tmpdir(), 'script-video-provider-'))
  const old = { db: process.env.SQLITE_PATH, mysql: process.env.MYSQL_AUTO_IMPORT }
  process.env.SQLITE_PATH = path.join(dir, 'fixture.sqlite3')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  type ToolParameters = {
    description?: string
    properties?: Record<string, ToolParameters>
    required?: string[]
    items?: ToolParameters
  }
  const messages: Array<{
    model: string
    stream?: boolean
    tools: { function: { name: string; description?: string; parameters?: ToolParameters } }[]
    max_tokens?: number
    max_completion_tokens?: number
    messages: { role: string; content: string }[]
  }> = []
  const fixtureMaxOutput = 96_000
  const queriedModels: string[] = []
  const queuedDrafts: unknown[] = []
  let scenario:
    | 'outline'
    | 'formal'
    | 'truncated'
    | 'legacy'
    | 'timeout'
    | 'stalled'
    | 'providerError' = 'outline'
  let deadlineClosed: (() => void) | undefined
  const extraResource = 'references/sd25-v2.1/07-心声与界面模块.txt'
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      const id = req.url?.match(/^\/v1\/models\/([^/?]+)$/)?.[1]
      if (!id) {
        res.writeHead(404).end()
        return
      }
      queriedModels.push(id)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        id,
        ...(id === 'fixture-text' ? { max_output_tokens: fixtureMaxOutput } : {}),
      }))
      return
    }
    const chunks: Buffer[] = []
    for await (const part of req) chunks.push(part)
    const received = JSON.parse(Buffer.concat(chunks).toString())
    messages.push(received)
    const contentType = received.stream ? 'text/event-stream' : 'application/json'
    const event = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n'
    if (scenario === 'providerError') {
      const failure = {
        error: { message: 'private fixture provider error', type: 'server_error', code: 'internal_error' },
      }
      res.writeHead(200, { 'content-type': contentType }).end(received.stream ? event(failure) : JSON.stringify(failure))
      return
    }
    if (scenario === 'stalled') {
      res.writeHead(200, { 'content-type': contentType }).flushHeaders()
      // Fail rather than hang even if the production adapter forgets its signal.
      const guard = setTimeout(() => {
        res.end('test guard')
      }, 1500)
      res.on('close', () => {
        clearTimeout(guard)
        deadlineClosed?.()
      })
      return
    }
    if (scenario === 'timeout') {
      res.writeHead(524, { 'content-type': 'text/plain' })
      res.end('fixture private HTML')
      return
    }
    const read = messages.length === 1
    const normalDraft = read
      ? { path: extraResource }
      : scenario === 'formal'
        ? { production, cards: [card] }
        : { cards: [outline] }
    const args = queuedDrafts.length ? queuedDrafts.shift() : normalDraft
    const finish =
      scenario === 'truncated' ? 'length' : scenario === 'legacy' ? 'stop' : 'tool_calls'
    const name = read ? 'read_skill' : 'submit_draft'
    const call = {
      id: 'call' + messages.length,
      type: 'function',
      function: {
        name,
        arguments: scenario === 'truncated' ? '{"production":' : JSON.stringify(args),
      },
    }
    const base = { id: 'test', created: 1, model: 'fixture-text' }
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    if (received.stream) {
      res.writeHead(200, { 'content-type': contentType })
      res.write(event({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...call }] } }] }))
      res.end(event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) + 'data: [DONE]\n\n')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ...base,
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: scenario === 'legacy'
          ? { role: 'assistant', content: '收到。' }
          : { role: 'assistant', content: null, tool_calls: [call] },
        finish_reason: finish,
      }],
      usage,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { db, schema } = await import('../src/db/index.js')
    const baseUrl = 'http://127.0.0.1:' + (server.address() as import('node:net').AddressInfo).port
    const date = new Date().toISOString()
    const row = db
      .insert(schema.aiServiceConfigs)
      .values({
        serviceType: 'text',
        name: 'local adapter',
        provider: 'openai',
        model: '["fixture-text","unknown-allowance","claude-haiku-5-5"]',
        isActive: true,
        apiKey: 'fixture',
        baseUrl,
        createdAt: date,
        updatedAt: date,
      })
      .returning()
      .get()
    const result = await generateScriptVideoOutline({
      ...input,
      configId: row.id,
      model: 'fixture-text',
    })
    assert.equal(result.cards[0].title, outline.title)
    assert.equal(messages.length, 2)
    assert.ok(messages.every(message => message.stream === false), 'read_skill and submit_draft explicitly request complete JSON replies')
    assert.equal(messages[0].model, 'fixture-text')
    assert.ok(messages[0].tools.some((tool) => tool.function.name === 'submit_draft'))
    assert.ok(
      messages[1].messages.some(
        (m) => m.role === 'tool' && JSON.stringify(m.content).includes('心声'),
      ),
    )
    assert.ok(result.skillReads.includes(extraResource))
    await assert.rejects(
      generateScriptVideoOutline({ ...input, configId: row.id, model: 'outside-config' }),
      (e) => e instanceof ScriptVideoAIError && e.code === 'TEXT_MODEL_UNAVAILABLE',
    )
    assert.equal(messages.length, 2)
    const defaultBudget = Number(process.env.AI_MAX_TOKENS || 16384)
    assert.equal(messages[0].max_tokens, fixtureMaxOutput)
    assert.equal(
      messages[1].max_tokens,
      fixtureMaxOutput,
      'outline retains the same allowance after reading a chapter',
    )
    const config = { ...input, configId: row.id, model: 'fixture-text' }
    scenario = 'formal'
    const chosenStyle = getScriptVideoStylePreset('cool')!
    const complete = await generateScriptVideoCards({
      ...config,
      stylePreset: chosenStyle,
      outline: [outline],
    })
    assert.equal(complete.cards.length, 1)
    assert.equal(messages.length, 3)
    assert.equal(messages[2].stream, true)
    assert.equal(messages[2].max_tokens, fixtureMaxOutput)
    const formalMessages = messages[2].messages
    assert.equal(
      formalMessages.filter(
        (m) => m.role === 'user' && m.content === scriptVideoPromptStylePrefix(chosenStyle),
      ).length,
      1,
      'the HTTP provider receives a separate, exact style instruction block',
    )
    assert.ok(
      formalMessages.some(
        (m) => m.role === 'system' && String(m.content).includes('不抄录风格前缀'),
      ),
    )
    assert.ok(
      !formalMessages.some(
        (m) => typeof m.content === 'string' && m.content.includes(chosenStyle.prefix),
      ),
    )
    scenario = 'truncated'
    const sixCards = Array.from({ length: 6 }, (_, n) => ({ ...outline, id: 'card-' + n }))
    await assert.rejects(
      generateScriptVideoCards({ ...config, outline: sixCards }),
      (e) => e instanceof ScriptVideoAIError && e.code === 'OUTPUT_TRUNCATED' && e.message.includes('0/6'),
    )
    assert.equal(
      messages.length,
      4,
      'truncated tool arguments must not start another call or repair',
    )
    assert.equal(messages[3].max_tokens, fixtureMaxOutput)
    await assert.rejects(
      generateScriptVideoOutline(config),
      (e) => e instanceof ScriptVideoAIError && e.code === 'OUTPUT_TRUNCATED',
    )
    assert.equal(messages.length, 5, 'an outline reaching its cap stops after one provider call')
    assert.equal(messages[4].max_tokens, fixtureMaxOutput)
    scenario = 'legacy'
    const { agentRegistry } = await import('../src/agents/index.js')
    const { RequestContext } = await import('@mastra/core/request-context')
    const requestContext = new RequestContext()
    requestContext.set('textConfigId', row.id)
    requestContext.set('modelOverride', 'fixture-text')
    await agentRegistry.storyboard_breaker.generate('本地测试，无需调用工具。', {
      requestContext,
      maxSteps: 1,
      modelSettings: { maxOutputTokens: 32768 },
    })
    assert.equal(messages.length, 6)
    assert.ok(!messages[5].stream, 'other agents keep their existing nonstreaming transport')
    assert.equal(
      messages[5].max_tokens,
      defaultBudget,
      'existing agents retain their configured transport override',
    )
    scenario = 'timeout'
    await assert.rejects(
      generateScriptVideoCards({ ...config, outline: [outline] }),
      (e) =>
        e instanceof ScriptVideoAIError &&
        e.code === 'MODEL_TIMEOUT' &&
        e.message.includes('整集') &&
        !e.message.includes('private'),
    )
    assert.equal(messages.length, 7, 'one 524 must not start a second paid attempt')
    scenario = 'stalled'
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    const scheduled: number[] = []
    const stub = t.mock.method(AbortSignal, 'timeout', (ms: number) => {
      scheduled.push(ms)
      return nativeTimeout(ms === 600_000 ? 120 : ms)
    })
    try {
      const closed = new Promise<void>((resolve) => {
        deadlineClosed = resolve
      })
      await assert.rejects(
        generateScriptVideoCards({ ...config, outline: [outline] }),
        (error) =>
          error instanceof ScriptVideoAIError &&
          error.code === 'MODEL_TIMEOUT' &&
          error.message.includes('整集'),
      )
      await closed
      assert.equal(
        messages.length,
        8,
        'a deadline-induced tripwire must never be repaired as an empty candidate',
      )
      assert.equal(scheduled.filter((ms) => ms === 600_000).length, 1)
      assert.equal(messages[7].stream, true, 'the deadline cancels the stalled storyboard stream')
      const outlineClosed = new Promise<void>((resolve) => {
        deadlineClosed = resolve
      })
      await assert.rejects(generateScriptVideoOutline(config), { code: 'MODEL_TIMEOUT' })
      await outlineClosed
      assert.equal(scheduled.filter((ms) => ms === 600_000).length, 2)
      assert.equal(messages.length, 9, 'the outline deadline cancels the candidate without starting another')
      assert.equal(messages[8].stream, false)
    } finally {
      stub.mock.restore()
    }
    scenario = 'providerError'
    await assert.rejects(
      generateScriptVideoOutline(config),
      (e) =>
        e instanceof ScriptVideoAIError &&
        e.code === 'MODEL_FAILED' &&
        !e.message.includes('private'),
    )
    assert.equal(
      messages.length,
      10,
      'an error inside HTTP 200 JSON must not be retried as an incomplete draft',
    )
    await assert.rejects(generateScriptVideoCards({ ...config, outline: [outline] }),
      (e) => e instanceof ScriptVideoAIError && e.code === 'MODEL_FAILED' && !e.message.includes('private'))
    assert.equal(messages.length, 11, 'a provider error in the stream must not replay the draft')
    scenario = 'formal'
    const start = messages.length
    queuedDrafts.push(
      { production, cards: [{ ...card, shots: [{ ...card.shots[0], duration: 2.1 }, card.shots[1]] }] },
      { patches: [{ id: card.id, shots: [{ index: 1, duration: card.shots[0].duration }] }] },
    )
    const repaired = await generateScriptVideoCards({ ...config, outline: [outline] })
    assert.equal(repaired.attempts, 2)
    assert.deepEqual(messages.slice(start).map(m => m.stream), [true, true])
    assert.deepEqual(messages.slice(start).map(m => m.max_tokens), [fixtureMaxOutput, fixtureMaxOutput])
    const repairTool = messages[start + 1].tools.find(tool => tool.function.name === 'submit_draft')?.function
    assert.ok(repairTool?.parameters?.properties?.patches)
    assert.equal(repairTool.parameters.properties.production, undefined)
    assert.equal(queriedModels.filter(id => id === 'fixture-text').length, 1)

    await generateScriptVideoCards({ ...config, model: 'claude-haiku-5-5', outline: [outline] })
    assert.equal(messages.at(-1)?.max_tokens, 128_000)
    const unknown = { ...config, model: 'unknown-allowance' }
    const beforeUnknown = messages.length
    await generateScriptVideoCards({ ...unknown, outline: [outline] })
    scenario = 'outline'
    await generateScriptVideoOutline(unknown)
    assert.equal(messages.length, beforeUnknown + 2)
    for (const sent of messages.slice(beforeUnknown)) {
      assert.equal(sent.model, unknown.model)
      assert.ok(!('max_tokens' in sent) && !('max_completion_tokens' in sent))
    }
    const beforeRevision = messages.length
    const revisionCamera = '侧方移轨'
    queuedDrafts.push({ card: { ...card, shots: [{ ...card.shots[0], camera: revisionCamera }, card.shots[1]] }, summary: '调整首镜机位。' })
    const revision = await reviseScriptVideoCard({ ...config, card, instruction: '第一镜改为侧方移轨。' })
    assert.equal(revision.card.shots[0].camera, revisionCamera)
    assert.equal(messages.length, beforeRevision + 1)
    queuedDrafts.push({ passed: true, issues: [], continuityReview: '镜头沿河岸的同一侧衔接。' })
    const review = await reviewScriptVideoEpisode({ ...config, cards: complete.cards, production: complete.production })
    assert.equal(review.passed, true)
    assert.equal(messages.length, beforeRevision + 2)
    assert.deepEqual(messages.slice(beforeRevision).map(m => m.stream), [false, false])

    const beforeCultivation = messages.length
    queuedDrafts.push({ production, cards: [{
      ...card,
      shots: [
        { ...card.shots[0], action: '小禾推门。\n情绪提示：神色谨慎。',
          visualAssetIds: ['yuan'], speakerAssetIds: [],
          dialogue: '小禾【女｜青年感｜清亮女声｜谨慎｜轻声｜正常语速｜对白（1/1）｜普通话】：「我回来了。」\n音效：门轴轻响。' },
        { ...card.shots[1], action: '小白从门外追上。\n情绪提示：眼神急切。',
          visualAssetIds: ['yuan'], speakerAssetIds: [],
          dialogue: '小白【男｜青年感｜清朗男声｜急切｜中等音量｜正常语速｜对白（1/1）｜普通话】：「等等我！」\n音效：脚步停在门外。' },
      ],
    }] })
    const cultivation = await generateScriptVideoCards({ ...config, outline: [outline], storyboardMode: 'cultivation' })
    assert.equal(cultivation.attempts, 1)
    assert.equal(messages.length, beforeCultivation + 1)
    const cultivationRequest = messages[beforeCultivation]
    const cultivationTool = cultivationRequest.tools.find(tool => tool.function.name === 'submit_draft')?.function
    assert.match(cultivationTool?.description ?? '', /production.*cards/u)
    const cultivationParameters = cultivationTool?.parameters
    assert.ok(cultivationParameters?.required?.includes('production'))
    assert.ok(cultivationParameters.required.includes('cards'))
    const cardParameters = cultivationParameters.properties?.cards?.items
    assert.ok(cardParameters?.required?.includes('characters'))
    const shotParameters = cardParameters.properties?.shots?.items
    assert.ok(shotParameters?.required?.includes('visualAssetIds'))
    assert.ok(shotParameters.required.includes('speakerAssetIds'))
    assert.match(shotParameters.properties?.action?.description ?? '', /情绪提示/u)
    assert.match(shotParameters.properties?.dialogue?.description ?? '', /音效/u)
    const cultivationInstructions = cultivationRequest.messages.find(message => message.role === 'system')?.content ?? ''
    assert.match(cultivationInstructions, /正式返回格式：调用 submit_draft 一次/u)
    assert.match(cultivationInstructions, /cards 每项必填/u)
    assert.match(cultivationInstructions, /shots 每项必填/u)
    assert.equal(cultivationRequest.stream, true)

    await t.test('AICost Haiku submits the outline with the named structured tool', async (t) => {
      const aicostConfig = db.insert(schema.aiServiceConfigs).values({
        serviceType: 'text',
        name: 'AICost outline fixture',
        provider: 'openai',
        model: '["claude-haiku-5-5"]',
        isActive: true,
        apiKey: 'fixture',
        baseUrl: 'https://www.aicost.me',
        settings: JSON.stringify({ temperature: 0 }),
        createdAt: date,
        updatedAt: date,
      }).returning().get()
      const requests: Array<(typeof messages)[number] & { tool_choice?: unknown; temperature?: number }> = []
      let proseOnly = false
      t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
        const endpoint = new URL(url)
        assert.equal(endpoint.origin, 'https://www.aicost.me')
        if (endpoint.pathname === '/v1/models/claude-haiku-5-5') {
          return Response.json({ id: 'claude-haiku-5-5', max_output_tokens: 128_000 })
        }
        assert.equal(endpoint.pathname, '/v1/chat/completions')
        assert.equal(init?.method, 'POST')
        requests.push(JSON.parse(String(init?.body)))
        const message = proseOnly
          ? { role: 'assistant', content: '# 第 2 集大纲\n\n## 第一段\n小禾推门，小白追上。\n\n请确认后再生成分镜。' }
          : {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'outline',
                type: 'function',
                function: { name: 'submit_draft', arguments: JSON.stringify({ cards: [{ ...outline, assetIds: ['A1'] }] }) },
              }],
            }
        return Response.json({
          id: 'completion-outline',
          created: 1,
          model: 'claude-haiku-5-5',
          choices: [{ index: 0, message, finish_reason: proseOnly ? 'stop' : 'tool_calls' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        })
      })
      const options = { ...input, configId: aicostConfig.id, model: 'claude-haiku-5-5' }
      const drafted = await generateScriptVideoOutline(options)
      assert.equal(drafted.cards[0].title, outline.title)
      assert.deepEqual(drafted.cards[0].assetIds, ['yuan'])
      assert.equal(drafted.attempts, 1)
      assert.equal(requests.length, 1)
      const stageSkill = await loadScriptVideoSkill('outline', { scene: input.script, sharedOutline: true })
      const rules = await stageSkill.readSkill('分段大纲.md')
      assert.ok(requests[0].messages.some(message =>
        message.role === 'system' && message.content.includes('剧本转视频分段大纲') &&
        message.content.includes(rules),
      ))
      const outlineInput = JSON.parse(requests[0].messages.find(message => message.role === 'user')!.content)
      assert.deepEqual(outlineInput.assets.map((asset: { id: string }) => asset.id), ['A1'])
      assert.deepEqual(outlineInput.sourceSpokenLines.map((line: { line: number }) => line.line), [1, 2])

      proseOnly = true
      await assert.rejects(generateScriptVideoOutline(options), {
        code: 'OUTPUT_FORMAT',
        message: '模型没有返回可读取的结构化结果。',
      })
      assert.equal(requests.length, 4, 'the prose-only reply uses the existing maximum of three attempts')
      for (const request of requests) {
        assert.deepEqual(request.tool_choice, { type: 'function', function: { name: 'submit_draft' } })
        assert.ok(!request.stream)
        assert.ok(!('temperature' in request))
        assert.deepEqual(request.tools.map(tool => tool.function.name), ['submit_draft', 'request_clarification'])
        assert.ok(request.messages.every(message => !message.content.includes('上一候选：\nnull')))
      }
    })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
    if (old.db === undefined) delete process.env.SQLITE_PATH
    else process.env.SQLITE_PATH = old.db
    if (old.mysql === undefined) delete process.env.MYSQL_AUTO_IMPORT
    else process.env.MYSQL_AUTO_IMPORT = old.mysql
    await rm(dir, { recursive: true, force: true })
  }
})

test('screenplay stage directions, long performance notes, group names, OS and scene metadata stay distinct', () => {
  const script = [
    '**场次**：1-01',
    '**天气/环境**：雨',
    '场景04：院内',
    '第2集：归来',
    '△画面：暗处传来一声“咔嚓”。',
    '守卫/群体（列队站在石阶下，背景【院门】）（抬头）：“看那里！”',
    '小禾(OS)：他回来了。',
    '门口响起脚步。 小白：“是我。”',
  ].join('\n')
  assert.deepEqual(sourceDialogue(script), [
    { speaker: '守卫/群体', text: '看那里！' },
    { speaker: '小禾', text: '他回来了。' },
    { speaker: '小白', text: '是我。' },
  ])
  assert.doesNotThrow(
    () =>
      assertScriptVideoCards({
        ...input,
        cards: [{ ...card, prompt: '全段 30 秒\n' + card.prompt }],
      }),
  )
  assert.doesNotThrow(
    () =>
      assertScriptVideoCards({
        ...input,
        cards: [{ ...card, prompt: '镜头 1（0–6秒）' + card.prompt }],
      }),
  )
})

test('a later single-card speaker can repeat an earlier character verbatim', () => {
  const script = '小禾：“好。”\n小白：“好。”'
  const later = {
    ...card,
    prompt: '@旧院 门-清晨，小白：“好。”',
    shots: [{ ...card.shots[1], duration: 4.5, dialogue: '小白：“好。”\n环境声：树叶沙沙作响。' }],
  }
  assert.doesNotThrow(() =>
    assertScriptVideoCards({ ...input, script, cards: [later], scope: 'card' }),
  )
  assertContentWarning({
        ...input,
        script,
        cards: [{ ...later, prompt: later.prompt.replace('小白', '小禾') }],
        scope: 'card',
      }, 'PROMPT_DIALOGUE_SPEAKER')
})

test('formal schema requires the full production document and every per-card field, including the sound column', async () => {
  for (const data of [
    { cards: [card] },
    { production, cards: [{ ...card, opening: '' }] },
    {
      production,
      cards: [{ ...card, shots: [{ ...card.shots[0], dialogue: undefined }, card.shots[1]] }],
    },
  ]) {
    await assert.rejects(
      generateScriptVideoCards({ ...input, outline: [outline] }, async () => data),
      (err) => err instanceof ScriptVideoAIError,
    )
  }
  for (const data of [
    { production: { ...production, characters: [] }, cards: [card] },
    { production, cards: [{ ...card, shots: [{ ...card.shots[0], dialogue: '' }, card.shots[1]] }] },
  ]) {
    const accepted = await generateScriptVideoCards({ ...input, outline: [outline] }, async request => {
      assert.equal(request.mode, 'episode')
      return data
    })
    assert.equal(accepted.attempts, 1)
    assert.equal(accepted.cards.length, 1)
  }
  assert.throws(
    () =>
      assertScriptVideoFormal({ ...input, production, cards: [{ ...card, ending: undefined }] }),
    hasIssue('FORMAL_METADATA_MISSING'),
  )
  assert.throws(
    () =>
      assertScriptVideoFormal({
        ...input,
        production,
        cards: [{ ...card, promptNeedsSync: true }],
      }),
    hasIssue('PROMPT_STALE'),
  )
  const result = await generateScriptVideoCards({ ...input, outline: [outline] }, async () => ({
    production,
    cards: [{ ...card, prompt: '模型另写的概要' }],
  }))
  assert.deepEqual(result.production, production)
  const draft = result.cards[0]
  assert.equal(draft.promptNeedsSync, false)
  for (const key of ['opening', 'scene', 'characters', 'independentGeneration', 'ending'] as const)
    assert.equal(draft[key], card[key])
  assert.match(draft.prompt, /镜头 01（0–2.2秒）/)
  assert.match(draft.prompt, /镜头 02（2.2–4.5秒）/)
  assert.match(draft.prompt, /←承上：没有前场末帧/)
  assert.ok(!draft.prompt.includes('模型另写的概要'))
  assert.ok(draft.prompt.includes('场景：2-01｜@旧院 门-清晨'))
  for (const shot of card.shots)
    for (const field of ['camera', 'action', 'dialogue'] as const)
      assert.ok(draft.prompt.includes(shot[field]))
  assert.doesNotMatch(draft.prompt, /^人物声线：/mu)
  assert.equal(result.production.characters[0].voice, production.characters[0].voice)
})
test('formal inner speech, written emotion, foley before/after speech, and standalone silence survive unchanged', () => {
  const reference = {
    ...card,
    shots: [
      { ...card.shots[0], duration: 1, dialogue: '近处的喘息和包扎时的布料摩擦。' },
      { ...card.shots[0], id: 'inner', duration: 1, dialogue: '小禾内心【稳声，重音在“回”】：“我回来了。”' },
      {
        ...card.shots[1],
        duration: 1,
        dialogue: '脚步由石阶落到青砖。小白【续，稍重读末字】：“等等我！”拳击衣襟一声闷响。',
      },
      { ...card.shots[1], id: 'silence', duration: 1.5, dialogue: '静默。' },
    ],
  }
  reference.prompt = renderScriptVideoPrompt(reference, input.assets, production)
  assert.doesNotThrow(() =>
    assertScriptVideoFormal({
      ...input,
      script: '小禾(OS)：我回来了。\n小白：等等我！',
      production,
      cards: [reference],
    }),
  )
  const selected = {
    ...card,
    assetIds: ['base'],
    scene: '顾凌天_龙袍与顾凌天_未知同框，顾凌天立于门口。',
  }
  const prompt = renderScriptVideoPrompt(selected, [
    { id: 'base', name: '顾凌天' },
    { id: 'robe', name: '顾凌天_龙袍' },
  ])
  assert.match(prompt, /场景：顾凌天_龙袍与顾凌天_未知同框，@顾凌天立于门口。/)
})
test('a later OS excerpt in the segment setup never advances the earlier spoken line or repeats in the generated prompt', async () => {
  const script = '场景：旧院 门-清晨\n小禾：“我回来了。”\n小白(OS)：“得跟上，天快亮了。”'
  const recap = '小禾推门，小白心声“得跟上”，随后赶到门口。'
  const source = {
    ...card,
    independentGeneration: recap,
    shots: [
      { ...card.shots[0], dialogue: '门轴轻响。小禾【低声说道】：“我回来了。”' },
      { ...card.shots[1], dialogue: '小白(OS)：“得跟上，天快亮了。”' },
    ],
  }
  const { cards, attempts } = await generateScriptVideoCards(
    { ...input, script, outline: [outline] },
    async request => {
      assert.equal(request.mode, 'episode')
      return { production, cards: [source] }
    },
  )
  assert.equal(attempts, 1)
  const [draft] = cards
  const setup = draft.prompt.split(/\r?\n/u).find(line => /^(?:独立生成|本段事件)[：:]/u.test(line))
  assert.ok(setup)
  assert.doesNotMatch(setup, /“得跟上”/u)
  assert.match(draft.prompt, /我回来了。[\s\S]+内心 OS.+得跟上，天快亮了。/u)

  const legacy = draft.prompt.replace(setup, '本段事件：' + recap)
  assert.doesNotThrow(() =>
    assertScriptVideoFormal({ ...input, script, production, cards: [{ ...draft, prompt: legacy }] }),
  )
  for (const prompt of [
    draft.prompt.replace(setup, setup + '小白心声“我不会进门。”'),
    draft.prompt.replace(/\n镜头 02/u, '\n小白说：“我不会进门。”\n镜头 02'),
  ]) {
    assertContentWarning({ ...input, script, production, cards: [{ ...draft, prompt }] }, 'PROMPT_DIALOGUE_NEW')
  }
})
test('revision preserves confirmed bridges and production while updating the prompt from the revised shot', async () => {
  const result = await reviseScriptVideoCard(
    { ...input, card, production, instruction: '首镜改为侧后跟拍' },
    async (r) => {
      const data = JSON.parse(r.message)
      assert.deepEqual(data.production, production)
      assert.equal(data.currentCard.independentGeneration, card.independentGeneration)
      return {
        card: {
          ...card,
          opening: '丢弃这条错接',
          shots: [{ ...card.shots[0], camera: '近景／侧后跟拍' }, card.shots[1]],
        },
        summary: '改为侧后跟拍。',
      }
    },
  )
  assert.equal(result.card.opening, card.opening)
  assert.equal(result.card.ending, card.ending)
  assert.ok(result.card.prompt.includes('近景／侧后跟拍'))
  assert.ok(result.card.prompt.includes(card.shots[0].dialogue))
})

test('only the matching costume is tagged in the shot text, without a separate voice header', () => {
  const assets = [
    { id: 'short', name: '小禾_礼服' },
    { id: 'torn', name: '小禾_礼服_撕破' },
    { id: 'normal', name: '小禾_便服' },
  ]
  const roles = [
    { name: '小禾', appearance: '本人', voice: '原音色' },
    { name: '小禾_礼服（小禾）', appearance: '完好衣袖', voice: '原音色' },
    { name: '小禾_礼服_撕破', appearance: '撕破衣袖', voice: '原音色' },
    { name: '小禾_便服', appearance: '蓝色便服', voice: '原音色' },
  ]
  const prompt = renderScriptVideoPrompt(
    { ...card, assetIds: ['torn'], characters: '小禾_礼服_撕破在门内。' },
    assets,
    { ...production, characters: roles },
  )
  assert.match(prompt, /人物：@小禾_礼服_撕破在门内/)
  assert.doesNotMatch(prompt, /人物声线：|原音色|@小禾_礼服[（(]/u)
  assert.ok(!prompt.includes('完好衣袖') && !prompt.includes('蓝色便服'))
})

test('leading stage directions and voice suffixes normalize on both sides, preserving literal names and quoted brackets', async () => {
  const script = '张浩内心：【惊惧】[压低声]（屏住呼吸）不可能！\n张浩(OV)：[低声]“【警报】响了。”'
  assert.deepEqual(sourceDialogue(script), [
    { speaker: '张浩', text: '不可能！' },
    { speaker: '张浩', text: '【警报】响了。' },
  ])
  assert.deepEqual(
    sourceDialogue(script, true).map((v) => v.voiceMode),
    ['心声', '画外音'],
  )
  const amended = {
    ...card,
    shots: [
      { ...card.shots[0], dialogue: '张浩内心【惊惧】：“不可能！”' },
      { ...card.shots[1], dialogue: '张浩画外：【低声】“【警报】响了。”' },
    ],
  }
  amended.prompt = renderScriptVideoPrompt(amended, input.assets)
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input, script, cards: [amended] }))
  const named = '人物：张浩内心、张浩\n张浩内心：【平静】“这是我的名字。”'
  assert.deepEqual(sourceDialogue(named, true), [{ speaker: '张浩内心', text: '这是我的名字。' }])
  const literal = {
    ...card,
    shots: [{ ...card.shots[0], duration: 4.5, dialogue: '张浩内心【平静】：“这是我的名字。”' }],
  }
  literal.prompt = renderScriptVideoPrompt(literal, input.assets)
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input, script: named, cards: [literal] }))
  assertContentWarning({
        ...input,
        script: named,
        cards: [
          {
            ...literal,
            shots: [{ ...literal.shots[0], dialogue: '张浩【平静】：“这是我的名字。”' }],
          },
        ],
      }, 'DIALOGUE_SPEAKER')
})

test('scene-specific sound and later events stay in their own cards without episode voice metadata', () => {
  const episode = {
    ...production,
    sceneAndCamera: '第四段倒地后改从右侧观察。',
    shotRhythm: '前段固定，枪响时切近景。',
    soundAndEditing: '枪声后酒碗碎裂，耳光收尾。',
    costumeRules: '侍卫中枪后衣襟染红。',
    interfacePrompt: '第四段出现黑色手枪。',
    interfaceRules: '匣内文字列枪支。',
    characters: [
      {
        name: '小禾',
        appearance: '第四段起持枪，侍卫中枪倒地。',
        voice: '低沉磁性女声，22岁，语速偏慢；见枪后声音发抖。',
      },
      { name: '小白', appearance: '侍卫中枪。', voice: '温润男声，见枪后发紧。' },
      { name: '侍卫', appearance: '第一段持碗，第四段中枪。', voice: '男中音。' },
    ],
  }
  const first = { ...card, characters: '小禾、小白；侍卫在墙边静立。', scene: '旧院，未见界面。' }
  const early = renderScriptVideoPrompt(first, input.assets, episode)
  assert.doesNotMatch(early, /低沉磁性女声|温润男声/)
  assert.doesNotMatch(early, /持枪|中枪|枪声|枪响|见枪|手枪|碗碎|耳光|人物声线：侍卫/)
  assert.ok(early.includes(card.shots[0].dialogue))
  const late = {
    ...first,
    independentGeneration: '小禾持枪对准门口。',
    shots: [
      {
        ...card.shots[0],
        duration: 4.5,
        action: '侍卫中枪倒地，酒碗在青砖上碎裂。',
        dialogue: '近处一声枪响，随后是瓷片碰撞声。',
      },
    ],
  }
  const later = renderScriptVideoPrompt(late, input.assets, episode)
  assert.match(later, /小禾持枪对准门口/)
  assert.match(later, /侍卫中枪倒地，酒碗在青砖上碎裂/)
  assert.ok(later.includes(late.shots[0].dialogue))
  assert.doesNotMatch(later, /耳光|人物声线：/)
})

test('two presets exactly partition the supplied original file, preserving all CRLF, repeated notes and trailing blank lines', async () => {
  const source = await readFile(
    new URL('../workspace/skills/script-to-video/references/项目风格前缀原文.txt', import.meta.url),
  )
  const split = source.indexOf(Buffer.from('\r\n暖色调\r\n')) + 2
  const cool = getScriptVideoStylePreset('cool')!,
    warm = getScriptVideoStylePreset('warm')!
  assert.deepEqual(
    SCRIPT_VIDEO_STYLE_PRESETS.map((p) => [p.id, p.name]),
    [
      ['cool', '冷色调'],
      ['warm', '暖色调'],
    ],
  )
  assert.ok(isScriptVideoStylePreset(cool) && isScriptVideoStylePreset(warm))
  assert.deepEqual(Buffer.from(formatScriptVideoStylePreset(cool)), source.subarray(0, split))
  assert.deepEqual(Buffer.from(formatScriptVideoStylePreset(warm)), source.subarray(split))
  assert.deepEqual(Buffer.from(cool.prefix + warm.prefix), source)
  assert.notEqual(getScriptVideoStylePreset('cool'), cool)
  const custom = { id: 'custom', name: '我的原文', prefix: '  原样\r\n\r\n' }
  assert.ok(isScriptVideoStylePreset(custom))
  assert.equal(formatScriptVideoStylePreset(custom), custom.prefix)
  assert.ok(!isScriptVideoStylePreset({ ...custom, prefix: 3 }))
})

test('all stages use verbatim project style, new productions pin a copy and prior productions retain their original look', async () => {
  const cool = getScriptVideoStylePreset('cool')!,
    warm = getScriptVideoStylePreset('warm')!
  const effective = scriptVideoPromptStylePrefix(cool)
  await generateScriptVideoOutline({ ...input, stylePreset: cool }, async (req) => {
    assert.deepEqual(JSON.parse(req.message).stylePreset, { id: cool.id, name: cool.name })
    assert.equal(req.stylePrefix, effective)
    return { cards: [outline] }
  })
  const result = await generateScriptVideoCards(
    {
      ...input,
      stylePreset: cool,
      deliverySpecs: { aspectRatio: '9:16', resolution: '720P', videoModel: 'configured-video' },
      outline: [outline],
    },
    async (req) => {
      assert.equal(req.stylePrefix, effective)
      return { production: { ...production, visualSpecs: '模型擅加的另一种设定' }, cards: [card] }
    },
  )
  assert.deepEqual(result.production.stylePreset, cool)
  assert.notEqual(result.production.stylePreset, cool)
  assert.equal(result.production.visualSpecs, '9:16，720P，configured-video，项目预设：冷色调')
  assert.ok(result.cards[0].prompt.startsWith(effective + '\n\n←承上'))
  assert.equal(result.cards[0].prompt.split(effective).length, 2)
  assert.ok(!result.cards[0].prompt.includes('模型擅加的另一种设定'))
  const pinned = await reviseScriptVideoCard(
    {
      ...input,
      stylePreset: warm,
      production: result.production,
      card: result.cards[0],
      instruction: '首镜轻推',
    },
    async (req) => {
      assert.equal(req.stylePrefix, effective)
      assert.ok(!req.message.includes(warm.name))
      assert.ok(JSON.parse(req.message).currentCard.prompt.startsWith('←承上'))
      return { card, summary: '首镜轻推。' }
    },
  )
  assert.ok(pinned.card.prompt.startsWith(effective + '\n\n←承上'))
  const legacy = await reviseScriptVideoCard(
    { ...input, stylePreset: warm, production, card, instruction: '首镜轻推' },
    async (req) => {
      assert.equal(req.stylePrefix, undefined)
      assert.equal(JSON.parse(req.message).stylePreset, undefined)
      return { card, summary: '首镜轻推。' }
    },
  )
  assert.ok(!legacy.card.prompt.includes(warm.prefix))
  assert.ok(legacy.card.prompt.startsWith('←承上：'))
  assert.ok(!legacy.card.prompt.includes(production.visualSpecs))
})

test('formal provider text starts with the exact style then the 04正文, with only actual asset mentions', () => {
  const cool = getScriptVideoStylePreset('cool')!
  const assets = [...input.assets, { id: 'rope', name: '麻绳', kind: 'prop' }]
  const oldCard = { ...card, assetIds: ['yuan', 'rope'] }
  const prompt = renderScriptVideoPrompt(oldCard, assets, { ...production, stylePreset: cool })
  assert.ok(prompt.startsWith(scriptVideoPromptStylePrefix(cool) + '\n\n←承上：' + card.opening))
  assert.doesNotMatch(
    prompt.slice(scriptVideoPromptStylePrefix(cool).length),
    /^(?:参考图|画面规格|人物声线)[：:]/mu,
  )
  assert.match(prompt, /场景：2-01｜@旧院 门-清晨/)
  assert.ok(!prompt.includes('@麻绳'))
  for (const shot of card.shots) assert.ok(prompt.includes(shot.dialogue))
  assert.doesNotThrow(
    () =>
      assertScriptVideoFormal({ ...input, assets, production, cards: [{ ...oldCard, prompt }] }),
  )
})

test('unused outline bindings can stay as candidates without inventing an on-screen prop', async () => {
  const assets = [...input.assets, { id: 'rope', name: '麻绳', kind: 'prop' }]
  const planned = { ...outline, assetIds: ['yuan', 'rope'] }
  const result = await generateScriptVideoCards(
    { ...input, assets, outline: [planned] },
    async () => ({ production, cards: [{ ...card, assetIds: planned.assetIds }] }),
  )
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards[0].assetIds, ['yuan', 'rope'])
  assert.ok(!result.cards[0].prompt.includes('麻绳'))
})

test('legacy reference lists stay editable and revision references are reconciled with unknown IDs reported as warnings', async () => {
  const assets = [...input.assets, { id: 'rope', name: '麻绳', kind: 'prop' }]
  const prompt =
    '参考图：@麻绳、@旧院 门-清晨\n' +
    renderScriptVideoPrompt(card, assets, production).replace(/^镜头 [^\r\n]*\n/gmu, '')
  assert.doesNotThrow(
    () =>
      assertScriptVideoFormal({
        ...input,
        assets,
        production,
        cards: [{ ...card, assetIds: ['yuan', 'rope'], prompt }],
      }),
  )
  const revised = await reviseScriptVideoCard({ ...input,
    card: { ...card, scene: '2-01｜@旧院 门-清晨｜门扇紧闭。' }, instruction: '首镜微推' }, async () => ({
      card: { ...card, assetIds: ['missing-reference'] },
      summary: '微推',
    }))
  assert.equal(revised.attempts, 1)
  assert.ok(revised.card.assetIds.includes('yuan'), 'the explicit scene remains bound after local reconciliation')
  assert.ok(revised.warnings.some(issue => issue.code === 'ASSET_UNKNOWN'))
})

test('only character assets expose a voice-present flag to the text model', async () => {
  const voiceAudio = {
    url: 'https://private.invalid/sample.wav',
    name: '秘密音频.wav',
    mimeType: 'audio/wav',
    duration: 2.3,
  }
  const assets = [
    { ...input.assets[0], voiceAudio },
    { id: 'a', name: '小禾', kind: 'character', voiceAudio },
    { id: 'b', name: '小白', kind: 'character' },
  ]
  await generateScriptVideoOutline({ ...input, assets }, async (req) => {
    assert.deepEqual(JSON.parse(req.message).assets, [
      { id: 'yuan', name: '旧院 门-清晨', kind: 'scene' },
      { id: 'a', name: '小禾', kind: 'character', hasVoiceReference: true },
      { id: 'b', name: '小白', kind: 'character', hasVoiceReference: false },
    ])
    assert.doesNotMatch(req.message, /private\.invalid|秘密音频|audio\/wav|voiceAudio/)
    assert.match(req.instructions, /hasVoiceReference/)
    return { cards: [outline] }
  })
})

test('style replacement removes the legacy generated headers while preserving custom text, line endings and dialogue', () => {
  const cool = getScriptVideoStylePreset('cool')!
  const warm = getScriptVideoStylePreset('warm')!
  const specs =
    '16:9 画幅，720P，视频模型 wf-minimax-h3；视觉造型以本段已绑定的资产参考图为准。\n剧本文本未指定额外画风，不额外设定写实或其他画风。'
  const custom =
    '  导演手记：先给静默。 \r\n画面规格：作者写在序言中的附注。\r\n人物声线：甲，作者备注仍保留\r\n\r\n'
  const body =
    '←承上：@京城别院-院落日光冷清。\r\n对白／音效：年长赐酒侍卫：“参考图：只是台词。人物声线：保留。”\r\n画面规格：用户加在正文的标记\r\n  '
  const metadata =
    '参考图：@京城别院-院落、@年长赐酒侍卫、@毒酒碗\r\n画面规格：' +
    specs.replaceAll('\n', '\r\n') +
    '\r\n人物声线：年长赐酒侍卫，粗犷冷硬男声，35岁，音量高\r\n'
  const source = warm.prefix + '\n' + custom + metadata + body
  const prod = {
    ...production,
    stylePreset: warm,
    visualSpecs: specs,
    characters: [
      {
        name: '年长赐酒侍卫',
        appearance: '戴冠',
        voice: '粗犷冷硬男声，35岁，音量高；表演依本镜。',
      },
    ],
  }
  const updated = replaceScriptVideoPromptStyle(source, cool, warm, prod)
  assert.equal(updated, scriptVideoPromptStylePrefix(cool) + '\n\n' + custom + body)
  assert.equal(replaceScriptVideoPromptStyle(updated, cool, cool, prod), updated)
  assert.equal(replaceScriptVideoPromptStyle(updated, undefined, cool), custom + body)
  const authoredReference = '参考图：@麻雀 \r\n' + body
  assert.equal(replaceScriptVideoPromptStyle(authoredReference, cool, warm, prod),
    scriptVideoPromptStylePrefix(cool) + '\n\n' + authoredReference)
  const plain = '作者自写一个整段。\r\n空格和换行也保留。\r\n'
  assert.equal(
    replaceScriptVideoPromptStyle(plain, cool),
    scriptVideoPromptStylePrefix(cool) + '\n\n' + plain,
  )
})

test('both shipped preset labels and source padding stay out of rendered, saved and reselected video prompts', () => {
  const body = renderScriptVideoPrompt(card, input.assets, production)
  const edited = '  导演新写的序言。\r\n\r\n' + body + '\r\n  '
  const [cool, warm] = SCRIPT_VIDEO_STYLE_PRESETS
  for (const [style, other] of [
    [cool, warm],
    [warm, cool],
  ]) {
    const effective = style.prefix.slice(style.name.length).trim()
    const expected = effective + '\n\n' + edited
    const legacy = style.prefix + '\n' + edited
    assert.equal(
      renderScriptVideoPrompt(card, input.assets, { ...production, stylePreset: style }),
      effective + '\n\n' + body,
    )
    assert.equal(replaceScriptVideoPromptStyle(legacy, style, style), expected)
    assert.equal(replaceScriptVideoPromptStyle(expected, style, style), expected)
    assert.equal(replaceScriptVideoPromptStyle(expected, undefined, style), edited)
    assert.equal(
      replaceScriptVideoPromptStyle(other.prefix + '\n' + edited, style, other),
      expected,
    )
    const textareaPrefix = effective.replaceAll('\r\n', '\n')
    assert.equal(
      replaceScriptVideoPromptStyle(textareaPrefix + '\n\n' + edited, style, style),
      expected,
    )
    assert.equal(
      replaceScriptVideoPromptStyle(
        style.prefix.replaceAll('\r\n', '\n') + '\n' + expected,
        style,
        style,
      ),
      expected,
    )
    assert.ok(style.prefix.startsWith(style.name + '\r\n\r\n'))
  }
})

test('custom prefix strips only a matching standalone label and boundary whitespace', () => {
  const style = {
    id: 'custom' as const,
    name: '工作风格',
    prefix: '  \r\n工作风格  \r\n\r\n贴着演员走。\r\n\r\n  保留内部排版。\r\n  ',
  }
  const body = '  首镜备注。\r\n\r\n末尾也留在这里。\r\n  '
  assert.equal(
    replaceScriptVideoPromptStyle('\r\n  \r\n' + body, style),
    '贴着演员走。\r\n\r\n  保留内部排版。\n\n' + body,
  )
  assert.equal(
    replaceScriptVideoPromptStyle(body, { ...style, prefix: '工作风格需逐镜使用。\r\n' }),
    '工作风格需逐镜使用。\n\n' + body,
  )
  assert.equal(replaceScriptVideoPromptStyle(body, { ...style, prefix: '工作风格\n' }), body)
})

test('new outlines receive the 120-second planning goal while short segments and longer totals remain editable', async () => {
  const script = '【本场预计时长】：203秒\n' + input.script
  const candidate = (durations: number[]) => ({
    cards: durations.map((duration, index) => ({
      ...outline,
      title: '段' + (index + 1),
      duration,
    })),
  })
  for (const durations of [
    [30, 30, 30, 30],
    [30, 30, 30, 27.5],
    [24, 22, 26, 24, 24],
  ]) {
    const result = await generateScriptVideoOutline({ ...input, script }, async (request) => {
      const data = taskData(request)
      assert.deepEqual(data.episodeTiming, { targetSeconds: 120, preferredSegmentCount: 4, segmentSeconds: 30 })
      assert.equal(data.confirmedScript, input.script)
      assert.match(request.instructions, /先把主干剧情压进120秒以内/)
      assert.match(request.instructions, /原剧本的预计时长不参与估算/)
      assert.equal(request.attempted, 1)
      return candidate(durations)
    })
    assert.equal(result.attempts, 1)
    assert.deepEqual(
      result.cards.map((row) => row.duration),
      durations,
    )
  }
  const short = await generateScriptVideoOutline({ ...input, script: input.script }, async () =>
    candidate([8.5]),
  )
  assert.deepEqual(
    short.cards.map((row) => row.duration),
    [8.5],
  )
  assert.equal(short.attempts, 1)
  const longer = candidate([30, 30, 30, 30, 18])
  longer.cards[4]!.summary += '\n时长说明：末段须留时间让小白说完独白，并让观众看清她的反应。'
  const overrun = await generateScriptVideoOutline({ ...input, script }, async (request) => {
    assert.match(request.instructions, /最后一段 summary 另起一行写“时长说明：”/)
    return longer
  })
  assert.equal(overrun.cards.at(-1)?.summary, longer.cards[4]!.summary)
  assert.equal(overrun.attempts, 1)
})

test('formal generation keeps both short segments from a previously confirmed outline unchanged', async () => {
  const old = [24, 22].map((duration, index) => ({ ...outline, duration, id: 'existing-' + index }))
  const drafts = old.map((row, index) => ({
    ...card,
    ...row,
    shots: [{ ...card.shots[index], duration: row.duration }],
  }))
  const result = await generateScriptVideoCards({ ...input, outline: old }, async (req) => {
    const data = taskData(req)
    assert.equal(data.episodeTiming, undefined)
    assert.deepEqual(data.targetCardIds, old.map(c => c.id))
    return { production, cards: drafts }
  })
  assert.deepEqual(
    result.cards.map((row) => [row.id, row.duration]),
    [
      ['existing-0', 24],
      ['existing-1', 22],
    ],
  )
  assert.equal(result.attempts, 1)
})

test('outline policy also validates edited tail values before confirmation', () => {
  const issues = (values: number[]) =>
    getScriptVideoOutlineDurationIssues(values.map((duration) => ({ duration }))).map(
      (issue) => issue.code,
    )
  assert.deepEqual(issues([]), ['OUTLINE_REQUIRED'])
  assert.deepEqual(issues([30, 30]), [])
  assert.deepEqual(issues([30, 0.1]), [])
  for (const tail of [-1, 0, 31, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(issues([30, tail]), ['OUTLINE_DURATION_RANGE'])
  }
  assert.deepEqual(issues([29.99, 0]), ['OUTLINE_DURATION_RANGE'])
  assert.deepEqual(issues([24, 22, 26, 24, 24]), [])
})

test('a copied style preamble remains editable without another outline model call', async () => {
  const stylePreset = getScriptVideoStylePreset('cool')!
  const effective = scriptVideoPromptStylePrefix(stylePreset)
  const bad =
    '【项目风格指导（原文逐字保留）】' +
    effective.replaceAll('\r\n', '\n') +
    '\n【本段】' +
    outline.summary
  const result = await generateScriptVideoOutline({ ...input, stylePreset }, async (request) => {
    assert.equal(request.stylePrefix, effective)
    assert.equal(request.attempted, 1)
    assert.match(request.instructions, /逐镜秒数分配留到正式分镜/)
    assert.match(request.instructions, /不为余韵另开尾段/)
    return { cards: [{ ...outline, summary: bad }] }
  })
  assert.equal(result.attempts, 1)
  assert.equal(result.cards[0].summary, bad)
  const short = { id: 'custom' as const, name: '现场', prefix: '无配乐' }
  const ordinary = '事件链：院门打开。无配乐，门轴轻响；小禾开口。'
  const valid = await generateScriptVideoOutline({ ...input, stylePreset: short }, async () => ({
    cards: [{ ...outline, summary: ordinary }],
  }))
  assert.equal(valid.attempts, 1)
})

test('outline distinguishes the two real path-qualified crowd references from the same asset pack', async () => {
  const groups = ['锦衣卫众', '宫廷侍卫'].map((entity, index) => ({
    id: String(index),
    kind: 'character',
    name: '七天_素材/角色/' + entity + '/群体',
    originalName: '群体',
    sourcePath: '七天_素材/角色/' + entity + '/群体.png',
  }))
  const result = await generateScriptVideoOutline(
    {
      ...input,
      assets: groups,
      script: '锦衣卫众/群体随赵峰从院门进入。宫廷侍卫/群体立在门外。',
    },
    async () => ({ cards: [{ ...outline, assetIds: groups.map((a) => a.id) }] }),
  )
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards[0].assetIds, ['0', '1'])
})

test('semantic character identity keeps crowd and costume folders, resolves display suffixes and does not export local paths', async () => {
  const hidden = {
    name: '群体',
    originalName: '群体',
    sourcePath: '/private/七天_素材/角色/北蛮随军军医/群体.png',
  }
  const copy = {
    name: '七天_素材/角色/锦衣卫众/群体-2',
    sourcePath: '七天_素材/角色/锦衣卫众/群体.png',
  }
  const other = { name: '七天_素材/角色/朝堂百官/群体' }
  assert.deepEqual([hidden, copy, other].map(scriptVideoCharacterBase), [
    '北蛮随军军医/群体',
    '锦衣卫众/群体',
    '朝堂百官/群体',
  ])
  assert.equal(scriptVideoCharacterBase({ name: '顾凌天_黑色锦袍_3DQ版' }), '顾凌天')
  assert.equal(scriptVideoCharacterBase({ name: '侍卫-2', originalName: '侍卫-2' }), '侍卫-2')
  assert.equal(scriptVideoCharacterBase({ name: '侍卫-2', originalName: '侍卫' }), '侍卫')
  const folder = { name: '便装', sourcePath: '剧本素材/角色/张三/便装.png' }
  assert.equal(scriptVideoCharacterName(folder), '张三/便装')
  assert.equal(scriptVideoCharacterBase(folder), '张三')
  assert.equal(
    scriptVideoCharacterBase({ name: '素材/角色/李四/便装', originalName: '便装' }),
    '李四',
  )
  const actor = { id: 'a', kind: 'character', ...hidden }
  await generateScriptVideoOutline({ ...input, script: '北蛮随军军医抵达。', assets: [actor] }, async (req) => {
    assert.deepEqual(JSON.parse(req.message).assets, [
      {
        id: 'a',
        name: '群体',
        kind: 'character',
        entityName: '北蛮随军军医/群体',
        hasVoiceReference: false,
      },
    ])
    assert.ok(!req.message.includes('/private/'))
    return { cards: [{ ...outline, assetIds: ['a'] }] }
  })
})

test('the writing model can select imported costumes from an explicit look or the scene context', async () => {
  const assets = [
    '顾凌天',
    '顾凌天_龙袍',
    '顾凌天_龙袍_3DQ版',
    '北城守军/群体',
    '顾凌天_3DQ版',
  ].map((name, i) => ({
    id: String(i),
    kind: 'character',
    name: '七天_素材/角色/' + name,
    sourcePath: '七天_素材/角色/' + name + '.png',
  }))
  const draft = (id: string) => async () => ({ cards: [{ ...outline, assetIds: [id] }] })
  const script = '顾凌天_龙袍_3DQ版（惊惧）：“我是谁？”'
  const result = await generateScriptVideoOutline({ ...input, assets, script }, draft('2'))
  assert.deepEqual(result.cards[0].assetIds, ['2'])
  for (const annotation of ['(OS)', '(OV)', '（惊惧）']) {
    const spoken = await generateScriptVideoOutline(
      { ...input, assets, script: '顾凌天_3DQ版' + annotation + '：“我是谁？”' },
      draft('4'),
    )
    assert.deepEqual(spoken.cards[0].assetIds, ['4'])
  }
  for (const id of ['0', '1']) {
    const contextual = await generateScriptVideoOutline(
      { ...input, assets, script: '顾凌天说：“我是谁？”' },
      draft(id),
    )
    assert.deepEqual(contextual.cards[0].assetIds, [id])
    assert.equal(contextual.attempts, 1)
  }
})

test('text-model input omits timing metadata but preserves original speech, stage action, line endings and a separately requested duration', async () => {
  const spoken = '小禾：“屏幕上的预计时长：120秒，就是我等你的时间。”'
  const action = '显示屏写着“本场预计时长：120秒”；她看了三秒。'
  const timingPref = '本次成片须控制在十二分钟内。'
  const script = [
    '**场次**：1-01',
    '**【本场预计时长】**：120秒',
    spoken,
    '',
    '**场次**：1-02',
    '【本场预计时长】：72秒',
    action,
  ].join('\r\n')
  const opts = { ...input, script, systemPrompt: timingPref }
  const result = await generateScriptVideoOutline(opts, async (req) => {
    const data = JSON.parse(req.message)
    assert.equal(
      data.confirmedScript,
      ['**场次**：1-01', spoken, '', '**场次**：1-02', action].join('\r\n'),
    )
    assert.deepEqual(data.sourceSpokenLines, [
      { speaker: '小禾', text: '屏幕上的预计时长：120秒，就是我等你的时间。' },
    ])
    assert.equal(data.speechPlanning, undefined)
    assert.equal(data.projectPreferences, timingPref)
    assert.equal(data.expectedDuration, undefined)
    return { cards: [outline] }
  })
  assert.equal(opts.script, script)
  assert.equal(result.attempts, 1)
})

test('bare numeric duration metadata never becomes dialogue in formal validation', () => {
  const script = '预计时长：120秒\r\n' + input.script
  assert.deepEqual(sourceDialogue(script, true), sourceDialogue(input.script, true))
  assert.doesNotThrow(() => assertScriptVideoCards({ ...input, script, cards: [card] }))
  assert.deepEqual(sourceDialogue('小禾：预计时长120秒。\n屏幕写着“预计时长：120秒”。', true), [
    { speaker: '小禾', text: '预计时长120秒。' },
  ])
})

const joinedPlan = card.shots.map((shot, i) => ({
  ...outline,
  id: 'bridge-' + i,
  duration: shot.duration,
}))
const joinedCards = joinedPlan.map((plan, i) => ({
  ...card,
  ...plan,
  ending: i === 0 ? '右手扶门，门只推开一半。' : '门扇停住。',
  shots: [card.shots[i]],
}))
const taskData = (r: ScriptVideoModelRequest) => JSON.parse(r.message.split('\n修正上一候选')[0])

test('a six-part episode is written and rendered from its confirmed source in one request', async () => {
  const background = { id: 'unrelated', kind: 'scene', name: '火车站' }
  const plans = Array.from({ length: 6 }, (_, i) => ({
    ...outline,
    id: 'whole-' + i,
    duration: i === 5 ? 2.3 : 30,
  }))
  let calls = 0
  const result = await generateScriptVideoCards(
    { ...input, assets: [...input.assets, background], outline: plans },
    async (req) => {
      calls++
      assert.equal(req.mode, 'episode')
      assert.equal(req.firstSegment, true)
      const data = taskData(req)
      assert.equal(data.confirmedScript, input.script)
      assert.deepEqual(
        data.confirmedOutline.map((c: ScriptVideoCard) => c.id),
        plans.map((c) => c.id),
      )
      assert.deepEqual(
        data.targetCardIds,
        plans.map((c) => c.id),
      )
      assert.deepEqual(
        data.assets.map((a: { id: string }) => a.id),
        ['yuan'],
      )
      assert.match(req.instructions, /摘要与原文冲突时以原文为准/u)
      assert.match(req.instructions, /末镜/u)
      return {
        production,
        cards: plans.map((plan, i) => ({
          ...card,
          ...plan,
          shots: [
            {
              ...card.shots[0],
              duration: plan.duration,
              dialogue:
                i === 0 ? card.shots[0].dialogue : i === 5 ? card.shots[1].dialogue : '脚步渐近。',
            },
          ],
        })),
      }
    },
  )
  assert.equal(calls, 1)
  assert.equal(result.attempts, 1)
  assert.equal(result.cards.length, 6)
  assert.match(result.cards[0].prompt, /我回来了/)
  assert.match(result.cards[5].prompt, /等等我/)
})

test('an interrupted stream saves complete validated cards and resumes only the suffix on user action', async () => {
  let saved: ScriptVideoStoryboardCheckpoint | undefined
  let calls = 0
  await assert.rejects(
    generateScriptVideoCards(
      { ...input, outline: joinedPlan },
      async (req) => {
        calls++
        assert.ok(req.onProduction && req.onCard)
        await req.onProduction(production)
        await req.onCard(joinedCards[0], 0)
        throw Object.assign(new Error('private upstream HTML fixture'), { statusCode: 524 })
      },
      {
        onProgress: (_, snapshot) => {
          saved = structuredClone(snapshot)
        },
      },
    ),
    (e) =>
      e instanceof ScriptVideoAIError && e.code === 'MODEL_TIMEOUT' && !e.message.includes('HTML'),
  )
  assert.equal(calls, 1)
  assert.deepEqual(
    saved!.cards.map((c) => c.id),
    ['bridge-0'],
  )
  const result = await generateScriptVideoCards(
    { ...input, outline: joinedPlan },
    async (req) => {
      calls++
      const data = taskData(req)
      assert.deepEqual(data.targetCardIds, ['bridge-1'])
      assert.equal(data.previousCard.ending, joinedCards[0].ending)
      assert.equal(data.previousCard.lastShot.action, joinedCards[0].shots[0].action)
      assert.deepEqual(data.production.characters, production.characters)
      return { cards: [joinedCards[1]] }
    },
    { checkpoint: saved },
  )
  assert.equal(calls, 2)
  assert.equal(result.cards[0].shots[0].id, saved!.cards[0].shots[0].id)
})

test('one repair patches just the affected shot and keeps the other card intact', async () => {
  const modes: string[] = []
  const result = await generateScriptVideoCards({ ...input, outline: joinedPlan }, async (req) => {
    modes.push(req.mode!)
    if (req.mode === 'episode')
      return {
        production,
        cards: [
          joinedCards[0],
          { ...joinedCards[1], shots: [{ ...card.shots[1], duration: 0.9 }] },
        ],
      }
    const data = taskData(req)
    assert.deepEqual(data.targetCardIds, ['bridge-1'])
    assert.equal(data.confirmedScript, undefined)
    assert.match(req.message, /DUR009/)
    assert.match(req.instructions, /提交前逐镜对照剧本/)
    return { patches: [{ id: 'bridge-1', shots: [{ index: 1, duration: 2.3 }] }] }
  })
  assert.deepEqual(modes, ['episode', 'repair'])
  assert.equal(result.cards[1].shots[0].duration, 2.3)
  assert.equal(result.cards[0].ending, joinedCards[0].ending)
})

test('structurally invalid timing never enters a streamed checkpoint and cancellation makes no new request', async () => {
  const stopped = new Error('stale job')
  let savedCount = 0
  let calls = 0
  await assert.rejects(
    generateScriptVideoCards(
      { ...input, outline: joinedPlan },
      async (req) => {
        calls++
        await req.onProduction!(production)
        await req.onCard!(
          { ...joinedCards[0], shots: [{ ...card.shots[0], duration: joinedCards[0].duration - 0.1 }] },
          0,
        )
        throw Object.assign(Error('timeout'), { statusCode: 524 })
      },
      {
        onProgress: (_, cp) => {
          savedCount = cp.cards.length
        },
      },
    ),
    (e) => e instanceof ScriptVideoAIError && e.code === 'MODEL_TIMEOUT',
  )
  assert.equal(savedCount, 0)
  assert.equal(calls, 1)
  await assert.rejects(
    generateScriptVideoCards(
      { ...input, outline: joinedPlan },
      async (req) => {
        calls++
        await req.onProduction!(production)
        await req.onCard!(joinedCards[0], 0)
        return { production, cards: joinedCards }
      },
      {
        onProgress: (_, cp) => {
          if (cp.cards.length) throw stopped
        },
      },
    ),
  )
  assert.equal(calls, 2)
})

test('all roles can choose an imported costume, with no role whitelist required', async () => {
  const assets = ['王禄', '王禄_3DQ版', '赵峰', '赵峰_3DQ版'].map((name) => ({
    id: name,
    name,
    kind: 'character',
  }))
  const make = (...ids: string[]) => ({ cards: [{ ...outline, assetIds: ids }] })
  const project = {
    ...input,
    assets,
    script: '王禄推开门。赵峰跟在后面。',
    autoSelectCharacterBases: ['王禄'],
  }
  const result = await generateScriptVideoOutline(project, async (req) => {
    assert.match(req.instructions, /所有角色的造型/u)
    return make('王禄', '赵峰')
  })
  assert.deepEqual(result.cards[0].assetIds, ['王禄', '赵峰'])
  assert.equal(result.attempts, 1)
  const unknown = await generateScriptVideoOutline(project, async request => {
    assert.equal(request.attempted, 1)
    return make('赵峰_未导入')
  })
  assert.equal(unknown.attempts, 1)
  assert.ok(unknown.warnings.some(issue => issue.code === 'ASSET_UNKNOWN'))
})

test('episode appearance notes preserve live action and the miniature in one shot', async () => {
  const assets = ['咖妃', '咖妃_3DQ版', '咖妃_素色宫装_撞柱染血'].map((name) => ({
    id: name,
    name,
    kind: 'character',
  }))
  const liveLine = '本宫得先下手。'
  const line = '成了本宫是首功，败了就拉魏忠国下水！'
  const appearanceNotes = '真人用「咖妃」，小剧场用「咖妃_3DQ版」，两张图可以同镜。'
  const episode = {
    ...input,
    episodeNumber: 54,
    assets,
    script: [
      '咖妃(OS)：' + liveLine,
      '△画面：【3DQ版小剧场-单人上身态】3DQ版小咖妃跳到咖妃右肩上。',
      '咖妃_3DQ版(OS)：' + line,
    ].join('\n'),
    characterAppearanceNotes: appearanceNotes,
  }
  const ids = ['咖妃', '咖妃_3DQ版']
  const outlineResult = await generateScriptVideoOutline(episode, async (req) => {
    const message = taskData(req)
    assert.equal(message.characterAppearanceNotes, appearanceNotes)
    assert.ok(ids.every(id => message.assets.some((asset: { id: string }) => asset.id === id)))
    assert.match(req.instructions, /所有角色的造型/u)
    return { cards: [{ ...outline, assetIds: ids, duration: 8 }] }
  })
  assert.equal(outlineResult.attempts, 1)
  const result = await generateScriptVideoCards({ ...episode, outline: outlineResult.cards }, async (req) => {
    assert.equal(taskData(req).characterAppearanceNotes, appearanceNotes)
    return {
      production: {
        ...production,
        characters: [
          { name: '咖妃', appearance: '真人坐在软榻上', voice: '咖妃原音' },
          { name: '咖妃_3DQ版', appearance: '小剧场人物站在真人右肩', voice: '咖妃原音' },
        ],
      },
      cards: [{
        ...card,
        ...outlineResult.cards[0],
        opening: '咖妃坐在软榻上。',
        scene: '54-02｜瑶华宫大殿。',
        characters: '咖妃坐在软榻上，咖妃_3DQ版站在她右肩上。',
        independentGeneration: '拍软榻与肩上的小剧场。',
        ending: '两种造型保持在同一画面。',
        shots: [
          { duration: 3, camera: '近景固定', action: '咖妃坐在软榻上。', dialogue: '咖妃（内心 OS）：“' + liveLine + '”' },
          { duration: 5, camera: '中景固定', action: '3DQ版小咖妃跳到咖妃右肩上。', dialogue: '咖妃_3DQ版（内心 OS）：“' + line + '”' },
        ],
      }],
    }
  })
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.cards[0].assetIds, ids)
  assert.match(result.cards[0].prompt, /@咖妃_3DQ版跳到@咖妃右肩上。/)
  assert.match(result.cards[0].prompt, /@咖妃\(OS\) ：“本宫得先下手。/)
  assert.match(result.cards[0].prompt, /@咖妃_3DQ版\(OS\)/)
})

test('a failed episode uses at most three automatic repairs, including across checkpoint resume', async () => {
  let checkpoint: ScriptVideoStoryboardCheckpoint | undefined
  const phases: string[] = []
  const calls: string[] = []
  const opts = {
    onProgress: (p: { phase: string }, saved: ScriptVideoStoryboardCheckpoint) => {
      phases.push(p.phase)
      checkpoint = structuredClone(saved)
    },
  }
  const runner = async (req: ScriptVideoModelRequest) => {
    calls.push(req.mode!)
    if (req.mode === 'episode')
      return {
        production,
        cards: [joinedCards[0], { ...joinedCards[1], shots: [{ ...card.shots[1], duration: 1 }] }],
      }
    return { patches: [{ id: 'bridge-1', shots: [{ index: 1, duration: 1 }] }] }
  }
  await assert.rejects(
    generateScriptVideoCards({ ...input, outline: joinedPlan }, runner, opts),
    (e) =>
      e instanceof ScriptVideoAIError &&
      e.message.includes('3') &&
      e.issues.some((i) => i.code === 'DUR009'),
  )
  assert.deepEqual(calls, ['episode', 'repair', 'repair', 'repair'])
  assert.equal(checkpoint!.repairAttempts, 3)
  assert.ok(phases.includes('repairing'))
  await assert.rejects(
    generateScriptVideoCards({ ...input, outline: joinedPlan }, runner, { ...opts, checkpoint }),
  )
  assert.equal(calls.length, 4)
})

test('one source line can cross a segment boundary within the same candidate', async () => {
  const source = '小禾：“我回来了，等等我！”'
  const speeches = ['小禾【轻声】：“我回来了。”', '小禾【接上句】：“等等我！”']
  const result = await generateScriptVideoCards(
    { ...input, script: source, outline: joinedPlan },
    async () => ({
      production,
      cards: joinedCards.map((c, i) => ({
        ...c,
        shots: [{ ...c.shots[0], dialogue: speeches[i] }],
      })),
    }),
  )
  assert.equal(result.cards.length, 2)
  assert.equal(result.attempts, 1)
})

test('a complete legacy checkpoint is validated locally without another paid call', async () => {
  const cards = joinedCards.map((c, i) => {
    const saved = { ...c, shots: [{ ...c.shots[0], id: 'retained-' + i }] }
    return { ...saved, prompt: renderScriptVideoPrompt(saved, input.assets, production) }
  })
  const result = await generateScriptVideoCards(
    { ...input, outline: joinedPlan },
    async () => {
      assert.fail('the complete checkpoint needs no additional writing or review')
    },
    { checkpoint: { cards, production, attempts: 11, reviewed: false } },
  )
  assert.deepEqual(
    result.cards.map((c) => c.shots[0].id),
    ['retained-0', 'retained-1'],
  )
})

test('manual semantic review sees edited prompt scene conflicts without repeating the standard prompt', async () => {
  const extra = [
    { id: 'guard', name: '急报传令兵', kind: 'character' },
    { id: 'letter', name: '染血文书', kind: 'prop' },
  ]
  const assets = [...input.assets, ...extra]
  const script = input.script + '\n急报传令兵站在门旁举着染血文书。'
  const generated = await generateScriptVideoCards(
    { ...input, assets, script, outline: joinedPlan },
    async () => ({
      production,
      cards: [
        {
          ...joinedCards[0],
          assetIds: ['yuan', 'guard', 'letter'],
          ending: '急报传令兵仍举着染血文书。',
        },
        joinedCards[1],
      ],
    }),
  )
  const cards = generated.cards.map((card, index) => index === 0
    ? { ...card, prompt: card.prompt.replaceAll('\n', '\r\n') }
    : { ...card, prompt: card.prompt.replace('画面与动作：', '画面与动作：镜头突切宫殿室内。') })
  const before = structuredClone(cards)
  let calls = 0
  const review = await reviewScriptVideoEpisode(
    { ...input, script, assets, cards, production: generated.production },
    async (req) => {
      calls++
      const data = taskData(req)
      assert.equal(req.mode, 'continuity_review')
      assert.deepEqual(
        data.cards[0].renderedAssetReferences.map((a: { id: string }) => a.id).sort(),
        ['guard', 'letter', 'yuan'],
      )
      assert.equal(data.cards[0].editedVideoPrompt, undefined)
      assert.match(data.cards[1].editedVideoPrompt, /镜头突切宫殿室内。/)
      assert.match(req.instructions, /逐镜核对场景、造型与动作状态/)
      assert.equal(data.confirmedScript, script)
      return {
        passed: false,
        issues: [{ cardId: cards[1].id, message: '提示词第二段突然切入宫殿室内，原剧本没有换场。' }],
        continuityReview: '第二段提示词应沿用院门场景。',
      }
    },
  )
  assert.equal(calls, 1)
  assert.equal(review.passed, false)
  assert.equal(review.issues[0].cardId, cards[1].id)
  assert.deepEqual(cards, before)
})
