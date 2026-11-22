import { declaredScriptVideoSceneName } from './script-video-scene-continuity.js'
import { annotateScriptVideoAssets } from './script-video-mentions.js'
import type { ScriptVideoAsset, ScriptVideoCard } from './script-video-types.js'

type BoundaryCard = Pick<ScriptVideoCard, 'scene' | 'opening' | 'ending' | 'prompt' | 'shots' | 'assetIds' | 'manuallyAdded'>
type Shot = { camera?: string; action?: string }
type SceneIdentity = Pick<ScriptVideoAsset, 'id' | 'name'>

const sceneLabel = /^(?:(?:切换(?:至|到)?|转入|转至|切至|切入)\s*)?(?:场景(?:[一二三四五六七八九十\d]+)?|地点)\s*[：:]\s*/u
const sceneSplit = /[；;]\s*(?=(?:(?:切换(?:至|到)?|转入|转至|切至|切入)\s*)?(?:场景(?:[一二三四五六七八九十\d]+)?|地点)\s*[：:])/u
const shotHeading = /^\s*镜头\s*\d+(?:\s*[（(][^\r\n]*[）)])?\s*$/gmu
const fieldBoundary = /^(?:景别\s*[／/]\s*机位\s*[／/]\s*运动|画面与动作|对白\s*[／/]\s*音效|对白|台词|→衔接|末镜停在)\s*[：:]/mu

const noTail = /(?:不沿用|不使用|不用|无需|不接用|不接|不承接|不复用|不要复用|禁止复用)(?:(?:上一?段|前一段|本段)(?:视频)?的?)?(?:末镜|末帧|尾帧)|仅(?:承接|延续)(?:上一?段的?)?(?:剧情|动作状态|叙事)/u
const newShot = /(?:硬切|跳切|同场切镜|切新镜头|切换镜头|重新起镜|重新构图|重新建立机位|另起(?:一|一个)?镜头|换(?:一个)?机位|切(?:换)?(?:成|到|至|入|向)(?:新的?镜头|另一(?:个)?机位|反打|新景别|全景|大全景|远景|中远景|中景|中近景|近景|(?:大)?特写))|^(?:新的?镜头|新机位)/u
const sameOpeningShot = /同一(?:个)?镜头(?:直接)?(?:续接|延续|承接|接续)上一?段(?:视频)?的?(?:尾帧|末帧|末镜)|(?:沿用|复用|使用|直接接上|续接|保持)上一?段(?:视频)?的?(?:尾帧|末帧|末镜)(?:作为首帧|作首帧|的构图|的机位|继续|起拍)|从上一?段(?:视频)?的?(?:尾帧|末帧)(?:继续|直接起拍|起拍|开场)/u
const sameNextShot = /(?:下一?段|下一个片段)[^。；\n]{0,24}(?:同一(?:个)?镜头(?:直接)?(?:续接|延续|承接|接续)(?:本段)?(?:尾帧|末帧)|从本段(?:的|视频)?(?:尾帧|末帧)(?:继续|直接起拍|起拍|开场)|(?:沿用|复用)本段(?:的)?(?:尾帧|末帧)(?:作为首帧|的构图))/u
const explicitLink = /承上|上一?段(?:的|视频)?(?:末镜|末帧|尾帧|结尾|结束)|前一段(?:末镜|末帧|尾帧|结尾)/u

const cameraAxes = [
  /大全景|中全景|全景|中远景|远景|中近景|中景|近景|大特写|特写/u,
  /(?:俯拍|俯视|鸟瞰)|(?:仰拍|仰视)|平视/u,
  /正面|侧面|背面|背影/u,
  /过肩反打|过肩|反打|主观镜头/u,
]

function nonEmpty(value?: string) { return value?.trim() || undefined }

function readPromptField(prompt: string, field: RegExp): string | undefined {
  return nonEmpty(field.exec(prompt)?.[1])
}

function readShotField(block: string, prefix: RegExp): string | undefined {
  const match = prefix.exec(block)
  if (!match) return undefined
  const value = block.slice(match.index + match[0].length)
  const nextField = value.search(fieldBoundary)
  return nonEmpty(nextField < 0 ? value : value.slice(0, nextField))
}

function effectiveShots(card: BoundaryCard): Shot[] {
  const blocks = card.prompt.split(shotHeading).slice(1)
  if (!blocks.length) return card.shots
  return blocks.map((block, index) => ({
    camera: readShotField(block, /^景别\s*[／/]\s*机位\s*[／/]\s*运动\s*[：:]/mu) ?? card.shots[index]?.camera,
    action: readShotField(block, /^画面与动作\s*[：:]/mu) ?? card.shots[index]?.action,
  }))
}

function locationKey(value: string): string {
  return value.trim().replace(/^@/u, '').normalize('NFKC')
}

function sceneDeclarations(text: string, card: BoundaryCard, sceneAssets: readonly ScriptVideoAsset[]): (SceneIdentity | undefined)[] {
  const contents = text.replace(/^场景\s*[：:]\s*(?=场景(?:[一二三四五六七八九十\d]+)?\s*[：:])/u, '')
  return contents.split(sceneSplit).map(section => {
    const value = section.replace(sceneLabel, '')
    const exact = declaredScriptVideoSceneName(value)
    const head = (exact || value.split(/[｜|]/u).find(part => !/^\s*场(?:号|次)(?:\s*[：:])?\s*[\d-]+\s*$/u.test(part)) || '').trim()
    const name = locationKey(head)
    const candidates = sceneAssets.filter(asset => locationKey(asset.name) === name)
    if (candidates.length === 1) return candidates[0]
    if (!candidates.length) {
      if (!name || name.length > 100 || /^(?:无|未知|待定|同上|承上|未提供|未指定|无场景)$/u.test(name) ||
        /[，,：:；;、→⇒/]|转场|切换|切到|切至/u.test(name)) return undefined
      return { id: `scene-label:${name}`, name }
    }
    const bound = candidates.filter(asset => card.assetIds.includes(asset.id))
    return bound.length === 1 ? bound[0] : undefined
  })
}

function explicitLocations(text: string, sceneAssets: readonly ScriptVideoAsset[]): ScriptVideoAsset[] {
  const { mentions } = annotateScriptVideoAssets(text, sceneAssets, [], { autoBind: true })
  return mentions.flatMap(mention => {
    const before = text.slice(0, mention.start).split(/[\n，、。；！？]/u).at(-1) || ''
    if (mention.usage !== 'visual' || !/(?:切(?:换)?(?:至|到|入)|转场(?:至|到)|镜头转(?:至|入|到))\s*$/u.test(before) ||
      /不切|别切|不能|不得|禁止|尚未|之后|随后|下一/u.test(before) ||
      !/^(?:内|外|中)?(?:$|[\s。，、；！？，,.!?;）)])/u.test(text.slice(mention.end))) return []
    const asset = sceneAssets.find(item => item.id === mention.id)
    return asset && locationKey(mention.name) === locationKey(text.slice(mention.start, mention.end)) ? [asset] : []
  })
}

function shotText(shot?: Shot): string { return [shot?.camera, shot?.action].filter(Boolean).join('\n') }

function hasNewShot(text: string): boolean {
  const statements = text.replace(/(?:不|避免|禁止)(?:要)?(?:硬切|跳切|同场切镜|切新镜头|切换镜头|重新构图|换机位)/gu, '')
  return newShot.test(statements) || /^(?:(?:开场|首镜|镜头|画面|直接)\s*[：:]?\s*){0,2}(?:切(?:换)?(?:到|至|入|向)|转场(?:到|至))/mu.test(statements)
}

function compatibleCamera(previous: string, next: string): boolean {
  return !(/反打/u.test(next) && !/反打/u.test(previous)) && cameraAxes.every(axis => {
    const a = axis.exec(previous)?.[0], b = axis.exec(next)?.[0]
    return !a || !b || a === b
  })
}

function visualState(value: string): string {
  return value.normalize('NFKC').replace(/(?:@图片\d+|@)/gu, '').replace(/[\p{P}\s]/gu, '')
}

function actualEnding(value: string): string {
  const withoutLabel = value.replace(/^(?:→?衔接(?:至)?\s*)?(?:视频编号|第)\s*\d+(?:\s*段)?\s*[：:]\s*/u, '')
  return withoutLabel.split(/[。\n；;]/u).filter(clause => !/(?:下一段|下一镜|下段|下一个片段|才会|将会|随后(?:切|转))/u.test(clause)).join('。')
}

function sharesState(a: string, b: string): boolean {
  const right = visualState(b)
  return a.split(/[，。\n；;]/u).some(clause => {
    const left = visualState(clause)
    return left.length >= 8 && (right.includes(left) || left.length >= 14 && right.includes(left.slice(-12)))
  })
}

function handoffText(value: string) {
  return value.replace(/上一集|前一集|上集/gu, '上一段')
    .replace(/下一集|下集/gu, '下一段').replace(/本集/gu, '本段')
}

/** A scene match only supplies a tail when the opening continues the same shot. */
export function getScriptVideoContinuationScene(
  previous: BoundaryCard, next: BoundaryCard, assets: readonly ScriptVideoAsset[],
): SceneIdentity | undefined {
  if (next.manuallyAdded) return
  const before = effectiveShots(previous), after = effectiveShots(next)
  const last = before.at(-1), first = after[0]
  if (!last?.camera || !last.action || !first?.camera || !first.action) return
  const opening = handoffText(readPromptField(next.prompt, /^\s*(?:←承上|开场画面)\s*[：:]\s*([^\r\n]+)/mu) ?? next.opening ?? '')
  const ending = handoffText(readPromptField(previous.prompt, /^\s*(?:→衔接|末镜停在)\s*[：:]\s*([^\r\n]+)/mu) ?? previous.ending ?? '')
  if (!opening.trim() || !ending.trim() || noTail.test(opening) || hasNewShot(opening) || hasNewShot(shotText(first)) ||
    /(?:下一段|下段|下一镜)[^。；\n]*(?:切(?:换)?(?:到|至|入)|硬切|另起|新镜头)/u.test(ending) ||
    (/(?:下一段|下段|下一镜)/u.test(ending) && noTail.test(ending)) ||
    !compatibleCamera(last.camera, first.camera)) return

  const exactCamera = visualState(last.camera) === visualState(first.camera)
  const previousEnding = actualEnding(ending)
  const matchingState = sharesState(last.action, opening) ||
    (sharesState(previousEnding, opening) && (sharesState(last.action, previousEnding) || sharesState(previousEnding, last.action)))
  const resumesLastFrame = sameOpeningShot.test(opening)
  const leadsFromLastFrame = sameNextShot.test(ending)
  const continues = resumesLastFrame ? leadsFromLastFrame || matchingState
    : explicitLink.test(opening) && matchingState && (leadsFromLastFrame || exactCamera)
  if (!continues) return

  const sceneAssets = assets.filter(asset => asset.kind === 'scene')
  const declarations = (card: BoundaryCard) => sceneDeclarations(
    readPromptField(card.prompt, /^\s*场景\s*[：:]\s*([^\r\n]+)/mu) ?? card.scene ?? '', card, sceneAssets,
  )
  const previousDeclarations = declarations(previous)
  const priorLocations = previousDeclarations.length === 1
    ? before.flatMap(shot => explicitLocations(shotText(shot), sceneAssets))
    : explicitLocations(shotText(last), sceneAssets)
  const end = priorLocations.at(-1) ?? previousDeclarations.at(-1)
  const start = explicitLocations(first.camera, sceneAssets)[0] ?? declarations(next)[0]
  if (end && end.id === start?.id) return end
}
