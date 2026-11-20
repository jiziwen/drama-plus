import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { waitScriptVideoJob, type ScriptVideoClientJob } from '../app/utils/scriptVideoClient'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const tree = ts.createSourceFile('page.ts', parse(source).descriptor.scriptSetup!.content, ts.ScriptTarget.Latest)
const handlers = tree.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['monitorAIJob', 'storyboardProgressText', 'storyboardActionFor'].includes(node.name?.text || ''))
const {outputText} = ts.transpileModule(handlers.map(node => node.getText(tree)).join('\n'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
})
const job = (status: ScriptVideoClientJob['status'], completed: number, phase: 'generating' | 'validating' = 'generating') =>
  ({id: 'job-3', status, progress: {phase, completed, total: 7}})

function viewedEpisode() {
  const progress: Record<string, unknown> = {}
  const installed: string[] = []
  const page = runInNewContext(outputText + '\n;({monitorAIJob,storyboardProgressText,storyboardActionFor})', {
    aiProgress: {value: progress}, requestController: new AbortController(), waitScriptVideoJob,
    scriptVideoRequest: async (path: string) => path,
    installProject: async (path: string) => installed.push(path),
  })
  return {
    watch: (initial: ScriptVideoClientJob) => page.monitorAIJob('七天', '第3集', initial),
    label: (episode = '第3集') => page.storyboardProgressText(progress['七天/' + episode]),
    action: () => JSON.parse(JSON.stringify(page.storyboardActionFor(progress['七天/第3集']))),
    installed,
  }
}

test('重新打开整集任务显示保存段数，中断后可手动续写', async (t) => {
  const view = viewedEpisode()
  const fetched = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', () => fetched.promise)
  const watching = view.watch(job('running', 2))
  assert.match(view.label(), /整集生成.*已保存 2\/7 段/)
  assert.equal(view.label('第4集'), '')
  assert.deepEqual(view.installed, [])
  fetched.resolve(Response.json({data: {...job('failed', 3), error: '第4段对白未通过校验'}}))
  await assert.rejects(watching, /第4段对白未通过校验/)
  assert.match(view.label(), /已保存 3\/7 段.*继续/)
  assert.deepEqual(view.action(), {label: '续写剩余片段', body: {resumeFromJobId: 'job-3'}})
  assert.deepEqual(view.installed, [])
})

test('分批任务显示保存进度，超时后续写剩余片段', async (t) => {
  const view = viewedEpisode()
  const fetched = Promise.withResolvers<Response>()
  const initial = job('running', 2)
  const progress = { ...initial.progress, batchSize: 1 }
  t.mock.method(globalThis, 'fetch', () => fetched.promise)
  const watching = view.watch({ ...initial, progress })
  assert.equal(view.label(), '正在分批生成，已保存 2/7 段')
  fetched.resolve(Response.json({data: { ...initial, status: 'failed', progress, error: '本批生成超时' }}))
  await assert.rejects(watching, /本批生成超时/)
  assert.deepEqual(view.action(), { label: '续写剩余片段', body: { resumeFromJobId: 'job-3' } })
})

test('失败详情只列出一次相同的问题，同时保留不同的逐段说明', async (t) => {
  const message = '两段原台词按自然语速超时。\n请确认处理方式。'
  const detail = '第4段的结束时码重复。'
  const problem = (text: string) => ({ code: 'USER_INPUT_REQUIRED', message: text })
  t.mock.method(globalThis, 'fetch', () => Response.json({data: {
    ...job('failed', 0), error: message, issues: [problem(message), problem(detail), problem(detail)],
  }}))
  await assert.rejects(viewedEpisode().watch(job('running', 0)), { message: message + '\n' + detail })
})

test('旧版在首段前要求选择时长的失败任务直接重新生成，采用当前默认指令', async (t) => {
  const view = viewedEpisode()
  const failed: ScriptVideoClientJob = {
    id: 'old-timing-choice', action: 'storyboard', status: 'failed', code: 'USER_INPUT_REQUIRED',
    progress: {phase: 'generating', completed: 0, total: 5, repairAttempts: 0}, error: '请确认处理方式',
  }
  t.mock.method(globalThis, 'fetch', () => Response.json({data: failed}))
  await assert.rejects(view.watch(failed), /请确认处理方式/)
  assert.deepEqual(view.action(), {label: '确认大纲，生成分镜与提示词', body: {}})
})

test('已生成全部片段仍显示整集校验，仅完成后读取并安装正式结果', async (t) => {
  const view = viewedEpisode()
  const validating = Promise.withResolvers<void>()
  let count = 0
  t.mock.method(globalThis, 'fetch', () => {
    if (++count === 1) {
      // Resolve when the polling client has actually consumed the response.
      return {ok: true, json: async () => {
        setTimeout(() => validating.resolve(), 0)
        return {data: job('running', 7, 'validating')}
      }}
    }
    return Response.json({data: {...job('completed', 7, 'validating'), result: {timing: {segments: 7, seconds: 183}}}})
  })
  const watching = view.watch(job('running', 6))
  assert.match(view.label(), /整集生成.*已保存 6\/7 段/)
  await validating.promise
  assert.match(view.label(), /正在校验整集.*7 段/)
  assert.deepEqual(view.installed, [])
  assert.deepEqual((await watching).result.timing, {segments: 7, seconds: 183})
  assert.deepEqual(view.installed, ['/projects/七天'])
  assert.equal(view.label(), '')
})

test('第三次修复失败后显示具体原因和已停止，保留现有正式分镜', async (t) => {
  const view = viewedEpisode()
  const repair = { phase: 'repairing' as const, repairAttempts: 3, completed: 5, total: 7 }
  const pending = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', () => pending.promise)
  const watching = view.watch({id: 'job-3', status: 'running', progress: repair})
  assert.match(view.label(), /第 3\/3 次/)
  pending.resolve(Response.json({data: {id: 'job-3', status: 'failed', code: 'STORYBOARD_REPAIRS_EXHAUSTED', progress: repair, issues: [{code: 'DIALOGUE_CHANGED', message: '第 4 段的对白顺序有误'}]}}))
  await assert.rejects(watching, /第 4 段的对白顺序有误/)
  assert.match(view.label(), /已达 3 次，任务已停止/)
  assert.deepEqual(view.action(), {label: '重新生成整集', body: {restartAfterRepairs: true}})
  assert.deepEqual(view.installed, [])
})

test('逐段修复仅显示当前段次数，耗尽后继续当前段而不重新生成整集', async (t) => {
  const view = viewedEpisode()
  const repair = { phase: 'repairing' as const, batchSize: 1, repairAttempts: 8, segmentRepairAttempts: 3,
    currentCardId: 'fourth', completed: 3, total: 7 }
  const pending = Promise.withResolvers<Response>()
  t.mock.method(globalThis, 'fetch', () => pending.promise)
  const watching = view.watch({ id: 'job-3', status: 'running', progress: repair })
  assert.match(view.label(), /修复当前段.*第 3\/3 次/)
  assert.doesNotMatch(view.label(), /8\/3/)
  pending.resolve(Response.json({ data: { id: 'job-3', status: 'failed', code: 'STORYBOARD_REPAIRS_EXHAUSTED',
    progress: repair, error: '第4段镜头时长不完整' } }))
  await assert.rejects(watching, /第4段镜头时长不完整/)
  assert.match(view.label(), /当前段.*已保存 3\/7 段.*重试当前段/)
  assert.deepEqual(view.action(), { label: '继续当前段', body: { resumeFromJobId: 'job-3', retryCurrentSegment: true } })
  assert.deepEqual(view.installed, [])
})

test('旧版逐段任务耗尽后也可继续当前段，保留成功前缀', async (t) => {
  const view = viewedEpisode()
  const failed = { id: 'job-3', status: 'failed' as const, code: 'STORYBOARD_REPAIRS_EXHAUSTED',
    progress: { phase: 'validating' as const, batchSize: 1, repairAttempts: 3, completed: 3, total: 11 },
    error: '整集已用完 3 次自动修复' }
  t.mock.method(globalThis, 'fetch', () => Response.json({ data: failed }))
  await assert.rejects(view.watch(failed), /3 次/)
  assert.deepEqual(view.action(), { label: '继续当前段', body: { resumeFromJobId: 'job-3', retryCurrentSegment: true } })
})

test('服务重启时第一段尚未通过也能继续已用过两次修复的草稿', async (t) => {
  const view = viewedEpisode()
  const failed = {id: 'job-3', status: 'failed' as const, code: 'INTERRUPTED',
    progress: {phase: 'repairing' as const, repairAttempts: 2, completed: 0, total: 7}}
  t.mock.method(globalThis, 'fetch', () => Response.json({data: {...failed, error: '服务重启'}}))
  await assert.rejects(view.watch(failed), /服务重启/)
  assert.match(view.label(), /已用 2\/3 次/)
  assert.deepEqual(view.action(), {label: '继续处理已保存的分镜', body:{resumeFromJobId:'job-3'}})
})

test('首段修复连接中断后即使回到校验阶段也能继续，沿用本段已用次数', async (t) => {
  const view = viewedEpisode()
  const failed = { id: 'job-3', status: 'failed' as const, code: 'MODEL_TIMEOUT',
    progress: { phase: 'validating' as const, batchSize: 1, repairAttempts: 5, segmentRepairAttempts: 2,
      completed: 0, total: 7 }, error: '修复连接中断' }
  t.mock.method(globalThis, 'fetch', () => Response.json({ data: failed }))
  await assert.rejects(view.watch(failed), /修复连接中断/)
  assert.deepEqual(view.action(), { label: '继续处理已保存的分镜', body: { resumeFromJobId: 'job-3' } })
})
