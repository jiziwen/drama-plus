import { annotateScriptVideoAssets, type MentionAsset } from './script-video-mentions.js'
import { annotateScriptVideoInnerOs } from './script-video-inner-os.js'
import {
  scriptVideoPromptStylePrefix,
  SCRIPT_VIDEO_STYLE_PRESETS,
  type ScriptVideoStylePreset,
} from './script-video-style.js'
import type { ScriptVideoCard, ScriptVideoProduction, ScriptVideoShot } from './script-video-types.js'

const openingBlankLines = /^(?:[^\S\r\n]*(?:\r\n|[\r\n]))+/u

/** An event summary can quote a line that will be spoken later. Keep the
 * performance in its actual shot, along with its speaker and timing. */
export function omitScriptVideoRecapQuotes(
  prompt: string,
  shots: readonly { dialogue?: string }[],
): string {
  if (!/^(?:独立生成|本段事件)[：:]/mu.test(prompt)) return prompt
  const compact = (text: string) => text.normalize('NFKC').replace(/[\p{P}\s]/gu, '')
  const dialogue = shots.map(shot => compact(shot.dialogue || ''))
  return prompt.replace(/^(?:独立生成|本段事件)[：:][^\r\n]*/gmu, line =>
    line.replace(/(内心[ \t]*OS|内心独白|心声|旁白|对白|台词|[说问喊答道吼叫喝])(?:[：:][ \t]*|[ \t]*)[“「『"]([^”」』"\r\n]+)[”」』"]/giu,
      (original, cue: string, excerpt: string) => {
        const words = compact(excerpt)
        return words && dialogue.some(text => text.includes(words))
          ? cue + '（见对应镜头）'
          : original
      }))
}

function prependStyle(body: string, style?: ScriptVideoStylePreset): string {
  const prefix = style && scriptVideoPromptStylePrefix(style)
  if (!prefix) return body
  const text = body.replace(openingBlankLines, '')
  return text ? prefix + '\n\n' + text : prefix
}

/** Replace only the source prefix and the retired renderer's header. The body
 * may contain manual edits that cannot be reconstructed from structured shots. */
export function replaceScriptVideoPromptStyle(
  prompt: string,
  style?: ScriptVideoStylePreset,
  previousStyle?: ScriptVideoStylePreset,
  production?: ScriptVideoProduction,
): string {
  const candidates = new Set<string>()
  for (const preset of [
    previousStyle,
    production?.stylePreset,
    style,
    ...SCRIPT_VIDEO_STYLE_PRESETS,
  ]) {
    if (!preset) continue
    // Archived cards contain the whole section (sometimes with trimmed edges).
    // A textarea can normalize the line breaks when an author edits that card.
    for (const prefix of [
      preset.prefix,
      preset.prefix.trim(),
      scriptVideoPromptStylePrefix(preset),
    ]) {
      if (!prefix) continue
      const lf = prefix.replace(/\r\n|\r/gu, '\n')
      candidates.add(prefix)
      candidates.add(lf)
      candidates.add(lf.replaceAll('\n', '\r\n'))
    }
  }
  const known = [...candidates].sort((a, b) => b.length - a.length)
  let body = prompt
  for (;;) {
    const prefix = known.find((candidate) => {
      if (!body.startsWith(candidate)) return false
      const next = body[candidate.length]
      return next === undefined || next === '\r' || next === '\n'
    })
    if (!prefix) break
    body = body.slice(prefix.length).replace(openingBlankLines, '')
  }
  const formalStart = body.search(
    /^(?:(?:前镜回顾|←承上|场景|人物|总时长|独立生成)[：:]|镜头\s+\d+\s*[（(])/mu,
  )
  if (formalStart >= 0) {
    const preface = body.slice(0, formalStart)
    const specs = production?.visualSpecs?.split(/\r\n|[\r\n]/u) || []
    const lines = preface.match(/[^\r\n]*(?:\r\n|[\r\n]|$)/gu) || []
    const content = (line: string) => line.replace(/(?:\r\n|[\r\n])$/u, '')
    let preserved = ''
    let inGeneratedHeader = false
    for (let index = 0; index < lines.length; index++) {
      const line = content(lines[index])
      if (/^参考图：@/u.test(line)) {
        inGeneratedHeader = true
        continue
      }
      const voice = /^人物声线：([^，]+)，(.+)$/u.exec(line)
      if (voice) {
        const role = production?.characters?.find((character) => character.name === voice[1])
        const matchesRecording =
          role && voice[2].split('，').every((clause) => role.voice?.includes(clause))
        if (matchesRecording || (!production?.characters?.length && inGeneratedHeader)) continue
      }
      if (line.startsWith('画面规格：')) {
        const knownSpecs =
          line === '画面规格：' + specs[0] &&
          specs.slice(1).every((value, offset) => {
            const next = lines[index + offset + 1]
            return next !== undefined && content(next) === value
          })
        if (knownSpecs) {
          inGeneratedHeader = true
          index += specs.length - 1
          continue
        }
        // A historical header can also be identified by its adjacent reference
        // list when the original production snapshot is no longer available.
        if (index > 0 && /^参考图：@/u.test(lines[index - 1])) continue
      }
      inGeneratedHeader = false
      preserved += lines[index]
    }
    body = preserved + body.slice(formalStart)
  }
  return prependStyle(body, style)
}

export function scriptVideoStoryboardBody(
  card: Pick<ScriptVideoCard, 'openingRecap' | 'opening' | 'scene' | 'characters' | 'duration' | 'independentGeneration' | 'ending'> & {
    shots: readonly Pick<ScriptVideoShot, 'duration' | 'camera' | 'action' | 'dialogue'>[]
  },
): string {
  const out: string[] = []
  if (card.openingRecap) out.push('前镜回顾：' + card.openingRecap)
  if (card.opening) out.push('←承上：' + card.opening)
  if (card.scene) out.push('场景：' + card.scene)
  if (card.characters) out.push('人物：' + card.characters)
  out.push('总时长：' + card.duration + '秒')
  if (card.independentGeneration) out.push('独立生成：' + card.independentGeneration)
  let elapsed = 0
  for (const [i, shot] of card.shots.entries()) {
    const end = Number((elapsed + shot.duration).toPrecision(15))
    out.push(
      '',
      '镜头 ' + String(i + 1).padStart(2, '0') + '（' + elapsed + '–' + end + '秒）',
      '景别／机位／运动：' + shot.camera,
      '画面与动作：' + shot.action,
      '对白／音效：' + shot.dialogue,
    )
    elapsed = end
  }
  if (card.ending) out.push('', '→衔接：' + card.ending)
  return out.join('\n')
}

/** Render the actual storyboard fields into the provider prompt. Do not ask the
 * model to recapitulate its own shots in a separate, potentially shorter draft. */
export function renderScriptVideoCardReferences(
  card: ScriptVideoCard,
  assets: readonly MentionAsset[],
  production?: ScriptVideoProduction,
  stylePreset?: ScriptVideoStylePreset,
  autoBind = false,
) {
  const style = stylePreset ?? production?.stylePreset
  const prompt = annotateScriptVideoInnerOs(omitScriptVideoRecapQuotes(scriptVideoStoryboardBody(card), card.shots), {
    speakers: [...assets.filter(asset => !asset.kind || asset.kind === 'character').map(asset => asset.name),
      ...(production?.characters?.map(role => role.name) ?? [])],
  })
  const annotated = annotateScriptVideoAssets(prompt, assets, card.assetIds, {
    characters: card.characters, cast: production?.characters, excludedIds: card.excludedAssetIds, autoBind,
  })
  return { prompt: prependStyle(annotated.text, style), usedIds: annotated.assetIds, contextAssetIds: annotated.contextAssetIds }
}

export function renderScriptVideoPrompt(
  card: ScriptVideoCard,
  assets: readonly MentionAsset[],
  production?: ScriptVideoProduction,
  stylePreset?: ScriptVideoStylePreset,
): string {
  return renderScriptVideoCardReferences(card, assets, production, stylePreset).prompt
}
