import { scriptVideoShotHeadings } from './script-video-asset-scope.js'

type PromptPart = { text: string; shot?: number; start: number }
export type ScriptVideoPromptSound = PromptPart & { voiceMode?: '心声' | '画外音' }
export type ScriptVideoPromptContext = PromptPart & {
  kind: 'action' | 'handoff' | 'summary' | 'metadata' | 'unscoped'
}

const soundHeading = /^[ \t]*(对白[ \t]*[/／][ \t]*音效|对白|台词|声音|画外音|心声)[ \t]*[：:][ \t]*/u
const contextHeading = /^[ \t]*(前镜回顾|←承上(?:视频编号[ \t]*\d+|第[ \t]*\d+[ \t]*段)?|开场画面|→衔接(?:至[^：:\r\n]*)?|末镜停在|独立生成|本段事件|场景[一二三四五六七八九十\d]*|人物|角色设定|总时长|景别(?:[ \t]*[/／][ \t]*机位[ \t]*[/／][ \t]*运动)?|画面与动作|参考图|画面规格|人物声线)[ \t]*[：:]/u
const standaloneSpeaker = /^[ \t]*@?[\p{L}\p{N}·・、_ /-]+(?:[ \t]*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*[ \t]*[：:]/u

/** Field boundaries, rather than speech verbs in prose, establish which text
 * will be spoken. Keep context separately so a quotation there cannot consume
 * or stand in for a shot's actual dialogue. */
export function parseScriptVideoPromptDialogue(prompt: string) {
  const document = prompt.replace(/^[ \t]+(?=镜头[ \t]*\d)/gmu, '')
  const headings = scriptVideoShotHeadings(document)
  const byStart = new Map(headings.map(heading => [heading.start, heading.index + 1]))
  const sounds: ScriptVideoPromptSound[] = []
  const contexts: ScriptVideoPromptContext[] = []
  let shot: number | undefined
  let current: ScriptVideoPromptSound | ScriptVideoPromptContext | undefined
  for (const match of document.matchAll(/[^\r\n]+/gu)) {
    const line = match[0]
    const start = match.index!
    const index = byStart.get(start)
    if (index !== undefined) {
      shot = index
      current = undefined
      continue
    }
    const sound = soundHeading.exec(line)
    if (sound) {
      current = { text: line.slice(sound[0].length), shot, start,
        ...(sound[1] === '心声' ? { voiceMode: '心声' as const }
          : sound[1] === '画外音' ? { voiceMode: '画外音' as const } : {}) }
      sounds.push(current)
      continue
    }
    const context = contextHeading.exec(line)
    if (context) {
      const label = context[1]
      current = { text: line, shot, start,
        kind: /^(?:前镜回顾|←承上|开场画面|→衔接|末镜停在)/u.test(label) ? 'handoff'
          : /^(?:独立生成|本段事件)/u.test(label) ? 'summary'
          : label === '画面与动作' ? 'action' : 'metadata' }
      contexts.push(current)
      continue
    }
    if (current && !('kind' in current && standaloneSpeaker.test(line))) current.text += '\n' + line
    else {
      current = { text: line, shot, start, kind: 'unscoped' }
      contexts.push(current)
    }
  }
  return { numbered: headings.length > 0, shotNumbers: headings.map(heading => heading.index + 1), sounds, contexts }
}
