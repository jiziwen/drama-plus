import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import { computed, reactive, ref } from 'vue'
import ts from 'typescript'
import { waitScriptVideoJob, type ScriptVideoClientJob } from '../app/utils/scriptVideoClient'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const tree = ts.createSourceFile('page.ts', parse(page).descriptor.scriptSetup!.content, ts.ScriptTarget.Latest)
const handlerNames = ['beginTextRun', 'finishTextRun', 'submitTextRun', 'cancelTextGeneration',
  'cancelReservedTextRun', 'monitorTextRun', 'monitorAIJob', 'restoreEpisodeAIJobs']
const handlers = tree.statements.filter(node => ts.isFunctionDeclaration(node) && handlerNames.includes(node.name?.text || ''))
assert.equal(handlers.length, handlerNames.length)
const { outputText } = ts.transpileModule(handlers.map(node => node.getText(tree)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

const project = 'project'
const episode = 'episode'
const key = `${project}/${episode}`
const running: ScriptVideoClientJob = { id: 'job', action: 'revisions', cardId: 'target-card', status: 'running' }
const canceled: ScriptVideoClientJob = { ...running, status: 'canceled', code: 'CANCELED' }

function setup(options: {
  save?: () => Promise<void>
  reservation?: () => Promise<ScriptVideoClientJob>
}) {
  const requests: string[] = []
  const notices: string[] = []
  const errors: string[] = []
  const textRuns = ref<Record<string, any>>({})
  const currentTextRun = computed(() => textRuns.value[key])
  const watching = Promise.withResolvers<AbortSignal>()
  const scriptVideoRequest = async (path: string, method = 'GET') => {
    requests.push(`${method} ${path}`)
    if (path.endsWith('/cancel')) return canceled
    if (method === 'POST') return options.reservation?.()
    if (path.includes('jobs?')) return [running]
    throw new Error(`Unexpected request ${path}`)
  }
  const api = runInNewContext(outputText + '\n;({beginTextRun, finishTextRun, submitTextRun, cancelTextGeneration, restoreEpisodeAIJobs})', {
    alive: true, reactive, textRuns, currentTextRun, AbortController, AbortSignal, DOMException,
    requestController: new AbortController(),
    aiErrors: ref({}), aiProgress: ref({}), episodeReviews: ref({}), restoredRevisions: ref({}),
    toast: { info: (message: string) => notices.push(message), error: (message: string) => errors.push(message) },
    scriptVideoRequest,
    videoEpisode: () => ({ busy: false }),
    episodeLock: { owns: () => true },
    saveProjectNow: options.save || (async () => {}),
    waitScriptVideoJob: async (_projectId: string, _id: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      watching.resolve(signal)
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  })
  return { api, requests, notices, errors, currentTextRun, watching }
}

test('在保存完成前取消，仍保存已有改动且不提交生成', async () => {
  const pendingSave = Promise.withResolvers<void>()
  const { api, requests, notices } = setup({ save: () => pendingSave.promise })
  const run = api.beginTextRun(project, episode, 'outline')
  const submitted = api.submitTextRun(run, {})
  await api.cancelTextGeneration()
  assert.equal(run.cancelRequested, true)
  pendingSave.resolve()
  await assert.rejects(submitted, { name: 'AbortError' })
  assert.deepEqual(requests, [])
  assert.equal(notices.length, 1)
})

test('提交请求返回任务编号后取消一次，并用取消状态结束等待', async () => {
  const started = Promise.withResolvers<void>()
  const pendingJob = Promise.withResolvers<ScriptVideoClientJob>()
  const { api, requests, errors } = setup({ reservation: () => {
    started.resolve()
    return pendingJob.promise
  } })
  const run = api.beginTextRun(project, episode, 'revisions', running.cardId)
  const submitted = api.submitTextRun(run, {})
  await started.promise
  await api.cancelTextGeneration()
  await api.cancelTextGeneration()
  pendingJob.resolve(running)
  await assert.rejects(submitted, { name: 'AbortError' })
  assert.deepEqual(requests, ['POST /projects/project/episodes/episode/revisions', 'POST /projects/project/jobs/job/cancel'])
  assert.deepEqual(errors, [])
})

test('重新进入分集可取消后台运行的单段修改', async () => {
  const { api, requests, errors, currentTextRun, watching } = setup({})
  const restored = api.restoreEpisodeAIJobs(project, episode)
  const signal = await watching.promise
  assert.equal(currentTextRun.value?.cardId, running.cardId)
  await api.cancelTextGeneration()
  await restored
  assert.equal(signal.aborted, true)
  assert.equal(currentTextRun.value, undefined)
  assert.deepEqual(requests, ['GET /projects/project/jobs?episodeId=episode', 'POST /projects/project/jobs/job/cancel'])
  assert.deepEqual(errors, [])
})

test('轮询收到后端已取消状态时停止，并按 AbortError 处理', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: canceled }))
  await assert.rejects(waitScriptVideoJob(project, running.id), { name: 'AbortError' })
  assert.equal(fetch.mock.callCount(), 1)
})
