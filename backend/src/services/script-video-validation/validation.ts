import { markdownLines, parseTables, type Issue } from './markdown.js'
import { auditPackaging } from './packaging.js'

export type { Issue } from './markdown.js'
export type ValidationOptions = { mode?: 'all' | 'duration' | 'audit'; targetSeconds?: number }
export type Segment = { number: string; duration: number; shotCount: number }
const header = /^#{2,4}\s+(?:视频编号\s*(\d+)|(\d+)(?=\s)).*$/u
const decimal = /^(\d+(?:\.\d+)?)\s*(?:秒|s)$/i
// Compare decimal seconds exactly, including fractions such as 0.1, 0.2 and 0.3.
function exactSum(parts: string[], targets: string[]) {
  const decimals = [...parts, ...targets].map(n => n.split('.')[1]?.length || 0)
  const places = decimals.reduce((max, n) => Math.max(max, n), 0)
  const unit = (n: string) => {
    const [integer, fraction = ''] = n.split('.')
    return BigInt(integer + fraction.padEnd(places, '0'))
  }
  const sum = parts.reduce((sum, s) => sum + unit(s), 0n)
  return { over: sum > unit('30'), match: targets.every(s => unit(s) === sum) }
}

export function validateStoryboard(markdown: string, options: ValidationOptions = {}) {
  const issues: Issue[] = [], segments: Segment[] = []
  const lines = markdownLines(markdown), tables = parseTables(lines)
  const headers = lines.flatMap((line, i) => {
    const match = header.exec(line)
    return match ? [{ line: i + 1, number: match[1] || match[2] }] : []
  })
  const mode = options.mode || 'all'
  const error = (code: string, message: string, line?: number) => issues.push({ level: 'ERROR', code, message, line })
  const requested = options.targetSeconds
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0 || requested > 30 || !/^\d+(?:\.\d+)?$/.test(String(requested)))) error('DUR000', '指定目标时长须为 0 到 30 之间的正秒数。')
  if (mode !== 'audit') {
    const ids = new Set<string>()
    for (const [i, section] of headers.entries()) {
      const end = headers[i + 1]?.line || lines.length + 1
      const targets: string[] = []
      const headingSeconds = /[（(]\s*(?:共\s*)?(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[）)]\s*$/i.exec(lines[section.line - 1])?.[1]
      if (headingSeconds) targets.push(headingSeconds)
      const number = section.number.replace(/^0+(?=\d)/, '')
      if (ids.has(number)) error('DUR001', '视频编号重复。', section.line)
      ids.add(number)
      for (let n = section.line; n < end - 1; n++) {
        const declared = /^\s*总时长\s*[：:]\s*(.*?)\s*$/.exec(lines[n].replace(/\*\*/g, ''))
        if (!declared) continue
        const seconds = decimal.exec(declared[1])?.[1]
        if (seconds) targets.push(seconds)
        else error('DUR002', '总时长须填写精确秒数。', n + 1)
      }
      if (requested !== undefined && !issues.some(i => i.code === 'DUR000')) targets.push(String(requested))
      if (!targets.length) error('DUR003', '缺少该视频编号的总时长。', section.line)
      const parts: string[] = []
      let shotCount = 0
      for (const table of tables) {
        if (table.line <= section.line || table.line >= end || !table.headers.includes('镜号')) continue
        if (table.headers.length !== 5 || table.headers[0] !== '镜号' || table.headers[1] !== '时长') {
          error('DUR004', '正式分镜需五列，前两列为镜号与时长。', table.line)
          continue
        }
        for (const { line, cells } of table.rows) {
          shotCount++
          if (cells.length !== 5 || !/^\d+$/.test(cells[0])) error('DUR005', '镜头行缺列或镜号无效。', line)
          const seconds = decimal.exec(cells[1] || '')?.[1]
          if (!seconds || Number(seconds) <= 0 || !Number.isFinite(Number(seconds))) error('DUR006', '单镜时长必须为正数并标明单位。', line)
          else parts.push(seconds)
        }
      }
      if (!shotCount) error('DUR007', '未找到可校验的五列镜头行。', section.line)
      const sum = exactSum(parts, targets)
      if (sum.over || targets.some(t => Number(t) <= 0 || Number(t) > 30)) error('DUR008', '本段时长应大于 0 秒且不超过 30 秒。', section.line)
      if (!sum.match) error('DUR009', '逐镜时长之和与本段声明或指定时长不符。', section.line)
      const duration = Number(parts.reduce((total, part) => total + Number(part), 0).toPrecision(15))
      segments.push({ number: section.number, duration, shotCount })
    }
  }
  const audit = mode === 'duration' ? { beatCount: 0, packageCount: 0, promptCount: 0, hasSchema: false }
    : auditPackaging(tables, lines, issues)
  if ((mode === 'duration' && !headers.length) ||
    (mode !== 'duration' && !headers.length && !audit.hasSchema && !audit.promptCount && !issues.length)) {
    error('DOC001', '未找到正式分镜视频编号或可审计的五维封装。')
  }
  return { ok: !issues.some(i => i.level === 'ERROR'), issues, segments, beatCount: audit.beatCount, packageCount: audit.packageCount, promptCount: audit.promptCount }
}
