import { scriptVideoInlineVoiceCue, withoutScriptVideoVoiceCues } from './script-video-foley.js'

type Shot = { action?: string; dialogue?: string }

const emotion = /\r?\n情绪提示[：:][ \t]*\S[^\r\n]*$/u
const effect = /^音效[：:][ \t]*(\S[^\r\n]*)$/u
const shotBoundary = /(?=^镜头[ \t]*\d+[（(]\d)/mu
const shotFields = new RegExp([
  String.raw`^镜头[ \t]*\d+[（(](?<start>\d+(?:\.\d+)?)\s*[–—-]\s*(?<end>\d+(?:\.\d+)?)秒[）)]`,
  String.raw`景别[／/]机位[／/]运动[：:](?<camera>[\s\S]+?)`,
  String.raw`画面与动作[：:](?<action>[\s\S]+?)`,
  String.raw`情绪提示[：:](?<mood>[^\r\n]+)`,
  String.raw`对白[／/]音效[：:](?<speech>[\s\S]+?)`,
  String.raw`音效[：:](?<sound>[^\r\n]+)(?=\r?\n|$)`,
].join(String.raw`\r?\n`), 'u')

function readVoice(line: string) {
  const match = /^(.+?)【([^】]+)】(?:[ \t]*(?:\(OS\)|（画外音）))?[ \t]*[：:][ \t]*「(.+)」$/iu.exec(line.trim())
  if (!match) return
  const fields = match[2].split('｜').map(value => value.trim())
  if (fields.length !== 8 || fields.some(value => !value) || !/^(?:对白|画外对白|OS)[（(]\d+\/\d+[）)]$/iu.test(fields[6])) return
  const speaker = withoutScriptVideoVoiceCues(match[1]).replace(/[ \t]*(?:\(OS\)|（画外音）)[ \t]*$/iu, '').trim()
  if (!speaker) return
  const voiceCue = scriptVideoInlineVoiceCue.exec(match[1])?.[0].trim()
  if (voiceCue) fields[2] += '，音色参考' + voiceCue
  return { speaker, fields, speech: match[3], isInnerVoice: /^OS/iu.test(fields[6]) }
}

function voiceLines(text: string) {
  const lines = text.trim().split(/\r?\n/u)
  if (lines.length === 1 && lines[0] === '无台词') return []
  const voices = lines.map(readVoice)
  return voices.every(voice => voice !== undefined) ? voices : undefined
}

export function hasScriptVideoCultivationShots(shots: readonly Shot[]) {
  return shots.some(isCompleteScriptVideoCultivationShot)
}

export function isCompleteScriptVideoCultivationShot(shot: Shot) {
  const sound = (shot.dialogue ?? '').trim().split(/\r?\n/u)
  return emotion.test(shot.action?.trimEnd() ?? '') && effect.test(sound.pop() ?? '') && voiceLines(sound.join('\n')) !== undefined
}

/** Convert the shared storage format after the workbench has resolved the actual reference IDs. */
export function renderScriptVideoCultivationTimeline(body: string) {
  const [header, ...shots] = body.split(shotBoundary)
  if (!shots.length) return
  const rendered = shots.map(shot => {
    const match = shotFields.exec(shot)
    if (!match?.groups) return
    const { start, end, camera, action, mood, speech, sound } = match.groups
    const voices = voiceLines(speech)
    if (!voices) return
    const instructions = voices.length
      ? voices.map(voice => '【配音指令】：' + [voice.speaker, ...voice.fields, `「${voice.speech}」`].join('｜'))
      : ['【配音指令】：无台词']
    return [`【${start}s-${end}s】`, '运镜：' + camera.replace(/\r?\n[ \t]*/gu, ' '), '动作：' + action.replace(/\r?\n[ \t]*/gu, ' '),
      ...instructions, '声效：' + sound, '情绪提示：' + mood].join('\n') + shot.slice(match[0].length)
  })
  if (rendered.some(shot => shot === undefined)) return
  return header.trimEnd() + '\n\n声音设定：内心 OS 沿用本人音色且不动嘴，口头对白与口型同步。无字幕，无水印。\n\n' + rendered.join('')
}

export function scriptVideoCultivationFinalShot(prompt: string) {
  const shots = [...prompt.matchAll(/^【(\d+(?:\.\d+)?)s-(\d+(?:\.\d+)?)s】\r?\n运镜[：:]/gmu)]
  const last = shots.at(-1)
  if (last) return { number: shots.length, start: Number(last[1]), end: Number(last[2]) }
}

export function scriptVideoCultivationVoiceSummary(shots: readonly Shot[]) {
  if (!hasScriptVideoCultivationShots(shots)) return
  const roles = new Map<string, { name: string; voices: Set<string>; delivery: Set<string>; dialogue: number; innerVoice: number }>()
  for (const shot of shots) {
    for (const line of (shot.dialogue ?? '').split(/\r?\n/u)) {
      const voice = readVoice(line)
      if (!voice) continue
      const name = voice.speaker.replace(/^@/u, '')
      const role = roles.get(name) ?? { name, voices: new Set<string>(), delivery: new Set<string>(), dialogue: 0, innerVoice: 0 }
      role.voices.add(voice.fields[2])
      role.delivery.add(voice.fields.slice(3, 6).join('、'))
      if (voice.isInnerVoice) role.innerVoice++
      else role.dialogue++
      roles.set(name, role)
    }
  }
  return [...roles.values()]
}
