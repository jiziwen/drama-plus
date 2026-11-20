import { readFileSync } from 'node:fs'
import { validateStoryboard } from './validation'

function readMarkdown(path: string): string {
  const bytes = readFileSync(path)
  const encodings = bytes[0] === 0xff && bytes[1] === 0xfe ? ['utf-16le'] :
    bytes[0] === 0xfe && bytes[1] === 0xff ? ['utf-16be'] : ['utf-8', 'gb18030']
  for (const encoding of encodings) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) } catch { /* Try the other source encoding. */ }
  }
  throw new Error('无法识别文件编码。')
}

export function runCli(mode: 'audit' | 'duration', args: string[]) {
  const help = mode === 'duration' ? 'check-storyboard-duration.ts [--target 秒数] [--json] <分镜.md> ...' : 'audit-storyboard.ts [--json] <分镜.md> ...'
  let targetSeconds: number | undefined, json = false
  const paths: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') { console.log(help); return 0 }
    if (arg === '--json') json = true
    else if (arg === '--target' && mode === 'duration') {
      targetSeconds = Number(args[++i])
      if (!(targetSeconds > 0 && targetSeconds <= 30)) { console.error(help); return 2 }
    } else if (arg.startsWith('-')) { console.error(help); return 2 }
    else paths.push(arg)
  }
  if (!paths.length) { console.error(help); return 2 }
  let exitCode = 0
  const reports = paths.map(path => {
    try {
      const report = validateStoryboard(readMarkdown(path), { mode, targetSeconds })
      if (!report.ok) exitCode = Math.max(exitCode, mode === 'audit' ? 2 : 1)
      else if (report.issues.length) exitCode = Math.max(exitCode, 1)
      return { path, ...report }
    } catch (err) {
      exitCode = 2
      return { path, ok: false, segments: [], beatCount: 0, packageCount: 0, promptCount: 0, issues: [{ level: 'ERROR', code: 'FILE001', message: err instanceof Error ? err.message : String(err), line: undefined }] }
    }
  })
  if (json) console.log(JSON.stringify(reports, null, 2))
  else for (const r of reports) {
    console.log(r.path, r.ok ? 'PASS' : 'FAIL', mode === 'duration' ? r.segments.map(s => '第' + s.number + '段 ' + s.duration + '秒').join('，') : 'B=' + r.beatCount + ' G=' + r.packageCount + ' Prompt=' + r.promptCount)
    for (const issue of r.issues) console.log('[' + issue.level + '] ' + issue.code + (issue.line ? ' 行' + issue.line : '') + ' ' + issue.message)
  }
  return exitCode
}
