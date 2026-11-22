import { scriptVideoNextTurnStart, scriptVideoPerformanceDirections, scriptVideoSpeechQuote, unquotedSpeaker } from './script-video-foley.js'

const quotes = new RegExp(scriptVideoSpeechQuote.source + '|‘[^’\\n]*’?', 'gu')
const soundField = /^(?:物理音效|背景音效|音效|环境音|环境声|背景音|动作音|拟音|音乐|配乐|BGM|SFX)\s*[:：]\s*/iu
const opening = /^[ \t〈<《（(【\[]*/u
const leadIn = /^(?:(?:身侧|身边|身旁|一旁|两旁|旁边|门外|门内|身后|对面|远处|近处|画外|镜外|画内|镜内|现场|随后|接着|这时|此时)(?:的)?\s*)*(?:(?:几|数|一|两|[三四五六七八九十\d]+)(?:名|个|位|众)\s*)?/u
const observed = /^(@?[\p{L}\p{N}·・_ /／-]+?)(?:忽然|猛然|亲耳|亲眼)?(?:听见|听到|看见|看到)了?[ \t]*/u
const subject = /@?[\p{L}\p{N}@·・_ /／、-]+?/u
const deliveryManner = /短促|放声|大声|低声|轻声|低低|轻轻|重重|高声|厉声|失声|低沉|急促|凄厉|凄惨|悲痛|悲切|急切|绝望|惊恐|惊慌|撕心裂肺|歇斯底里|断断续续|极其|极度|格外|异常|非常|十分|一阵|轻/u
const accompanyingAction = /压低声音|压着嗓子|仰头|抬头|低头|仰面|捂嘴|张口|开口|跟着|跟随|随即|忽然|突然|猛地|不由得|忍不住|齐声|齐齐|一齐|一起|同时|正在|开始|接连|连连|又|也/u
const manner = new RegExp('(?:(?:' + deliveryManner.source + '|' + accompanyingAction.source + ')(?:地)?[ \\t]*)*', 'u')
const onlyManner = new RegExp('^' + manner.source + '$', 'u')
const laughOrCry = /哈哈(?:大笑|笑)?|呵呵(?:一笑|笑)?|发笑|大笑|哄笑|狂笑|低笑|[笑哭]出(?:了)?声|[笑哭]了?起来|笑了?(?:一|几|两)声|大哭|痛哭|哭喊|啜泣|抽泣|呜咽|哽咽出声/u
const otherVocals = /大喊|喊叫|呼喊|叫喊|高喊|怒吼|吼叫|咆哮|尖叫|惨叫|哀嚎|呼救|叹息|叹了?(?:一声|口气)|咳嗽|咳了?(?:一|两|几)声|清了清嗓子|[哭喊叫吼叹咳]了一声/u
const audibleSound = /(?:发出(?:一阵|一声|几声)|的(?:一阵|一声|几声)?)(?:大笑|哄笑|笑|哭|呜咽|哀嚎|惨叫|尖叫|啜泣|叹息|叹气|咳嗽|抽泣)声/u
const narrated = new RegExp('^(' + subject.source + ')' + manner.source + '(?:' +
  [laughOrCry, otherVocals, audibleSound].map(verb => verb.source).join('|') + ')', 'u')
const notAnUnknownActor = /[的让令使拟如像想听见看闻随由未没无不忍手声]|制止|阻止|学着|模仿|仿佛|试图|以为|几乎|险些|有人|无人|没有|大家|众人|他们|我们|一片|似乎|传来|停住|收住|录音|播放|对白|台词|描述/u
const hypothetical = /^(?:如果|倘若|假如|假设|若是|若|一旦|万一|要是|只要|除非)/u

function plausibleSubject(name: string, names: ReadonlyMap<string, unknown>) {
  if (names.has(name)) return true
  if (!/^[\p{Script=Han}·]{2,6}$/u.test(name) || notAnUnknownActor.test(name) || onlyManner.test(name)) return false
  for (let i = 1; i < name.length; i++) if (names.has(name.slice(0, i))) return false
  return true
}

/** A sound direction can describe a character's voice without quoting words.
 * Only a clause's acting subject is evidence. Do not infer a subject from
 * the nearest name to an action, a quoted example or an unnamed sound. */
export function scriptVideoVocalSubjects(
  line: string, names: ReadonlyMap<string, unknown>, directions = scriptVideoPerformanceDirections(line),
) {
  const subjects: Array<{ start: number; end: number; name: string; nextTurn?: number }> = []
  let masked = line.replace(quotes, quote => '\uFFFC'.repeat(quote.length))
  for (const { start, end } of directions) {
    masked = masked.slice(0, start) + '\uFFFC'.repeat(end - start) + masked.slice(end)
  }
  for (const clause of masked.matchAll(/[^，,。；;！!？?\r\n]+/gu)) {
    let text = clause[0]
    const field = soundField.exec(text.trimStart())
    if (field) text = text.trimStart().slice(field[0].length)
    text = text.slice(opening.exec(text)![0].length)
    text = text.slice(leadIn.exec(text)![0].length)
    if (hypothetical.test(text)) continue
    const listener = observed.exec(text)
    if (listener && (names.has(listener[1].replace(/^@/u, '')) || /^(?:他|她|他们|她们|众人|大家)$/u.test(listener[1]))) {
      text = text.slice(listener[0].length)
    }
    const match = narrated.exec(text)
    if (!match || /^(?:便会|就会|的话|的(?:模样|样子|照片|画面)|(?:却|但)?(?:未|没|没有|不)出声|(?:已经|渐渐|突然)?(?:消失|停住|止住|收住))/u.test(text.slice(match[0].length))) continue
    const label = match[1].trimEnd()
    const start = clause.index! + clause[0].length - text.length
    const members = names.has(label.replace(/^@/u, '')) ? [label] : label.split(/[、和与]/u)
    if (!members.every(member => plausibleSubject(member.trim().replace(/^@/u, ''), names))) continue
    const next = scriptVideoNextTurnStart(line, clause.index! + clause[0].length)
    const rest = line.slice(next)
    const nextLabel = unquotedSpeaker.exec(rest)
    const nextTurn = nextLabel && /^[“「『"{]/u.test(rest.slice(nextLabel[0].length)) ? next : undefined
    let offset = 0
    for (const member of members) {
      const raw = member.trim()
      const name = raw.replace(/^@/u, '')
      const from = start + offset + member.indexOf(raw)
      subjects.push({ name, start: from, end: from + raw.length, nextTurn })
      offset += member.length + 1
    }
  }
  return subjects
}
