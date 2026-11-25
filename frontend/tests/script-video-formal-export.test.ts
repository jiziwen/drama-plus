import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCardPrompt, exportMarkdown, rebindCardAssets, scriptVideoClipFilename, type PreviewProduction } from '../app/utils/scriptVideoPreview'
import { portableDeliveryCard } from '../app/utils/scriptVideoPreviewExport'
import { buildScriptVideoDelivery, type ScriptVideoContinuation } from '../../backend/src/services/script-video-delivery'
import { validatePreviewCards } from '../app/utils/scriptVideoPreviewValidation'
import { createPreviewCards, seedAssets, seedScript } from './fixtures/scriptVideoCards'
import { getScriptVideoStylePreset } from '../../backend/src/services/script-video-style'

const production: PreviewProduction = {
  coreRhythm: '递酒、试探、夺腕、举证。',
  visualSpecs: '16:9，3D中国古代风格。',
  shotRhythm: '按动作与对白自然分配，不空镜补秒。',
  dialogueRules: '原台词逐字保留，允许自然停连处跨镜。',
  interfaceRules: '本集无界面文字。',
  costumeRules: '采用已确认参考图，不另设服装。',
  sceneAndCamera: '北廊、南门，保持同轴人物左右关系。',
  soundAndEditing: '人物原音，雨滴与衣料摩擦，无配乐。',
  continuityReview: '毒酒碗由端持到落地破碎，碎瓷留到末镜。',
  characters: [{ name: '顾凌天', appearance: '北廊檐下，保持已确认资产造型。', voice: '低沉克制，试探时放轻，心声由本人念。' }],
}

test('正式交付保留制作规格、声音锁定、每段完整元信息与五列表', () => {
  const cards = createPreviewCards(seedScript, seedAssets, true)
  cards[1].openingRecap = '上一镜拍到木门合上。'
  cards[0].shots[2].dialogue = '年长赐酒侍卫【压低、缓慢】：“奉命送行。公子，请。”\n音效：雨水滴在石阶上。'
  const restored = JSON.parse(JSON.stringify({ cards, production }))
  const markdown = exportMarkdown(restored.cards, seedAssets, { production: restored.production })
  assert.ok(markdown.includes('| 角色 | 外观与身份锚点 | 声音、语速与情绪 |'))
  assert.ok(markdown.includes('前镜回顾：上一镜拍到木门合上。'))
  for (const text of Object.values(production).filter(value => typeof value === 'string')) assert.ok(markdown.includes(text))
  for (const card of cards) {
    for (const field of ['opening', 'scene', 'characters', 'independentGeneration', 'ending'] as const) assert.ok(markdown.includes(card[field]!))
    for (const shot of card.shots) assert.ok(markdown.includes(shot.dialogue.replace(/\n/g, '<br>')))
  }
  assert.equal((markdown.match(/\| 镜号 \| 时长 \| 景别／机位／运动 \| 画面与动作 \| 对白／音效 \|/g) || []).length, cards.length)
  assert.ok(!markdown.includes('PASS'))
})

test('单段导出沿用整集原编号与累计时间', () => {
  const cards = createPreviewCards(seedScript, seedAssets, true)
  const markdown = exportMarkdown([cards[1]], seedAssets, { production, episodeCards: cards })
  assert.ok(markdown.includes('## 视频编号02｜00:30–01:00｜'))
  assert.ok(!markdown.includes('## 视频编号01｜'))
})

test('修仙分镜导出逐镜配音和声音统计，统计留在制作文稿中', () => {
  const [template] = createPreviewCards(seedScript, seedAssets, true)
  const card = { ...template, duration: 6, assetIds: [], shots: [{ ...template.shots[0], duration: 6,
    camera: '固定中景', action: '顾凌天抬眼。\n情绪提示：神情克制。',
    dialogue: '顾凌天 (OS)【男｜青年感｜低沉男声｜克制｜轻声｜正常语速｜OS（1/1）｜中文普通话】：「我知道了。」\n音效：衣袖轻响。' }] }
  card.prompt = buildCardPrompt(card, [], production)
  const markdown = exportMarkdown([card], [], { production })
  const delivery = buildScriptVideoDelivery(card, [])
  assert.match(markdown, /人物声音统计（不计入视频时长）[\s\S]+\| 顾凌天 \| 低沉男声 \| 克制、轻声、正常语速 \| 0 \| 1 \|/u)
  assert.ok(markdown.includes(delivery.prompt))
  assert.match(delivery.prompt, /【0s-6s】[\s\S]+【配音指令】：顾凌天｜男/u)
  assert.ok(!delivery.prompt.includes('人物声音统计'))
})

test('单段视频下载使用中文集数和原片段编号', () => {
  assert.equal(scriptVideoClipFilename(1, 1), '第一集-01.mp4')
  assert.equal(scriptVideoClipFilename(12, 8), '第十二集-08.mp4')
  assert.equal(scriptVideoClipFilename(105, 13), '第一百零五集-13.mp4')
})

test('分镜交付只给连续片段追加尾帧，保留原配图编号并使用同一提示词', () => {
  const cards = createPreviewCards(seedScript, seedAssets, true)
  const card = cards[1]
  const continuation: ScriptVideoContinuation = {
    previousCardId: cards[0].id, previousTaskId: 24, imageUrl: '/static/videos/actual_tail.jpg', mode: 'reference',
  }
  const options = { model: 'doubao-seedance-2-5-260628', provider: 'volcengine' }
  const baseline = buildScriptVideoDelivery(card, seedAssets, options)
  const exported = portableDeliveryCard(card, seedAssets, { ...options, continuation })
  const markdown = exportMarkdown(cards, seedAssets, { delivery: options, continuations: { [card.id]: continuation } })
  assert.deepEqual(exported.imageBindings, baseline.imageBindings)
  assert.deepEqual(exported.openingFrame, { ...continuation, imageIndex: baseline.images.length + 1, file: `图${baseline.images.length + 1}-上一段视频尾帧.jpg` })
  assert.match(exported.prompt, new RegExp(`以@图片${baseline.images.length + 1}作为本段首帧`))
  assert.ok(markdown.includes(exported.prompt))
  assert.equal(markdown.match(/这是从上一段成片尾镜选取的续接画面/gu)?.length, 1)
})

test('视频提示词从完整分镜逐字渲染，不再另写简略版本', () => {
  const card = createPreviewCards(seedScript, seedAssets, true)[0]
  const prompt = buildCardPrompt(card, seedAssets, production)
  const readable = prompt.replaceAll('@', '')
  assert.ok(readable.includes('←承上：' + card.opening))
  assert.ok(readable.includes('独立生成：' + card.independentGeneration))
  assert.ok(prompt.includes('→衔接：' + card.ending!.replace('院落', '@京城别院-院落')))
  assert.ok(!/^参考图：|^画面规格：|^人物声线：/mu.test(prompt), '不拼接模板之外的额外头部')
  const speakingCard = createPreviewCards(seedScript, seedAssets, true)[1]
  const speakingPrompt = buildCardPrompt(speakingCard, seedAssets, production)
  assert.ok(!speakingPrompt.includes('人物声线：'))
  assert.ok(speakingPrompt.includes(speakingCard.shots[0].dialogue))
  for (const shot of card.shots) {
    assert.ok(prompt.includes(shot.camera))
    assert.ok(prompt.includes(shot.dialogue))
  }
  const replaced = rebindCardAssets({ ...card, prompt }, card.assetIds.filter(id => id !== 'rope'), seedAssets)
  assert.ok(!replaced.prompt.includes('@麻绳'))
  assert.ok(!replaced.prompt.includes(production.soundAndEditing))
  assert.ok(replaced.prompt.includes(card.shots[2].dialogue))
})

test('旧简略稿可进入分镜补充说明，未同步的提示词仍需先同步', () => {
  const card = createPreviewCards(seedScript, seedAssets, true)[0]
  const legacy = validatePreviewCards([{ ...card, opening: undefined }], seedAssets)
  assert.equal(legacy.ok, true)
  assert.ok(legacy.warnings.some(issue => issue.code === 'FORMAL_METADATA_MISSING'))
  const stale = validatePreviewCards([{ ...card, promptNeedsSync: true }], seedAssets)
  assert.equal(stale.ok, false)
  assert.ok(stale.issues.some(issue => issue.code === 'PROMPT_STALE'))
})

test('文档保留冷暖预设原文，视频提示词去掉预设标题和末尾多余空行', () => {
  for (const id of ['cool', 'warm']) {
    const style = getScriptVideoStylePreset(id)!
    const snapshot = JSON.parse(JSON.stringify({ ...production, stylePreset: style }))
    const card = createPreviewCards(seedScript, seedAssets, true)[0]
    card.prompt = buildCardPrompt(card, seedAssets, snapshot)
    const instructions = style.prefix.replace(/^(?:冷色调|暖色调)\r\n\r\n/u, '').trimEnd()
    assert.ok(card.prompt.startsWith(instructions + '\n\n←承上：'))
    assert.ok(!/^(?:冷色调|暖色调)(?:\r?\n|$)/mu.test(card.prompt))
    const markdown = exportMarkdown([card], seedAssets, { production: snapshot })
    assert.ok(markdown.includes(style.prefix))
    assert.ok(markdown.includes(card.prompt))
    assert.equal(snapshot.stylePreset.prefix, style.prefix)
  }
})
