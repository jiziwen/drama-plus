import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateStoryboard } from '../workspace/skills/script-to-video/scripts/validation'

// Fixture documents from the original v8.2 audit_storyboard unit tests.
const GOOD_HYBRID = `
平台配置：SD25-001
模式策略：AUTO-HYBRID

| B-ID | E-TC | T-BEAT | 场景/连续时间 | 主要主体 | 主动作 | 序列目标 | 摄影语法 | 硬边界 | 必需尾帧 |
|---|---|---:|---|---|---|---|---|---|---|
| B01 | 00:00–00:08 | 8s | 舞台/连续 | 角色甲 | 起身 | 完成登台 | 中景推近 | 无 | 站稳 |
| B02 | 00:08–00:16 | 8s | 舞台/连续 | 角色甲 | 挥棒 | 完成登台 | 低机位横移 | 无 | 棒势停住 |
| B03 | 00:16–00:24 | 8s | 后台/连续 | 角色乙 | 回望 | 确认出口 | 近景定镜 | 换场 | 面向出口 |

| G-ID | B-ID覆盖 | MODE | T-EDIT合计 | T-GEN | 剪辑余量 | 单一序列目标 | 判定码 | 合并/不合并理由 | 时间控制 | 回退任务 |
|---|---|---|---:|---:|---|---|---|---|---|---|
| G01 | B01–B02 | LONG | 16s | 18s | 入1s/出1s | 完成登台 | MERGE | 同场连续动作，合并维持棒势 | Timestamp | B01、B02 STANDARD |
| G02 | B03 | STANDARD | 8s | 10s | 入1s/出1s | 确认出口 | NO_CONTINUITY_GAIN | 换场后的独立反应 | Natural | 无 |
`
const BAD_LONG = `
平台配置：SD25-001
模式策略：AUTO-HYBRID

| B-ID | E-TC | T-BEAT | 场景/连续时间 | 主要主体 | 主动作 | 序列目标 | 摄影语法 | 硬边界 | 必需尾帧 |
|---|---|---:|---|---|---|---|---|---|---|
| B01 | 00:00–00:08 | 8s | 舞台/连续 | 角色甲 | 起身 | 完成登台 | 中景推近 | 无 | 站稳 |

| G-ID | B-ID覆盖 | MODE | T-EDIT合计 | T-GEN | 剪辑余量 | 单一序列目标 | 判定码 | 合并/不合并理由 | 时间控制 | 回退任务 |
|---|---|---|---:|---:|---|---|---|---|---|---|
| G01 | B01 | LONG | 8s | 12s | — | — | HARD_BOUNDARY | — | — | — |
`

const table = '| 镜号 | 时长 | 景别／机位／运动 | 画面与动作 | 对白／音效 |\n|---|---|---|---|---|\n'
const first = '## 视频编号 01｜开门（共30秒）\n总时长：30秒\n' + table + '| 1 | 14.5秒 | 近景 | 守卫起身。 | 布料声 |\n| 2 | 15.5s | 远景 | 守卫开门。 | 门轴响 |\n'
const short = '## 02　回望（0.3 秒）\n' + table + '| 1 | 0.1秒 | 特写 | 回望。 | — |\n| 2 | 0.2秒 | 定镜 | 停顿。 | — |\n'
const codes = (doc: string) => validateStoryboard(doc).issues.map(issue => issue.code)

test('accepts exact per-card totals including non-integer short segments; ignores Markdown in prompts', () => {
  const prompt = ['','````text', first, '```', '## 视频编号 300（共450秒）','````'].join('\n')
  const r = validateStoryboard(first + short + prompt)
  assert.equal(r.ok, true, JSON.stringify(r.issues))
  assert.deepEqual(r.segments.map(s => [s.number,s.duration,s.shotCount]), [['01',30,2],['02',0.3,2]])
  assert.equal(r.packageCount, 0)
  assert.equal(validateStoryboard(first + short, { targetSeconds: 30 }).ok, false)
  assert.deepEqual(codes('SD25-001 / AUTO-HYBRID\n' + first), ['PKG001'])
})

test('rejects mismatched declarations, malformed rows, zero duration, missing cards and totals above the production limit', () => {
  assert.ok(codes(first.replace('总时长：30秒','总时长：28秒')).includes('DUR009'))
  assert.ok(codes(first.replace('14.5秒','十五秒')).includes('DUR006'))
  assert.ok(codes(first.replace('14.5秒','0秒')).includes('DUR006'))
  assert.ok(codes(first.replace('14.5秒','15.5秒')).includes('DUR008'))
  assert.ok(codes(first.replace('| 门轴响 |', '| 门轴响 | 多一栏 |')).includes('DUR005'))
  assert.ok(codes('## 视频编号 01\n'+table).includes('DUR007'))
  assert.ok(codes('# 剧本\n铁门打开').includes('DOC001'))
  assert.ok(codes(short.replace('0.3 秒', '0.30000000000000000001 秒')).includes('DUR009'))
})

test('audits original AUTO-HYBRID fixtures and missing/duplicate beat coverage', () => {
  const good = validateStoryboard(GOOD_HYBRID)
  assert.deepEqual([good.ok, good.beatCount, good.packageCount, good.issues.length], [true, 3, 2, 0])
  for (const code of ['TIME002','LONG001','LONG002','LONG003','LONG004']) assert.ok(codes(BAD_LONG).includes(code), code)
  const duplicate = GOOD_HYBRID.replace('| G02 | B03', '| G01 | B02')
  for (const code of ['COVER001','COVER003','COVER004']) assert.ok(codes(duplicate).includes(code), code)
  assert.ok(codes(GOOD_HYBRID.replace('B01–B02','B01–B04')).includes('COVER005'))
  assert.ok(codes(GOOD_HYBRID.replace('低机位横移 | 无', '低机位横移 | 换场')).includes('LONG006'))
})

test('five-dimensional audit counts executable tables only; ignores auxiliary asset tables and template rows', () => {
  const assets = '\n| G-ID | T-GEN | 参考图 |\n|---|---|---|\n| G01 | 18s | a.png |\n'
  const placeholders = GOOD_HYBRID
    .replace('| B01 |', '| {{B-ID}} | {{E-TC}} |\n| B01 |')
    .replace('| G01 |', '| G03 | {{B-ID覆盖}} |\n| G01 |')
  const report = validateStoryboard(placeholders + assets)
  assert.deepEqual([report.issues, report.beatCount, report.packageCount], [[], 3, 2])
  assert.deepEqual(codes(first + assets), [])
  const packagesOnly = GOOD_HYBRID.slice(GOOD_HYBRID.indexOf('| G-ID'))
  assert.ok(codes(packagesOnly).includes('BEAT004'))
})

test('warns about needless fragmentation and catches missing packaging or invalid legacy prompt timings', () => {
  const split = GOOD_HYBRID.replace(/^\| G01 .*$/m,
    '| G01 | B01 | STANDARD | 8s | 9s | 入1s | 完成登台 | HARD_BOUNDARY | 跨场 | Natural | 无 |\n' +
    '| G03 | B02 | STANDARD | 8s | 9s | 入1s | 完成登台 | DURATION_LIMIT | 超时 | Natural | 无 |')
  assert.ok(codes(split).includes('FRAG004'))
  assert.ok(codes(GOOD_HYBRID.split('| G-ID')[0]).includes('PKG001'))
  assert.ok(codes('# Prompt 1 SD25-001 LONG 0s–10s').includes('TIME002'))
})

test('CLI entry points read files, return diagnostic JSON and preserve distinct error / warning exit codes', () => {
  const temp = mkdtempSync(join(tmpdir(),'script-to-video-validation-'))
  const runner = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const run = (command: string, ...args: string[]) => spawnSync(process.execPath, [runner,
    fileURLToPath(new URL('../workspace/skills/script-to-video/scripts/' + command + '.ts', import.meta.url)), ...args
  ], { encoding: 'utf8' })
  try {
    const file = join(temp, '输入.md')
    writeFileSync(file, first + short)
    assert.equal(run('check-storyboard-duration', file).status, 0)
    const mismatch = run('check-storyboard-duration', '--target', '30', '--json', file)
    assert.equal(mismatch.status, 1)
    assert.equal(JSON.parse(mismatch.stdout)[0].issues[0].code, 'DUR009')
    writeFileSync(file, GOOD_HYBRID.replace('入1s/出1s', '—'))
    assert.equal(run('audit-storyboard', file).status, 1)
    writeFileSync(file, BAD_LONG)
    assert.equal(run('audit-storyboard', file).status, 2)
    assert.equal(run('check-storyboard-duration', file+'.missing').status, 2)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})
