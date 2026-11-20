import { column, normalize, type Issue, type Table } from './markdown.js'

type ModeRecord = { id: string; mode: string; duration: number; line: number }
type Beat = { id: string; duration: number; scene: string; subject: string; goal: string; boundary: string; line: number }
type Package = ModeRecord & { beats: string[]; decision: string }
const decisions = new Set(['MERGE', 'HARD_BOUNDARY', 'MULTI_SUBJECT', 'ASSET_GAP', 'SYNC_RISK', 'USER_LOCK', 'NO_CONTINUITY_GAIN', 'DURATION_LIMIT'])
const modes: Record<string, [number, number]> = { STANDARD: [4, 15], LONG: [16, 30], ULTRA: [31, 180] }
function empty(value: string) { return !value || value.includes('{{') || /^(?:-|—|无|NONE|N\/A|待定)$/i.test(value) }
function seconds(value: string) {
  const match = /(?:^|[^\d:.-])(\d+(?:\.\d+)?)\s*(?:s\b|秒)/i.exec(value) || /^(\d+(?:\.\d+)?)$/.exec(value)
  return match ? Number(match[1]) : NaN
}
function id(letter: string, n: number) { return letter + String(n).padStart(2, '0') }
function beatIds(input: string): string[] {
  const list: string[] = []
  for (const match of input.matchAll(/\bB\s*(\d+)(?:\s*[-–—]\s*B?\s*(\d+))?/gi)) {
    const first = Number(match[1]), last = Number(match[2] || match[1])
    if (!Number.isSafeInteger(last) || first > last || last - first > 500) return []
    for (let n = first; n <= last; n++) list.push(id('B', n))
  }
  return list
}
function auditFragmentation(beats: Beat[], owners: Map<string, Package[]>, issues: Issue[]) {
  for (let start = 0; start < beats.length; start++) {
    for (let length = 2; length <= 4 && start + length <= beats.length; length++) {
      const group = beats.slice(start, start + length)
      const first = group[0]
      const duration = group.reduce((sum, b) => sum + b.duration, 0)
      if (!(duration >= 16 && duration <= 30) || empty(first.scene) || empty(first.subject) || empty(first.goal)) continue
      if (group.slice(1).some(b => b.scene !== first.scene || b.subject !== first.subject || b.goal !== first.goal || (!empty(b.boundary) && b.boundary !== 'NO'))) continue
      const assigned = group.map(b => owners.get(b.id) || [])
      if (!assigned.every(items => items.length === 1 && items[0].mode === 'STANDARD')) continue
      const tasks = assigned.map(items => items[0])
      if (new Set(tasks.map(task => task.id)).size !== group.length) continue
      const why = tasks.some(t => !t.decision) ? 'FRAG003' : tasks.every(t => t.decision === 'DURATION_LIMIT' || t.decision === 'HARD_BOUNDARY') ? 'FRAG004' : ''
      if (why) issues.push({ level: 'WARN', code: why, line: first.line, message: first.id + ' 起的连续节拍可合并，检查拆分理由与硬边界。' })
    }
  }
}

/** Port of five-dimension-storyboard v8.2 audit_storyboard.py. */
export function auditPackaging(tables: Table[], lines: string[], issues: Issue[]) {
  const beats: Beat[] = [], packages: Package[] = [], prompts: ModeRecord[] = []
  const beatById = new Map<string, Beat>(), owners = new Map<string, Package[]>(), genIds = new Set<string>()
  const legacyTiming: { equal: boolean; line: number }[] = []
  let hasSchema = false
  function error(code: string, message: string, line?: number) { issues.push({ level: 'ERROR', code, message, line }) }
  function warn(code: string, message: string, line?: number) { issues.push({ level: 'WARN', code, message, line }) }
  function checkMode(task: ModeRecord) {
    if (!modes[task.mode]) return error('MODE001', task.id + ' 的 MODE 无效', task.line)
    if (!Number.isFinite(task.duration)) return error('TIME001', task.id + ' 的 T-GEN 无效', task.line)
    const [low, high] = modes[task.mode]
    if (task.duration < low || task.duration > high) error('TIME002', task.id + ' 的 ' + task.mode + ' 要求 T-GEN 在 ' + low + '–' + high + ' 秒。', task.line)
  }
  for (const table of tables) {
    const b = column(table, 'B-ID'), g = column(table, 'G-ID')
    const directorTable = b >= 0 && g < 0 && column(table, 'T-BEAT', 'T-EDIT') >= 0
    const packageTable = g >= 0 && b >= 0 && column(table, 'MODE') >= 0 && column(table, 'T-GEN') >= 0
    for (const { line, cells } of table.rows) {
      const field = (...keys: string[]) => cells[column(table, ...keys)] || ''
      const tEdit = seconds(field('T-EDIT')), tGen = seconds(field('T-GEN'))
      if (g < 0 && Number.isFinite(tEdit) && Number.isFinite(tGen)) legacyTiming.push({ equal: tEdit === tGen, line })
      if (!directorTable && !packageTable) continue
      if (cells.some(value => value.includes('{{'))) continue
      hasSchema = true
      if (cells.length !== table.headers.length) { error('TABLE002', '节拍或封装行与表头列数不一致。', line); continue }
      if (g < 0) {
        const matched = /^B\s*(\d+)$/i.exec(cells[b])
        if (!matched) { error('BEAT001', 'B-ID 格式无效。', line); continue }
        const beat = { id: id('B', Number(matched[1])), duration: seconds(field('T-BEAT', 'T-EDIT')), scene: normalize(field('场景')), subject: normalize(field('主要主体', '主体')), goal: normalize(field('序列目标')), boundary: normalize(field('硬边界')), line }
        if (beatById.has(beat.id)) error('BEAT002', 'B-ID 重复 ' + beat.id, line)
        if (!(beat.duration > 0)) error('BEAT003', beat.id + ' 缺少有效的节拍时长。', line)
        beats.push(beat)
        beatById.set(beat.id, beat)
        continue
      }
      const matched = /^G\s*(\d+)$/i.exec(cells[g])
      if (!matched) { error('PKG003', 'G-ID 格式无效。', line); continue }
      const task: Package = { id: id('G', Number(matched[1])), beats: beatIds(cells[b] || ''), mode: /\b(STANDARD|LONG|ULTRA)\b/i.exec(field('MODE'))?.[1].toUpperCase() || '', duration: tGen, decision: field('判定码').toUpperCase(), line }
      packages.push(task)
      if (genIds.has(task.id)) error('COVER001', '重复的 ' + task.id, line)
      genIds.add(task.id)
      checkMode(task)
      if (!task.beats.length) error('COVER002', task.id + ' 未填写有效 B-ID 覆盖。', line)
      if (empty(field('序列目标'))) error('GOAL001', task.id + ' 缺少单一序列目标。', line)
      if (empty(task.decision)) error('DECIDE001', task.id + ' 缺少判定码。', line)
      else if (!decisions.has(task.decision)) error('DECIDE002', task.id + ' 的判定码无效。', line)
      if (empty(field('理由'))) error('DECIDE003', task.id + ' 缺少合并或拆分理由。', line)
      if (empty(field('剪辑余量', 'HANDLE'))) warn('EDIT001', task.id + ' 缺少剪辑余量或零余量理由。', line)
      if (task.mode === 'STANDARD' && task.decision === 'MERGE') error('DECIDE004', 'STANDARD 不可使用 MERGE。', line)
      if (task.mode === 'LONG') {
        if (task.beats.length < 2 || task.beats.length > 4) error('LONG001', 'LONG 应覆盖 2–4 个连续节拍。', line)
        if (task.decision !== 'MERGE') error('LONG002', 'LONG 的判定码须为 MERGE。', line)
        if (empty(field('回退'))) error('LONG003', 'LONG 缺少分节拍的短任务回退方案。', line)
        if (!/\b(?:Natural|Timestamp)\b/i.test(field('时间控制', 'Natural/Timestamp'))) error('LONG004', 'LONG 缺少 Natural 或 Timestamp 时间控制。', line)
      }
      for (const beat of task.beats) {
        const assigned = owners.get(beat) || []
        assigned.push(task)
        owners.set(beat, assigned)
      }
    }
  }
  const isSD25 = lines.some(l => /SD25-001/i.test(l))
  const auto = lines.some(l => /AUTO-HYBRID/i.test(l)), standardOnly = lines.some(l => /STANDARD-ONLY/i.test(l))
  lines.forEach((line, i) => {
    const m = /^#{1,6}\s*Prompt\s+(\d+).*?SD(?:25|20)-001\s+(STANDARD|LONG|ULTRA).*?0s\s*[-–—]\s*(\d+(?:\.\d+)?)s/i.exec(line)
    if (m) prompts.push({ id: id('G', Number(m[1])), mode: m[2].toUpperCase(), duration: Number(m[3]), line: i + 1 })
  })
  if (hasSchema && !beats.length) error('BEAT004', '缺少可解析的 B-ID 导演节拍表。')
  if (!packages.length) {
    prompts.forEach(checkMode)
    if (hasSchema || (isSD25 && auto)) error('PKG001', '缺少可解析的 G-ID 封装表。')
    else if (isSD25 && prompts.length >= 6) warn('PKG002', '多任务提示词缺少 B/G 表，无法检查节拍覆盖。')
  }
  for (const [beat, assigned] of owners) {
    if (assigned.length > 1) error('COVER003', beat + ' 在主封装中重复覆盖。', assigned[1].line)
    if (!beatById.has(beat)) error('COVER005', '封装引用了不存在的 ' + beat, assigned[0].line)
  }
  for (const beat of beats) if (!owners.has(beat.id)) error('COVER004', beat.id + ' 未被主封装覆盖。', beat.line)
  const order = new Map(beats.map((beat, index) => [beat.id, index]))
  for (const task of packages.filter(task => task.mode === 'LONG')) {
    const first = order.get(task.beats[0])
    if (first !== undefined && task.beats.some((b, i) => order.get(b) !== first + i)) error('LONG005', 'LONG 跨过节拍或顺序不连续。', task.line)
    if (task.beats.slice(1).some(b => { const boundary = beatById.get(b)?.boundary || ''; return !empty(boundary) && boundary !== 'NO' })) error('LONG006', 'LONG 不应跨过硬边界。', task.line)
  }
  auditFragmentation(beats, owners, issues)
  const active = packages.length ? packages : prompts
  if (standardOnly && active.some(t => t.mode && t.mode !== 'STANDARD')) error('MODE002', 'STANDARD-ONLY 与实际任务模式不符。')
  if (isSD25 && active.length >= 8 && !standardOnly && active.every(t => t.mode === 'STANDARD')) {
    warn('FRAG001', '全部任务均为 STANDARD，请复核连续长动作。')
    if (active.filter(t => t.duration <= 10).length / active.length >= .8) warn('FRAG002', '至少八成任务不超过 10 秒，请复核拆分依据。')
  }
  if (legacyTiming.length >= 4 && legacyTiming.filter(r => r.equal).length / legacyTiming.length >= .8) warn('EDIT002', '至少八成记录的 T-EDIT 等于 T-GEN，请复核剪辑余量。', legacyTiming[0].line)
  return { beatCount: beats.length, packageCount: packages.length, promptCount: prompts.length, hasSchema }
}
