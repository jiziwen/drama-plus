export type ScriptVideoAssetScopeRange = {
  start: number
  end: number
  kind: 'handoff' | 'summary' | 'sound'
}

const doubleOpening = /^←承上[：:][ \t]*←承上(?:视频编号[ \t]*\d+|第\d+段)?[：:][ \t]*/u
const openingLabel = /^(?:[ \t]*(?:←承上(?:视频编号[ \t]*\d+|第[ \t]*\d+[ \t]*段)?|开场画面)[ \t]*[：:][ \t]*)+/u
const previousShot = /^(?:上一镜|前一镜|前镜|(?:上一|前一|上|前)段(?:的)?(?:末镜|最后一镜|尾帧)|上一集(?:的)?末镜)/u
const openingCut = /(?:^|(?<=[。！？.!?；;]))[ \t]*(?:本段[ \t]*)?(?:同场切镜|换场切镜)/gu
const endingLabel = /^(?:(?:→衔接|末镜停在)[：:][ \t]*)+/u
const nextSegmentHeading = /→衔接至(?:第[ \t]*\d+[ \t]*[段场集]|视频编号[ \t]*\d+|下一(?:个)?(?:段|片段))[ \t]*[：:]/gu
const nextSegmentSentence = /(?:^|(?<=[。！？；;]))[ \t]*(?:下一(?:个)?片段|下(?:一)?[段场集])(?:[：:]|[ \t]*(?:的?开场|的?开头|从|才|再|将|会|接入|转入|切到|切至|切入))/gu
const summaryHeading = /^[ \t]*(?:独立生成|本段事件)[ \t]*[：:]/u
const recapHeading = /^[ \t]*前镜回顾[ \t]*[：:]/u
const numberedShot = /^镜头[ \t]*(\d+)(?:[ \t]*(?:[（(：:][^\r\n]*)?)\r?$/gmu
const dialogueHeading = /^[ \t]*(?:对白[ \t]*[/／][ \t]*音效|对白|台词|画外音|心声)[ \t]*[：:][ \t]*/u
const foleyHeading = /^[ \t]*(?:物理音效|音效|环境音|环境声|背景音效|背景音|拟音|动作音|音乐|配乐|BGM|SFX)(?:[（(][^）)\n]*[）)])?[ \t]*[：:]/iu
const foleySuffix = /[（(](?:物理音效|音效|环境音|环境声|背景音效|背景音|拟音|动作音|BGM|SFX)[）)][。.!！?？ \t]*$/iu
const speakerHeading = /^[ \t]*(?:@(?=[\p{L}\p{N}])|(?=[^：:\r\n]+[：:][ \t]*[“「『"{]))[\p{L}\p{N}·・、_ /-]+(?:[ \t]*(?:（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]))*[ \t]*[：:]/u
const visualHeading = /^[ \t]*(?:镜头[ \t]*\d|(?:前镜回顾|←承上|→衔接(?:至[^：:\r\n]*)?|末镜停在|开场画面|场景(?:[一二三四五六七八九十\d]+)?|人物|角色设定|总时长|景别(?:[ \t]*[／/][ \t]*机位[ \t]*[／/][ \t]*运动)?|画面与动作|独立生成|本段事件)[ \t]*[：:])/u

export function scriptVideoShotHeadings(prompt: string) {
  return [...prompt.matchAll(numberedShot)].map(match => ({ start: match.index!, index: Number(match[1]) - 1 }))
}

export function hasScriptVideoShotHeadings(prompt: string) {
  return scriptVideoShotHeadings(prompt).length > 0
}

/** Top-level cuts never split speech quotes or the parentheses carrying line reads. */
function enclosedText(text: string) {
  return [...text.matchAll(/“[^”]*”?|「[^」]*」?|『[^』]*』?|"(?:\\.|[^"\\])*"?|\{[^}]*\}?|<[^>]*>|（[^）]*）?|\([^)]*\)?|【[^】]*】?|\[[^\]]*\]?/gu)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }))
}

function outside(spans: ReturnType<typeof enclosedText>, index: number) {
  return !spans.some(span => span.start <= index && index < span.end)
}

function priorOpeningEnd(line: string) {
  const prefix = openingLabel.exec(line)?.[0].length
  if (prefix === undefined) return
  const opening = line.slice(prefix)
  if (!previousShot.test(opening)) return
  const spans = enclosedText(opening)
  const cut = [...opening.matchAll(openingCut)].find(match => outside(spans, match.index!))
  if (cut) return prefix + cut.index!
}

function endingParts(line: string) {
  const leading = line.match(/^[ \t]*/u)![0].length
  const content = line.slice(leading)
  const prefix = endingLabel.exec(content)?.[0].length || 0
  if (!prefix && !content.startsWith('→衔接至')) return undefined
  const endText = content.slice(prefix)
  const spans = enclosedText(endText)
  const explicit = [...endText.matchAll(nextSegmentHeading)].find(match => outside(spans, match.index!))?.index
  if (!prefix && explicit !== 0) return undefined
  const plain = [...endText.matchAll(nextSegmentSentence)].find(match => outside(spans, match.index!))?.index
  const future = Math.min(explicit ?? endText.length, plain ?? endText.length)
  return {
    current: endText.slice(0, future).trimEnd(),
    start: future < endText.length ? leading + prefix + future : undefined,
  }
}

/** The current clip's final portrait stays in delivery. Following-clip direction stays as notes. */
export function splitScriptVideoHandoff(text: string): { body: string; notes: string[] } {
  const notes: string[] = []
  const body = text.replace(/[^\r\n]+/gu, line => {
    const ending = endingParts(line)
    if (ending) {
      if (ending.start !== undefined) notes.push(line.slice(ending.start))
      return ending.current ? '→衔接：' + ending.current : ''
    }
    return line.replace(doubleOpening, '←承上：')
  })
  return { body, notes }
}

function soundRanges(line: string, origin: number): ScriptVideoAssetScopeRange[] {
  const result: ScriptVideoAssetScopeRange[] = []
  const spans = enclosedText(line)
  const cut = Math.min(line.length,
    ...[...line.matchAll(nextSegmentHeading), ...line.matchAll(nextSegmentSentence)]
      .filter(match => outside(spans, match.index!)).map(match => match.index!))
  const current = line.slice(0, cut)
  const pauses = [...current.matchAll(/[；;，,。！？!?]/gu)].flatMap(match => {
    const index = match.index!
    if (!outside(spans, index)) return []
    const after = current.slice(index + 1)
    return /[；;]/u.test(match[0]) || foleyHeading.test(after) || visualHeading.test(after) ||
      speakerHeading.test(after) || /^\s*</u.test(after) ? [index] : []
  })
  let start = 0
  for (const end of [...pauses, current.length]) {
    const value = current.slice(start, end)
    // A same-line visual column starts a new context, even if a manual edit
    // uses punctuation instead of a newline between the two columns.
    if (visualHeading.test(value)) break
    if (foleyHeading.test(value) || (foleySuffix.test(value) && !speakerHeading.test(value))) {
      result.push({ start: origin + start, end: origin + end, kind: 'sound' })
    } else {
      for (const span of spans) {
        if (span.start < start || span.end > end || line[span.start] !== '<' ||
          /^<(?:Picture|Audio)\s*\d+>$/iu.test(line.slice(span.start, span.end))) continue
        result.push({ start: origin + span.start, end: origin + span.end, kind: 'sound' })
      }
    }
    start = end + 1
  }
  if (cut < line.length) result.push({ start: origin + cut, end: origin + line.length, kind: 'handoff' })
  return result
}

/** Offsets refer to the original string and never overlap. */
export function scriptVideoAssetScopeRanges(text: string, dialogue = false): ScriptVideoAssetScopeRange[] {
  const result: ScriptVideoAssetScopeRange[] = []
  let summary: ScriptVideoAssetScopeRange | undefined
  let recap: ScriptVideoAssetScopeRange | undefined
  let inSound = dialogue
  let previousLineEnd = 0
  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    const line = match[0], start = match.index!, end = start + line.length
    if (!line.trim() || (previousLineEnd && !/^(?:\r\n|\n|\r)$/u.test(text.slice(previousLineEnd, start)))) {
      summary = undefined
      inSound = dialogue
    }
    previousLineEnd = end
    if (!line.trim()) continue

    if (recapHeading.test(line)) {
      recap = { start, end, kind: 'handoff' }
      result.push(recap)
      summary = undefined
      inSound = false
      continue
    }
    if (recap && !visualHeading.test(line)) {
      recap.end = end
      continue
    }
    recap = undefined
    const ending = endingParts(line)
    if (ending) {
      summary = undefined
      inSound = false
      if (ending.start !== undefined) result.push({ start: start + ending.start, end, kind: 'handoff' })
      continue
    }
    const priorEnd = priorOpeningEnd(line)
    if (priorEnd !== undefined) {
      result.push({ start, end: start + priorEnd, kind: 'handoff' })
      summary = undefined
      inSound = false
      continue
    }
    if (summaryHeading.test(line)) {
      summary = { start, end, kind: 'summary' }
      result.push(summary)
      inSound = false
      continue
    }
    const heading = dialogueHeading.exec(line)
    const explicitSound = foleyHeading.test(line)
    const attributed = speakerHeading.test(line)
    if (summary && !heading && !explicitSound && !attributed && !visualHeading.test(line)) {
      summary.end = end
      continue
    }
    summary = undefined
    if (heading || attributed) inSound = true
    else if (visualHeading.test(line)) inSound = false
    if (inSound || explicitSound) {
      const offset = heading?.[0].length ?? 0
      result.push(...soundRanges(line.slice(offset), start + offset))
    }
  }
  return result
}

const movement = '(?:返回(?:到)?|回到|回|移驾(?:到|去|至)?|移步(?:到|去|至)?|前往|到达|抵达|走进|走入|进入|进|去往|去|转场(?:到|至)|转(?:到|入|至)|切(?:换)?(?:到|入|至))'
const notVisiting = new RegExp(`(?:并未|尚未|未曾|没有|还没|没|未|避免|禁止|不(?:要|许|得|必|能|会|愿意|愿|肯|想)?)[ \\t]*(?:再|实际|真正|立即|马上)?[ \\t]*${movement}[ \\t]*$`, 'u')
const proposedDestination = new RegExp(`(?:劝(?:说|请|其|他|她|陛下|娘娘|殿下|对方)?|建议|提议|请求|请|让|命令|吩咐|商议|商量|讨论|打算|计划|想要|想|准备|设想|考虑|拒绝|想起要)(?:其|他|她|陛下|娘娘|殿下|对方)?[ \\t]*(?:下(?:一)?(?:段|场)|之后|稍后|次日|明日)?[ \\t]*(?:先|暂且|暂时|暂|马上|立即|一同|一起)?[ \\t]*${movement}[ \\t]*$`, 'u')
const unseenReference = /(?:(?:禁止|避免|未|没有|没|无需|不(?:要|得|许|会|再)?)[ \t]*(?:出现|展示|呈现|拍摄|拍到)|看不见|看不到|不在|镜头外的?)[ \t]*$/u
const searchOrRecall = /(?:寻找|找寻|搜寻|寻觅)(?:失踪的?|遗失的?|消失的?|尚未现身的?)?[ \t]*$|(?:回想(?:起)?|回忆(?:起)?|想起|记起|提及|说起|谈到)(?:当年|那年|曾经的?|往日的?|之前的?|先前的?)?[ \t]*$/u
const realizedTarget = /^[ \t]*(?:[，,][ \t]*)?(?:并|且|然后|随后|最终|终于|随即|后|接着)*(?:找到|找出|寻得|拿起|捡起|握住|抽出|取出)(?:了)?(?=$|[，。；;！？、]|它|并|且)/u

/** Only a local grammatical cue can make a location mention nonvisual. */
export function isScriptVideoNonvisualMention(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 90), start).split(/[\r\n，。！？、；：,.!?;:]/u).at(-1) || ''
  if (notVisiting.test(before) || proposedDestination.test(before) || unseenReference.test(before)) return true
  const after = text.slice(end, end + 32)
  if (searchOrRecall.test(before) && !realizedTarget.test(after)) return true
  return /^[ \t]*(?:[（(](?:仅(?:提及|对白提及|台词提及)|未到达|不出镜|不入画|不拍摄)[）)]|[只仅](?:在(?:对白|台词|谈话|话)中)?(?:被)?提(?:及|到)|[，,][ \t]*(?:不入画|不出镜|没有出镜)(?=[，,、。；;]|$))/u.test(after)
}
