import { buildScriptVideoDelivery, type ScriptVideoContinuation, type ScriptVideoDeliveryOptions } from '../../../backend/src/services/script-video-delivery'
import { annotateScriptVideoAssets } from '../../../backend/src/services/script-video-mentions'
import { renderScriptVideoPrompt } from '../../../backend/src/services/script-video-format'
import { formatScriptVideoStylePreset, scriptVideoPromptStylePrefix, type ScriptVideoStylePreset } from '../../../backend/src/services/script-video-style'
import type { ScriptVideoVoiceMode } from '../../../backend/src/services/script-video-types'
import type { ScriptVideoVersion } from '../../../backend/src/services/script-video-versions'
export { listScriptVideoVersions, selectScriptVideoPlayback as scriptVideoCardPlayback } from '../../../backend/src/services/script-video-versions'
export type { ScriptVideoVersion } from '../../../backend/src/services/script-video-versions'

export type PreviewAsset = {
  id: string
  name: string
  kind: 'character' | 'scene' | 'prop' | 'creature'
  image: string
  sourcePath?: string
  originalName?: string
  voiceMode?: ScriptVideoVoiceMode
  voiceAudio?: { url: string; name: string; mimeType?: string; duration?: number }
}

export type PreviewShot = {
  id: string
  duration: number
  camera: string
  action: string
  dialogue: string
  visualAssetIds?: string[]
  speakerAssetIds?: string[]
}

export type PreviewPromptVersion = {
  id: string
  prompt: string
  instruction: string
  summary: string
  createdAt: string
  assetIds: string[]
  excludedAssetIds?: string[]
}

export type PreviewProduction = {
  coreRhythm: string
  visualSpecs: string
  shotRhythm: string
  dialogueRules: string
  interfaceRules: string
  costumeRules: string
  sceneAndCamera: string
  soundAndEditing: string
  continuityReview: string
  characters: Array<{ name: string; appearance: string; voice: string }>
  interfacePrompt?: string
  stylePreset?: ScriptVideoStylePreset
}

export type PreviewExportContext = {
  delivery?: ScriptVideoDeliveryOptions
  referenceImages?: Readonly<Record<string, string>>
  continuations?: Readonly<Record<string, ScriptVideoContinuation>>
  lightingRanges?: Readonly<Record<string, NonNullable<ScriptVideoDeliveryOptions['lightingRanges']>>>
  production?: PreviewProduction
  episodeCards?: PreviewCard[]
}

export type PreviewCard = {
  id: string
  title: string
  duration: number
  summary: string
  assetIds: string[]
  shots: PreviewShot[]
  prompt: string
  combat: boolean
  status: 'draft' | 'queued' | 'generating' | 'ready'
  version: number
  promptVersions?: PreviewPromptVersion[]
  videoUrl?: string
  videoVersions?: ScriptVideoVersion[]
  openingRecap?: string
  opening?: string
  openingAssetIds?: string[]
  scene?: string
  characters?: string
  independentGeneration?: string
  ending?: string
  manuallyAdded?: true
  promptNeedsSync?: boolean
  excludedAssetIds?: string[]
}

export function scriptVideoClipFilename(episodeNumber = 1, segmentNumber = 1) {
  const digits = '零一二三四五六七八九'
  const units = ['', '十', '百', '千']
  const chineseEpisode = Number.isInteger(episodeNumber) && episodeNumber > 0 && episodeNumber < 10_000
    ? String(episodeNumber).split('').map((digit, index, all) =>
      digit === '0' ? '零' : digits[Number(digit)] + units[all.length - index - 1],
    ).join('').replace(/零+/gu, '零').replace(/零$/u, '').replace(/^一十/u, '十')
    : String(episodeNumber)
  return `第${chineseEpisode}集-${String(segmentNumber).padStart(2, '0')}.mp4`
}

type EpisodeStoryboard = {
  cards: readonly Pick<PreviewCard, 'shots' | 'prompt' | 'status' | 'videoUrl' | 'manuallyAdded'>[]
  production?: PreviewProduction
}

export function hasScriptVideoStoryboard({ cards, production }: EpisodeStoryboard) {
  return Boolean(cards.length && (production || cards.every(card => card.manuallyAdded || card.shots?.length && card.prompt?.trim())))
}

export type ScriptVideoEpisodeProgress = '制作中-大纲' | '制作中-视频制作' | '已完成'

export function scriptVideoEpisodeProgress(
  episode: EpisodeStoryboard & { confirmed: boolean; outlineConfirmed: boolean },
): ScriptVideoEpisodeProgress | undefined {
  const { cards } = episode
  if (!episode.confirmed || !cards.length) return
  if (!episode.outlineConfirmed || !hasScriptVideoStoryboard(episode)) return '制作中-大纲'
  return cards.every(card => card.status === 'ready' && card.videoUrl?.trim()) ? '已完成' : '制作中-视频制作'
}

export function scriptVideoTimecode(seconds: number) {
  const ticks = Math.round(seconds * 100)
  const minutes = Math.floor(ticks / 6000)
  const wholeSeconds = Math.floor(ticks / 100) % 60
  const fraction = String(ticks % 100).padStart(2, '0').replace(/0+$/, '')
  return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}${fraction ? `.${fraction}` : ''}`
}

const outlineLabels = [
  String.raw`←?承上(?:第\d+段)?`,
  String.raw`→?衔接(?:至第\d+段)?→?`,
  '事件链',
  '场景(?:与人物|待选)?',
  '主体(?:与场景)?',
  '关键(?:原文?)?台词',
  '时长说明',
  '(?:尾段|最终|剧情|结尾)?收束',
  '(?:人物|角色|资产|绑定)?待选(?:[（(]未绑定[）)])?',
].join('|')
const outlineHeading = new RegExp([
  '“[^”]*”', '「[^」]*」', '『[^』]*』', '"[^"]*"',
  String.raw`(?:^|(?<=[\s。！？；!?;”」』]))(?:【(?<tag>已确认人物造型|待确认造型[^】\n]*)】[：:]?|(?<label>${outlineLabels})\s*[：:])`,
].join('|'), 'gu')

export function splitScriptVideoOutlineSummary(summary: string) {
  const sections: Array<{ label: string; text: string }> = []
  let start = 0
  let label = ''
  for (const match of summary.matchAll(outlineHeading)) {
    const heading = match.groups?.tag || match.groups?.label
    if (!heading) continue
    const text = summary.slice(start, match.index).trim()
    if (label || text) sections.push({ label, text })
    label = heading.replace(/^[←→]|[←→]$/gu, '')
    start = match.index + match[0].length
  }
  const text = summary.slice(start).trim()
  if (label || text) sections.push({ label, text })
  return sections
}

function cardAssets(card: PreviewCard, assets: PreviewAsset[]) {
  return card.assetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is PreviewAsset => Boolean(asset?.name))
}

export function buildCardPrompt(
  card: PreviewCard,
  assets: PreviewAsset[],
  production?: PreviewProduction,
): string {
  return renderScriptVideoPrompt(card, assets, production)
}

export function replacePreviewPrompt(card: PreviewCard, prompt: string): PreviewCard {
  if (prompt === card.prompt) return card
  const shots = card.shots.map(shot => {
    const next = { ...shot }
    delete next.visualAssetIds
    delete next.speakerAssetIds
    return next
  })
  const next = { ...card, prompt, shots }
  delete next.openingAssetIds
  if (!/^前镜回顾[：:]/mu.test(prompt)) delete next.openingRecap
  return next
}

export function rebindCardAssets(
  card: PreviewCard,
  assetIds: string[],
  assets: PreviewAsset[],
  production?: PreviewProduction,
): PreviewCard {
  const excluded = new Set(card.excludedAssetIds || [])
  for (const id of card.assetIds) if (!assetIds.includes(id)) excluded.add(id)
  for (const id of assetIds) excluded.delete(id)
  const next = { ...card, assetIds: [...assetIds] }
  if (excluded.size) {
    next.excludedAssetIds = [...excluded]
    const keep = (id: string) => !excluded.has(id)
    if (card.openingAssetIds) next.openingAssetIds = card.openingAssetIds.filter(keep)
    next.shots = card.shots.map(shot => ({
      ...shot,
      ...(shot.visualAssetIds && { visualAssetIds: shot.visualAssetIds.filter(keep) }),
      ...(shot.speakerAssetIds && { speakerAssetIds: shot.speakerAssetIds.filter(keep) }),
    }))
  } else delete next.excludedAssetIds
  const generated = card.prompt === buildCardPrompt(card, assets, production)
  const source = generated ? buildCardPrompt(next, assets, production) : card.prompt
  const body = source.replace(/^(?:图1\s*=\s*@|参考图[：:])[^\r\n]*(?:\r?\n+|$)/u, '')
  const previous = annotateScriptVideoAssets(body, assets, card.assetIds, {
    characters: card.characters, cast: production?.characters,
    protectedPrefix: production?.stylePreset && scriptVideoPromptStylePrefix(production.stylePreset),
  })
  let last = 0, prompt = ''
  for (const hit of previous.mentions) {
    if (!hit.explicit || hit.usage === 'context' || !excluded.has(hit.id)) continue
    prompt += body.slice(last, hit.start) + body.slice(hit.start + 1, hit.end)
    last = hit.end
  }
  next.prompt = prompt + body.slice(last)
  return next
}

export function exportMarkdown(
  cards: PreviewCard[],
  assets: PreviewAsset[],
  context: PreviewExportContext = {},
): string {
  const allCards = context.episodeCards || cards
  const production = context.production
  const cell = (value: string) =>
    value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const segment = (card: PreviewCard) => {
    const index = allCards.findIndex((item) => item.id === card.id)
    const start = allCards.slice(0, Math.max(0, index)).reduce((sum, item) => sum + item.duration, 0)
    return { number: String(index + 1).padStart(2, '0'), range: `${scriptVideoTimecode(start)}–${scriptVideoTimecode(start + card.duration)}` }
  }
  const lines = [
    '# 分镜脚本与视频提示词',
    '',
    `共 ${cards.length} 段 · ${cards.reduce((sum, card) => sum + card.duration, 0)} 秒`,
    '',
    ...(production?.stylePreset ? ['## 项目统一预设', '', formatScriptVideoStylePreset(production.stylePreset), ''] : []),
    '## 制作规格',
    '',
    '| 视频编号 | 成片时间 | 戏剧动作 |',
    '| --- | --- | --- |',
    ...cards.map((card) => `| ${segment(card).number} | ${segment(card).range} | ${cell(card.summary)} |`),
    '',
  ]
  if (production) {
    lines.push(
      `核心节奏：${production.coreRhythm}`, '',
      `画面规格：${production.visualSpecs}`, '',
      `镜头节奏：${production.shotRhythm}`, '',
      `台词规则：${production.dialogueRules}`, '',
      `界面规则：${production.interfaceRules}`, '',
      `服装规则：${production.costumeRules}`, '',
      `场景与机位：${production.sceneAndCamera}`, '',
      `声音与剪辑：${production.soundAndEditing}`, '',
      '## 人物与声音锁定', '',
      '| 角色 | 外观与身份锚点 | 声音、语速与情绪 |',
      '| --- | --- | --- |',
      ...production.characters.map((character) => `| ${cell(character.name)} | ${cell(character.appearance)} | ${cell(character.voice)} |`),
      '',
    )
    if (production.interfacePrompt) lines.push('## 界面提示词', '', production.interfacePrompt, '')
  } else lines.push('制作规格与人物声音锁定尚未生成，请按完整 Skill 重新生成正式分镜。', '')
  cards.forEach((card) => {
    const delivery = context.delivery && buildScriptVideoDelivery(card, assets, {
      ...context.delivery,
      continuation: context.continuations?.[card.id] ?? context.delivery.continuation,
      lightingRanges: context.lightingRanges?.[card.id] ?? context.delivery.lightingRanges,
    })
    const refs = delivery?.images || cardAssets(card, assets)
    const { number, range } = segment(card)
    lines.push(
      `## 视频编号${number}｜${range}｜${card.title}`,
      '',
      ...(card.openingRecap ? [`前镜回顾：${card.openingRecap}`, ''] : []),
      `←承上：${card.opening || '尚未生成，请按完整 Skill 重新生成。'}`,
      '',
      `场景：${card.scene || '尚未生成，请按完整 Skill 重新生成。'}`,
      '',
      `人物：${card.characters || '尚未生成，请按完整 Skill 重新生成。'}`,
      '',
      `总时长：${card.duration}秒`,
      '',
      `独立生成：${card.independentGeneration || '尚未生成，请按完整 Skill 重新生成。'}`,
      '',
    )
    if (refs.length || delivery?.openingFrame?.imageIndex || delivery?.lightingImages.length)
      lines.push(
        '参考图顺序',
        '',
        ...refs.map((asset, i) => `${i + 1}. ${asset.name}`),
        ...(delivery?.openingFrame?.imageIndex ? [`${delivery.openingFrame.imageIndex}. 上一段视频尾帧`] : []),
        ...(delivery?.lightingImages.map((url, i) => `${refs.length + Number(!!delivery.openingFrame?.imageIndex) + i + 1}. ${delivery.lightingRanges.find(range => range.imageUrl === url)?.sceneName || ''}光线参考图`) || []),
        '',
      )
    if (delivery?.openingFrame?.mode === 'first-frame') lines.push('首帧：上一段视频尾帧', '')
    lines.push(
      '| 镜号 | 时长 | 景别／机位／运动 | 画面与动作 | 对白／音效 |',
      '| --- | --- | --- | --- | --- |',
    )
    card.shots.forEach((shot, i) => {
      lines.push(
        `| ${String(i + 1).padStart(2, '0')} | ${shot.duration}秒 | ${cell(shot.camera)} | ${cell(shot.action)} | ${cell(shot.dialogue) || '—'} |`,
      )
    })
    const prompt = delivery?.prompt || card.prompt || buildCardPrompt(card, assets)
    const fence = '`'.repeat(
      Math.max(
        3,
        ...Array.from(prompt.matchAll(/`+/g), (m) => m[0].length + 1),
      ),
    )
    lines.push('', `→衔接：${card.ending || '尚未生成，请按完整 Skill 重新生成。'}`, '', '### 视频提示词', '', fence, prompt, fence, '')
  })
  if (production) lines.push('## 逻辑与节奏复核', '', production.continuityReview, '')
  return lines.join('\n')
}
