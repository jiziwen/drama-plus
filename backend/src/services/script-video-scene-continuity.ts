import { annotateScriptVideoAssets } from './script-video-mentions.js'
import type { ScriptVideoAsset, ScriptVideoCard, ScriptVideoIssue } from './script-video-types.js'

const sourceLocation = /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*{1,2})?(?:场景|地点)(?:\*{1,2})?[ \t]*[：:][ \t]*([^\r\n]+)/gmu
const sourceVisual = /^[ \t]*(?:[△Δ▲][ \t]*)?(?:画面|转场)[：:]/u
const shotHeading = /^镜头\s*(\d+)(?:\s*[（(][^\r\n]+[）)])?$/u
const visualLabel = /^(?:景别\s*[／/]\s*机位\s*[／/]\s*运动|画面与动作)[：:]/u
const otherLabel = /^(?:对白\s*[／/]\s*音效|对白|台词|场景|人物|总时长|独立生成|←承上|→衔接)[：:]/u
const transition = /(?:转场(?:到|至)|(?:切换|转移|过渡)(?:到|至)|(?:切|转)(?:入|到|至)|进入|[走跑迈跨踏闯冲钻飞移]进|[走跑迈跨踏闯冲钻飞移步]入|[内外]景\s*[：:])[ \t]*$/u
const nonTransition = /(?:不得|不要|不能|没有|并未|尚未|仍未|不切|不转|没切|没进|避免|禁止|勿|别切|别进|如果|打算|准备|即将|似乎|试图|差点|视线|目光|焦点|背景|望向|看向)/u
const locationEnd = /^(?:里(?:面)?|内(?:部)?|外(?:面)?|中|处)?(?:$|[\s，、。；！？,.!?;）)】])/u

const locationName = (value: string) => value.trim().replace(/^@/u, '').normalize('NFKC')

/** Only an explicit single-space declaration can lock a segment. */
export function declaredScriptVideoSceneName(scene?: string): string | undefined {
  const head = scene?.match(/^([^\r\n]*?)[（(][ \t]*唯一空间[ \t]*[）)]/u)?.[1]
  const name = head?.split(/[｜|]/u).at(-1)
  return name && locationName(name)
}

function promptVisualFields(prompt: string): Array<{ shot: number; text: string }> {
  const fields: Array<{ shot: number; text: string }> = []
  let shot = 1
  let current: (typeof fields)[number] | undefined
  for (const plain of prompt.split(/\r?\n/u)) {
    const line = plain.trim()
    const heading = shotHeading.exec(line)
    const label = visualLabel.exec(line)
    if (heading) {
      shot = Number(heading[1])
      current = undefined
    } else if (label) {
      current = { shot, text: line.slice(label[0].length) }
      fields.push(current)
    } else if (!line || otherLabel.test(line)) {
      current = undefined
    } else if (current) {
      current.text += '\n' + line
    }
  }
  return fields
}

function sceneTransitions(text: string, scenes: readonly ScriptVideoAsset[]) {
  const { mentions } = annotateScriptVideoAssets(text, scenes, [], { autoBind: true })
  return mentions.filter(mention => {
    const name = locationName(text.slice(mention.start, mention.end))
    if (mention.usage !== 'visual' || name !== locationName(mention.name)) return false
    const before = text.slice(0, mention.start).split(/[\n，,。；;！？!?]/u).at(-1) || ''
    return transition.test(before) && !nonTransition.test(before) && locationEnd.test(text.slice(mention.end))
  })
}

/** Returns only contradictions with an exact source and attachment match.
 * Unmarked prose, ambiguous aliases and references in a character's line or
 * line of sight cannot by themselves establish where the camera is. */
export function getScriptVideoSceneContinuityIssues(
  script: string, cards: readonly ScriptVideoCard[], assets: readonly ScriptVideoAsset[],
): ScriptVideoIssue[] {
  const declared = [...script.matchAll(sourceLocation)].map(match => locationName(match[1]))
  if (!declared.length) return []
  const sourceNames = new Set(declared)
  const sceneAssets = assets.filter(asset => asset.kind === 'scene')
  const locked = cards.flatMap(card => {
    const name = declaredScriptVideoSceneName(card.scene)
    if (!name || !sourceNames.has(name)) return []
    const anchors = sceneAssets.filter(asset => card.assetIds.includes(asset.id) && locationName(asset.name) === name)
    return anchors.length === 1 ? [{ card, anchor: anchors[0] }] : []
  })
  if (!locked.length) return []
  const inScript = new Set(sourceNames)
  for (const line of script.split(/\r?\n/u)) {
    if (!sourceVisual.test(line)) continue
    for (const destination of sceneTransitions(line, sceneAssets)) inScript.add(locationName(destination.name))
  }
  const issues: ScriptVideoIssue[] = []
  for (const { card, anchor } of locked) {
    const fields = card.shots.map((shot, index) => ({ shot: index + 1, text: shot.camera + '\n' + shot.action }))
    const seen = new Set<string>()
    for (const field of [...fields, ...promptVisualFields(card.prompt)]) {
      for (const destination of sceneTransitions(field.text, sceneAssets)) {
        const key = field.shot + '/' + destination.id
        if (destination.id === anchor.id || inScript.has(locationName(destination.name)) || seen.has(key)) continue
        seen.add(key)
        const shot = String(field.shot).padStart(2, '0')
        issues.push({
          code: 'SCENE_CONTINUITY',
          message: `${card.title}的镜头${shot}从「${anchor.name}」切到了「${destination.name}」。本段声明为唯一空间，原剧本未安排这次转场，请让机位和人物留在原场景。`,
        })
      }
    }
  }
  return issues
}
