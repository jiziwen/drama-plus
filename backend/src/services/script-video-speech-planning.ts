export type ScriptVideoDialogueBoundary = { line: number; endCue?: string }

export function outlineSpeechIssues(
  lines: ReadonlyArray<{ text: string }>,
  cards: ReadonlyArray<{ dialogueThrough?: ScriptVideoDialogueBoundary }>,
  requireBoundaries = false,
) {
  if (!lines.length || (!requireBoundaries && !cards.some(card => card.dialogueThrough))) return []
  // Resolve the model's short, verbatim anchors against the source. Boundaries
  // can repeat for silent cards, and a line can continue over several cards.
  const source = lines.map(line => line.text).join('\n')
  let end = 0
  const offsets = lines.map(line => {
    const start = end
    end += line.text.length + 1
    return start
  })
  let previous = 0
  for (const [i, card] of cards.entries()) {
    const boundary = card.dialogueThrough
    const label = `第${i + 1}段`
    if (!boundary || !Number.isInteger(boundary.line) || boundary.line < 0 || boundary.line > lines.length || (!boundary.line && boundary.endCue)) {
      return [{ code: 'OUTLINE_SPEECH_BOUNDARY', message: `${label}需要有效的 dialogueThrough，按原文人声清单从1编号，开场尚无人声用0。` }]
    }
    let position = 0
    if (boundary.line) {
      const index = boundary.line - 1
      const line = lines[index].text
      const cue = boundary.endCue?.trim()
      const found = cue ? line.indexOf(cue) : line.length
      if (found < 0 || (cue && line.lastIndexOf(cue) !== found)) {
        return [{ code: 'OUTLINE_SPEECH_BOUNDARY', message: `${label}的人声落点需用第${boundary.line}句内唯一一处原文短语作为 endCue；整句说完可省略 endCue。` }]
      }
      position = offsets[index] + found + (cue?.length ?? 0)
    }
    if (position < previous) return [{ code: 'OUTLINE_SPEECH_ORDER', message: `${label}的人声落点早于上段，请按原剧本顺序分配。` }]
    previous = position
  }
  if (source.slice(previous).match(/[\p{L}\p{N}]/u))
    return [{ code: 'OUTLINE_SPEECH_INCOMPLETE', message: '尾段之后仍有原文人声。把剩余对白、心声和画外音顺次排入，必要时自动延长。' }]
  return []
}

export function isScriptVideoTimingQuestion(question: string) {
  // A mixed question about casting or an actual plot contradiction still
  // requires its normal handling. Character names in a timing example do not.
  const castingQuestion = /(?:选|确定|确认|指定|提供|缺少|缺失|冲突|矛盾).{0,12}(?:哪张|哪套|造型|角色图|素材图|角色身份|说话人是谁|剧情版本)|(?:造型|角色图|素材图|说话人|角色身份|剧情版本).{0,12}(?:选哪|是哪|是谁|待确认|无法确定|需要确认|缺失|有歧义)|谁说|哪位角色|哪个角色|哪一套造型|哪个造型|哪张(?:角色|场景|参考|资产)图|(?:asset|costume|speaker identity|plot version).{0,25}(?:missing|choose|unclear|conflict)/iu
  if (castingQuestion.test(question)) return false
  const timing = /时长|语速|说不完|说完|念完|来不及说|加时|延时|延长|增段|缩时|拆段|加段|分段边界|(?:超出|超过|延至|压到|压至|限制|仅有|只有).{0,6}秒|\b(?:duration|timing|runtime|seconds|speaking pace)\b/iu
  const allocation = /(?:删减|压缩|删改|精简).{0,5}(?:对白|台词|原词|动作)|(?:台词|对白|段数|片段).{0,12}(?:压缩|删减|删改|拆分)|(?:拆分|增加|合并).{0,5}(?:分段|片段|段数)/u
  return timing.test(question) || allocation.test(question)
}
