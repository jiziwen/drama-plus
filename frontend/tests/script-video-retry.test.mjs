import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { computed, reactive, ref } from 'vue'
import ts from 'typescript'
import { officialScriptVideoUrl } from '../../backend/src/services/script-video-versions.ts'
import { buildScriptVideoDelivery, scriptVideoDeliveryTags } from '../../backend/src/services/script-video-delivery.ts'
import { resolveScriptVideoResolution, scriptVideoModelResolutions } from '../../backend/src/services/script-video-resolution.ts'
import { hasScriptVideoPromptBody, splitScriptVideoPromptStyle } from '../../backend/src/services/script-video-style.ts'
import { previousScriptVideoCard } from '../../backend/src/services/script-video-predecessor.ts'
import { DEFAULT_VIDEO_PROMPT_MODE } from '../../backend/src/services/video-prompt-mode.ts'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const promptModeStart = source.indexOf('const videoPromptModes =')
const promptModeEnd = source.indexOf('const currentReview =', promptModeStart)
const resolutionStart = source.indexOf('function effectiveVideoResolution(')
const resolutionEnd = source.indexOf('\n}', resolutionStart) + 2
const start = source.indexOf('const taskActions =')
const end = source.indexOf('function sourceChapterCount(', start)
const controllerSource = ts.transpileModule([
  source.slice(promptModeStart, promptModeEnd), source.slice(resolutionStart, resolutionEnd), source.slice(start, end),
].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

class ScriptVideoRequestError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const failed = (id, cardId, code, taskId) => ({ id, cardId, code, taskId, status: 'failed', error: '通道不可用' })

function controller(initialTasks = [], {
  onLookup, onSubmit, onFinalPrompt, onContinuations, onExport, clipboardWrite, onSave, onRefresh, missingVoices = () => [],
  pendingAudioEdits = () => undefined,
  connections = [], lightingScenes = {}, cardIds = ['a', 'b'],
  remoteActiveIds = [], queueTimer = setInterval, previousEpisodes = [],
} = {}) {
  const calls = []
  const episode = {
    id: 'episode', confirmed: true, outlineConfirmed: true, modelConfigId: 1,
    modelName: 'custom-model', modelMaxDuration: 30, modelMaxAudioReferences: null,
    aspectRatio: '16:9', resolution: '720p', tasks: initialTasks,
    cards: cardIds.map(id => ({ id, version: 1, duration: 30, shots: lightingScenes[id] ? [{}] : [] })),
  }
  const project = { id: 'project', assets: [], episodes: [...previousEpisodes, episode] }
  const leaseActive = ref(true)
  const dialog = ref(null)
  const toasts = []
  const copied = []
  const currentProject = ref(project), currentEpisode = ref(episode), projects = ref([project])
  const selectedProjectId = ref(project.id), selectedEpisodeId = ref(episode.id)
  const episodeKey = computed(() => `${selectedProjectId.value}/${selectedEpisodeId.value}`)
  const refreshes = []
  function navigate(otherProject = false) {
    const otherEpisode = { ...episode, id: 'other-episode', modelName: 'other-model', resolution: '1080P', tasks: [], cards: [] }
    const other = otherProject ? { id: 'other-project', assets: [], episodes: [otherEpisode] } : project
    if (otherProject) projects.value.push(other)
    else project.episodes.push(otherEpisode)
    currentProject.value = other
    currentEpisode.value = otherEpisode
    selectedProjectId.value = other.id
    selectedEpisodeId.value = otherEpisode.id
    return { project: other, episode: otherEpisode }
  }
  function navigateBack() {
    currentProject.value = project
    currentEpisode.value = episode
    selectedProjectId.value = project.id
    selectedEpisodeId.value = episode.id
  }
  const value = runInNewContext(controllerSource + '\n;({ requestVideoGeneration, cancelVideoGeneration, confirmVideoRetry, pendingVideoRetry, videoTaskError, showFinalPrompt, copyPromptPreview, promptPreview, batchVideoVoiceWarning, videoVoiceWarningForCard, activeVideoRun, activeVideoRequests, videoTailWaiting, deliveryContinuations, exportCards, videoPromptMode })', {
    ref, computed, reactive, dialog, activeCardIds: ref(remoteActiveIds), requestActivityRefresh: () => {}, setInterval: queueTimer, clearInterval, ScriptVideoRequestError, alive: true, AbortController, AbortSignal, requestController: new AbortController(),
    officialScriptVideoUrl, previousScriptVideoCard,
    resolveScriptVideoResolution, scriptVideoModelResolutions,
    watch: () => {}, // The batch asset watcher has its own test harness.
    videoModelLoading: ref(false), videoSelectionPending: ref(false),
    promptReturnFocus: null,
    episodeKey, previewId: () => 'video-request-fixture',
    setTimeout: done => queueMicrotask(done), clearTimeout,
    episodeLock: { owns: (projectId, episodeId) => leaseActive.value && projectId === selectedProjectId.value && episodeId === selectedEpisodeId.value },
    getScriptVideoContinuationScene: (previous, next) => connections.includes(`${previous.id}/${next.id}`),
    buildScriptVideoEpisodeLightingPlan: () => Object.fromEntries(Object.entries(lightingScenes).map(([id, scenes]) =>
      [id, (Array.isArray(scenes) ? scenes : [scenes]).map((sceneKey, i) => ({ sceneKey, firstShot: i + 1 }))])),
    currentProject, currentEpisode, projects, tasks: computed(() => currentEpisode.value.tasks),
    DEFAULT_VIDEO_PROMPT_MODE, exporting: ref(false), confirmedScript: ref(''),
    exportPreviewPackage: async (...args) => { await onExport?.(...args) },
    cards: computed(() => currentEpisode.value.cards), assets: computed(() => currentProject.value.assets),
    saveProjectNow: async id => { await onSave?.(id) }, pendingAudioEdits,
    refreshProject: async (projectId, episodeId) => { refreshes.push({ projectId, episodeId }); await onRefresh?.(projectId, episodeId) },
    selectedProjectId, selectedEpisodeId,
    navigator: { onLine: true, clipboard: { writeText: async text => {
      await clipboardWrite?.(text)
      copied.push(text)
    } } },
    validatePreviewCards: () => ({ ok: true }),
    getScriptVideoMissingVoices: missingVoices,
    buildScriptVideoDelivery: (card, assets, options) => options.preview ? buildScriptVideoDelivery(card, assets, options) : { voices: [] },
    scriptVideoDeliveryTags, hasScriptVideoPromptBody, splitScriptVideoPromptStyle,
    toast: { error: message => toasts.push(message), success: () => {}, info: message => toasts.push(message) },
    scriptVideoRequest: async (path, method = 'GET', body) => {
      calls.push({ path, method, body })
      if (path.endsWith('/video-queue')) return {}
      if (method === 'GET' && path === '/projects/project') return project
      if (method === 'GET') {
        return onLookup?.(path, episode) || { status: 'completed', videoUrl: '/static/videos/task-21.mp4' }
      }
      if (path.endsWith('/final-prompt')) return onFinalPrompt?.(body) || finalDelivery()
      if (path.endsWith('/continuations')) return onContinuations?.(body)
      if (path.endsWith('/validate')) return { referenceImages: {} }
      if (path.endsWith('/video-cancel')) return { canceled: 1, upstreamUnconfirmed: 0 }
      return onSubmit?.(path, body, episode) || { taskId: 21 }
    },
  })
  return { ...value, dialog, calls, episode, project, toasts, copied, leaseActive, navigate, navigateBack, refreshes, selectedEpisodeId,
    get submissions() { return calls.filter(call => call.method === 'POST' && /\/cards\/[^/]+\/video$/.test(call.path)) },
  }
}

function finalDelivery(overrides = {}) {
  return { prompt: '原提示词', images: [], audios: [], missingVoices: [], source: 'preview', ...overrides }
}

for (const cardId of [undefined, 'a']) test(cardId ? '提交中取消单段时携带片段 ID' : '取消批量请求会阻止下一段提交', async () => {
  let finishSubmit
  let notifySubmit
  const started = new Promise(resolve => { notifySubmit = resolve })
  const app = controller([], {
    onSubmit() {
      notifySubmit()
      return new Promise(resolve => { finishSubmit = resolve })
    },
  })
  assert.equal(app.activeVideoRun.value, undefined)
  const generating = app.requestVideoGeneration(cardId ? [cardId] : ['a', 'b'])
  await started
  assert.deepEqual([...app.activeVideoRun.value.cardStatuses], cardId
    ? [['a', 'generating']]
    : [['a', 'generating'], ['b', 'queued']])
  await app.cancelVideoGeneration(undefined, cardId)
  assert.equal(app.activeVideoRun.value, undefined)
  const cancel = app.calls.find(call => call.path.endsWith('/video-cancel'))
  assert.equal(cancel.body.requestId, app.submissions[0].body.requestId)
  assert.equal(cancel.body.cardId, cardId)
  finishSubmit({ taskId: 51 })
  await generating
  assert.equal(app.submissions.length, 1)
})

test('已确认失败直接重新提交，错误原因保持可见', async () => {
  const task = failed('known', 'a', 'VIDEO_FAILED', 11)
  const app = controller([task])
  assert.equal(app.videoTaskError(task), '通道不可用')
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 1)
  assert.equal(app.submissions[0].body.confirmRetryAfterUnknown, undefined)
  assert.equal(app.submissions[0].body.promptMode, 'reference-guide')
})

test('批量提交使用点击时选定的提示词模式', async () => {
  const app = controller([], {
    onSubmit(path) {
      if (path.endsWith('/cards/a/video')) app.videoPromptMode.value = 'reference-guide'
    },
  })
  app.videoPromptMode.value = 'inline'
  await app.requestVideoGeneration(['a', 'b'])
  assert.deepEqual(app.submissions.map(({ body }) => body.promptMode), ['inline', 'inline'])
})

test('提示词导出在准备参考图和交付包时使用同一个模式', async () => {
  let exportedMode
  const app = controller([], {
    connections: ['a/b'],
    onContinuations() {
      app.videoPromptMode.value = 'reference-guide'
      return { continuations: {}, lightingRanges: {} }
    },
    onExport(_cards, _assets, _filename, context) { exportedMode = context.delivery.promptMode },
  })
  app.videoPromptMode.value = 'inline'
  await app.exportCards([app.episode.cards[1]])
  assert.equal(app.calls.find(({ path }) => path.endsWith('/continuations')).body.promptMode, 'inline')
  assert.equal(app.calls.find(({ path }) => path.endsWith('/validate')).body.promptMode, 'inline')
  assert.equal(exportedMode, 'inline')
})

test('即梦直接提交生成，保留选定时长且不请求前端报价', async () => {
  const app = controller()
  app.episode.modelProvider = 'jimeng'
  app.episode.modelName = 'jimeng-seedance-2.5'
  app.episode.videoDurations = { a: 18 }
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 1)
  assert.equal(app.submissions[0].body.duration, 18)
  assert.equal(app.submissions[0].body.model, 'jimeng-seedance-2.5')
  assert.equal(app.submissions[0].body.jimengQuoteId, undefined)
  assert.ok(!app.calls.some(call => call.path.endsWith('/quote')))
})

test('批量使用每段自己的出片时长，预览和提交默认素材说明置前', async () => {
  const app = controller()
  app.episode.videoDurations = { a: 12 }
  await app.showFinalPrompt({ cardId: 'a', title: '片段 A' })
  const preview = app.calls.find(call => call.path.endsWith('/final-prompt')).body
  assert.equal(preview.duration, 12)
  assert.equal(preview.promptMode, 'reference-guide')
  await app.requestVideoGeneration(['a', 'b'])
  assert.deepEqual(app.submissions.map(call => call.body.duration), [12, undefined])
  assert.deepEqual(app.submissions.map(call => call.body.promptMode), ['reference-guide', 'reference-guide'])
  assert.deepEqual(app.episode.cards.map(card => card.duration), [30, 30])
})

test('切换到时长上限更低的模型时，超出范围的生成设置会被拦截', async () => {
  const app = controller()
  app.episode.modelMaxDuration = 15
  app.episode.videoDurations = { a: 18 }
  await app.requestVideoGeneration(['a'])
  assert.equal(app.submissions.length, 0)
  assert.match(app.toasts[0], /最多 15 秒/u)
  app.episode.videoDurations.a = 15
  await app.requestVideoGeneration(['a'])
  assert.equal(app.submissions[0].body.duration, 15)
})

test('批量和单段生成采用项目分辨率，优先使用片段独立设置', async () => {
  const app = controller()
  app.project.settings = { defaultVideoResolution: '1080P' }
  app.episode.videoResolutions = { b: '480P' }
  await app.requestVideoGeneration(['a', 'b'])
  assert.deepEqual(app.submissions.map(call => call.body.resolution), ['1080P', '480P'])

  app.project.settings.defaultVideoResolution = '720P'
  await app.requestVideoGeneration(['a'])
  await app.requestVideoGeneration(['b'])
  assert.deepEqual(app.submissions.slice(2).map(call => call.body.resolution), ['720P', '480P'])
})

test('已发起的单段生成在保存期间离开分集后仍提交原片段', async () => {
  let saves = 0
  const app = controller([], { onSave: async () => {
    if (++saves === 2) app.leaseActive.value = false
  } })
  app.episode.modelProvider = 'jimeng'
  app.episode.modelName = 'jimeng-seedance-2.5'
  await app.requestVideoGeneration(['a'])
  assert.equal(saves, 2)
  assert.equal(app.submissions.length, 1)
  assert.match(app.submissions[0].path, /\/projects\/project\/episodes\/episode\/cards\/a\/video$/u)
})

for (const otherProject of [false, true]) test(otherProject ? '批量提交中切换项目后继续提交原分集的其余片段' : '批量提交中切换分集后继续提交原分集的其余片段', async () => {
  let submittedFirst, finishFirst
  const started = new Promise(resolve => { submittedFirst = resolve })
  const app = controller([], { onSubmit(path) {
    if (path.endsWith('/a/video')) {
      submittedFirst()
      return new Promise(resolve => { finishFirst = resolve })
    }
    return { taskId: 22 }
  } })
  app.videoPromptMode.value = 'inline'
  const generation = app.requestVideoGeneration(['a', 'b'])
  await started
  const other = app.navigate(otherProject)
  assert.equal(app.videoPromptMode.value, 'reference-guide')
  assert.equal(app.activeVideoRun.value, undefined)
  assert.ok(app.activeVideoRequests.value.has('project/episode'))
  finishFirst({ taskId: 21 })
  await generation
  assert.equal(app.submissions.length, 2)
  assert.ok(app.submissions.every(call => call.path.startsWith('/projects/project/episodes/episode/cards/')))
  assert.ok(app.submissions.every(call => call.body.model === 'custom-model' && call.body.resolution === '720P'))
  assert.ok(app.submissions.every(call => call.body.promptMode === 'inline'))
  assert.ok(app.refreshes.every(call => call.projectId === 'project' && call.episodeId === 'episode'))
  assert.equal(other.episode.tasks.length, 0)
  app.navigateBack()
  assert.equal(app.videoPromptMode.value, 'inline')
})

test('等待上一段尾帧期间切换分集，前段完成后仍会提交原分集续接段', async () => {
  let startedLookup, finishLookup
  const started = new Promise(resolve => { startedLookup = resolve })
  const app = controller([], { connections: ['a/b'], onLookup() {
    startedLookup()
    return new Promise(resolve => { finishLookup = resolve })
  } })
  const generation = app.requestVideoGeneration(['a', 'b'])
  await started
  app.navigate()
  finishLookup({ status: 'completed', videoUrl: '/static/videos/task-21.mp4' })
  await generation
  assert.equal(app.submissions.length, 2)
  assert.match(app.submissions[1].path, /\/projects\/project\/episodes\/episode\/cards\/b\/video$/u)
})

test('视频已成功提交后缓存刷新失败，仍保留任务编号并继续等待续接段', async () => {
  const app = controller([], { connections: ['a/b'], onRefresh() { throw new Error('临时读取失败') } })
  await app.requestVideoGeneration(['a', 'b'])
  assert.equal(app.submissions.length, 2)
  assert.ok(app.calls.some(call => call.method === 'GET' && call.path.endsWith('/video/21')))
})

test('切走后再返回明确取消批次，未提交的后续片段不会继续生成', async () => {
  let submittedFirst, finishFirst
  const started = new Promise(resolve => { submittedFirst = resolve })
  const app = controller([], { onSubmit() {
    submittedFirst()
    return new Promise(resolve => { finishFirst = resolve })
  } })
  const generation = app.requestVideoGeneration(['a', 'b'])
  await started
  app.navigate()
  app.navigateBack()
  await app.cancelVideoGeneration()
  finishFirst({ taskId: 21 })
  await generation
  assert.equal(app.submissions.length, 1)
  assert.ok(app.calls.some(call => call.path.endsWith('/video-cancel')))
})

test('原集后台出现未知提交时不在新集弹确认，返回原集主动重试后才允许重新提交', async () => {
  let startedSubmit, rejectFirst, first = true
  const started = new Promise(resolve => { startedSubmit = resolve })
  const app = controller([], { onSubmit(path) {
    if (path.endsWith('/a/video') && first) {
      first = false
      startedSubmit()
      return new Promise((_resolve, reject) => { rejectFirst = reject })
    }
    return { taskId: 22 }
  } })
  const generation = app.requestVideoGeneration(['a', 'b'])
  await started
  app.navigate()
  app.episode.tasks.push(failed('late-unknown', 'a', 'SUBMISSION_UNKNOWN'))
  rejectFirst(new ScriptVideoRequestError('提交结果未知', 409, 'SUBMISSION_UNKNOWN'))
  await generation
  assert.equal(app.submissions.length, 2)
  assert.equal(app.dialog.value, null)
  assert.equal(app.pendingVideoRetry.value, null)
  app.navigateBack()
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, 'video-retry')
  assert.equal(app.submissions.length, 2)
  await app.confirmVideoRetry(true)
  assert.equal(app.submissions.length, 3)
})

test('缓存中的未知任务先读本地状态，查明已拒绝后直接重新提交', async () => {
  const task = failed('stale', 'a', 'SUBMISSION_UNKNOWN', 11)
  const app = controller([task], {
    onLookup(path, episode) { if (path.endsWith('/11')) episode.tasks = [{ ...task, code: 'VIDEO_FAILED' }] },
  })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.calls[0].path, '/projects/project/video/11')
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 1)
  assert.equal(app.submissions[0].body.confirmRetryAfterUnknown, undefined)
})

test('真实提交结果未知先显示站内确认，确认后才带重试授权', async () => {
  const app = controller([failed('unknown', 'a', 'SUBMISSION_UNKNOWN')])
  assert.equal(app.videoTaskError(app.episode.tasks[0]), '通道不可用')
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, 'video-retry')
  assert.equal(app.submissions.length, 0)
  await app.confirmVideoRetry(true)
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 1)
  assert.equal(app.submissions[0].body.confirmRetryAfterUnknown, true)
})

test('批量可跳过结果未知的片段，仅提交其他片段', async () => {
  const app = controller([failed('unknown', 'a', 'SUBMISSION_UNKNOWN')])
  await app.requestVideoGeneration(['a', 'b'])
  assert.equal(app.dialog.value, 'video-retry')
  await app.confirmVideoRetry(false)
  assert.equal(app.submissions.length, 1)
  assert.match(app.submissions[0].path, /\/cards\/b\/video$/)
  assert.equal(app.submissions[0].body.confirmRetryAfterUnknown, undefined)
})

test('服务端第一次返回未知状态冲突时刷新并呈现确认入口', async () => {
  const app = controller([], {
    onSubmit(path, body, episode) {
      if (body.confirmRetryAfterUnknown) return
      episode.tasks = [failed('unknown', 'a', 'SUBMISSION_UNKNOWN')]
      throw new ScriptVideoRequestError('提交结果未知', 409, 'SUBMISSION_UNKNOWN')
    },
  })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, 'video-retry')
  assert.equal(app.submissions.length, 1)
  assert.equal(app.submissions[0].body.confirmRetryAfterUnknown, undefined)
  assert.deepEqual(app.toasts, [])
  await app.confirmVideoRetry(true)
  assert.equal(app.submissions[1].body.confirmRetryAfterUnknown, true)
})

test('历史未知提交被后续失败任务遮住时，409 仍提供可确认的重试入口', async () => {
  const app = controller([], {
    onSubmit(_path, body) {
      if (!body.confirmRetryAfterUnknown) throw new ScriptVideoRequestError('上次提交未收到结果。重新提交可能重复计费。', 409, 'SUBMISSION_UNKNOWN')
    },
    onRefresh() {
      app.episode.tasks = [failed('history-unknown', 'a', 'SUBMISSION_UNKNOWN'), failed('latest-failed', 'a', 'VIDEO_FAILED')]
    },
  })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, 'video-retry')
  assert.equal(app.pendingVideoRetry.value.jobs.get('a'), 'history-unknown')
  assert.deepEqual(app.toasts, [])
  await app.confirmVideoRetry(true)
  assert.equal(app.submissions.length, 2)
  assert.equal(app.submissions[1].body.confirmRetryAfterUnknown, true)
})

test('同卡历史未知提交仍未确认时，点击生成直接呈现确认入口', async () => {
  const app = controller([failed('history-unknown', 'a', 'SUBMISSION_UNKNOWN'), failed('latest-failed', 'a', 'VIDEO_FAILED')])
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, 'video-retry')
  assert.equal(app.submissions.length, 0)
  await app.confirmVideoRetry(true)
  assert.equal(app.submissions[0].body.confirmRetryAfterUnknown, true)
})

test('已出片但保存失败时恢复任务号，不重新提交', async () => {
  const app = controller([failed('delivery', 'a', 'DELIVERY_FAILED', 17)], { missingVoices: () => ['阿离'] })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 0)
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path === '/projects/project/video/17/recover').length, 1)
})

test('LibTV 查询超时后查询原任务，不进入重新计费确认或创建新任务', async () => {
  const task = { ...failed('libtv-query', 'a', 'SUBMISSION_UNKNOWN', 23), canRecover: true,
    error: 'LibTV 查询原任务超时，请稍后查询。' }
  const app = controller([task], { missingVoices: () => ['阿离'] })
  assert.match(app.videoTaskError(task), /LibTV 查询原任务超时/u)
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 0)
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path === '/projects/project/video/23/recover').length, 1)
})

for (const latestCode of ['VIDEO_FAILED', 'SUBMISSION_UNKNOWN']) test(`LibTV 历史原任务可查询时优先恢复，后续 ${latestCode} 不触发新生成`, async () => {
  const original = { ...failed('original', 'b', 'SUBMISSION_UNKNOWN', 23), canRecover: true }
  const app = controller([original, failed('later', 'b', latestCode)], {
    missingVoices: () => ['阿离'], connections: ['a/b'],
  })
  assert.equal(app.videoVoiceWarningForCard('b'), '')
  await app.requestVideoGeneration(['b'])
  assert.equal(app.dialog.value, null)
  assert.deepEqual(app.toasts, [])
  assert.equal(app.submissions.length, 0)
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path === '/projects/project/video/23/recover').length, 1)
  assert.ok(!app.calls.some(call => call.path.endsWith('/video-queue')))
})

test('已确认重新生成的历史原任务不再覆盖最新失败任务', async () => {
  const original = { ...failed('acknowledged', 'a', 'SUBMISSION_UNKNOWN_ACKNOWLEDGED', 23), canRecover: true }
  const app = controller([original, failed('later', 'a', 'VIDEO_FAILED')])
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 1)
  assert.ok(!app.calls.some(call => call.path.endsWith('/recover')))
})

test('只有已确认重新生成的原任务时，不再强制查询旧任务', async () => {
  const original = { ...failed('acknowledged', 'a', 'SUBMISSION_UNKNOWN_ACKNOWLEDGED', 23), canRecover: true }
  const app = controller([original])
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 1)
  assert.ok(!app.calls.some(call => call.path.endsWith('/recover')))
})

test('当前生成中任务优先于可查询的历史原任务', async () => {
  const original = { ...failed('original', 'a', 'SUBMISSION_UNKNOWN', 23), canRecover: true }
  const app = controller([original, { id: 'current', cardId: 'a', taskId: 24, status: 'processing' }])
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 0)
  assert.ok(!app.calls.some(call => call.path.endsWith('/recover')))
})

test('批量警告标明缺少音频的片段，单段生成独立检查', async () => {
  const app = controller([], { missingVoices: card => card.id === 'b' ? ['阿离'] : [] })
  assert.match(app.batchVideoVoiceWarning.value, /批量生成需要补齐第 2 段（阿离）的角色参考音频/u)
  assert.match(app.videoVoiceWarningForCard('b'), /缺少角色参考音频：阿离/u)
  assert.equal(app.videoVoiceWarningForCard('a'), '')
  await app.requestVideoGeneration(['a', 'b'])
  assert.equal(app.submissions.length, 0)
  assert.match(app.toasts[0], /缺少角色参考音频：阿离/u)
  await app.requestVideoGeneration(['b'])
  assert.equal(app.submissions.length, 0)
  assert.match(app.toasts[1], /缺少角色参考音频：阿离/u)
  await app.requestVideoGeneration(['a'])
  assert.equal(app.submissions.length, 1)
  assert.match(app.submissions[0].path, /\/cards\/a\/video$/u)
})

test('保存期间角色音频被移除时，提交前重新校验并拦截', async () => {
  let hasVoice = true
  const app = controller([], {
    missingVoices: () => hasVoice ? [] : ['阿离'],
    onSave() { hasVoice = false },
  })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.submissions.length, 0)
  assert.match(app.toasts[0], /缺少角色参考音频：阿离/u)
})

test('确认重试前失去分集占用时不会再次提交', async () => {
  const app = controller([failed('unknown', 'a', 'SUBMISSION_UNKNOWN')])
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, 'video-retry')
  app.leaseActive.value = false
  await app.confirmVideoRetry(true)
  assert.equal(app.submissions.length, 0)
})

test('批量仅让连续镜头等待上一段，独立片段可先提交', async () => {
  let completeFirst
  const previous = new Promise(resolve => { completeFirst = resolve })
  const app = controller([], {
    connections: ['a/b'], cardIds: ['a', 'b', 'c'],
    onLookup: path => path.endsWith('/21') ? previous : undefined,
    onSubmit: path => ({ taskId: path.endsWith('/a/video') ? 21 : 22 }),
  })
  const generation = app.requestVideoGeneration(['a', 'b', 'c'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(app.submissions.length, 2)
  assert.match(app.submissions[0].path, /\/a\/video$/)
  assert.match(app.submissions[1].path, /\/c\/video$/)
  completeFirst({ status: 'completed', videoUrl: '/static/videos/task-21.mp4' })
  await generation
  assert.match(app.submissions[2].path, /\/b\/video$/)
})

test('上一段失败后连续镜头跳过，独立片段仍可生成', async () => {
  const app = controller([], {
    connections: ['a/b'], cardIds: ['a', 'b', 'c'],
    onLookup: () => ({ status: 'failed' }),
  })
  await app.requestVideoGeneration(['a', 'b', 'c'])
  assert.equal(app.submissions.length, 2)
  assert.match(app.submissions[1].path, /\/c\/video$/)
  assert.match(app.toasts[0], /第 2 段需要第 1 段的尾帧/)
})

test('单发连续镜头时，上段无成片只给提示，相同场景独立镜头可生成', async () => {
  const app = controller([], { connections: ['a/b'], cardIds: ['a', 'b', 'c'] })
  await app.requestVideoGeneration(['b'])
  assert.equal(app.submissions.length, 0)
  assert.match(app.toasts[0], /第 2 段需要第 1 段的尾帧/)
  await app.requestVideoGeneration(['c'])
  assert.equal(app.submissions.length, 1)
})

test('连续镜头重试读取正片，导出重新查询尾帧和光线而非沿用任务快照', async () => {
  const archived = '/static/videos/from-old.mp4'
  const fresh = '/static/videos/current.jpg'
  const app = controller([
    { ...failed('retry', 'a', 'VIDEO_FAILED', 11), cardVersion: 1 },
    { ...failed('next', 'b', 'VIDEO_FAILED', 12), cardVersion: 1, modelLabel: 'custom-model',
      continuation: { previousTaskId: 3, imageUrl: '/static/videos/outdated.jpg' },
      lightingRanges: [{ imageUrl: '/static/videos/old-light.jpg' }] },
  ], {
    connections: ['a/b'], lightingScenes: { b: 'hall' },
    onContinuations: () => ({ continuations: { b: { previousTaskId: 9, imageUrl: fresh } }, lightingRanges: {} }),
  })
  Object.assign(app.episode.cards[0], { status: 'draft', videoUrl: archived, videoVersions: [{ url: archived }] })
  await app.requestVideoGeneration(['b'])
  assert.equal(app.submissions.length, 1)
  const references = await app.deliveryContinuations(app.project, app.episode, [app.episode.cards[1]], app.videoPromptMode.value)
  assert.deepEqual(Array.from(app.calls.find(call => call.path.endsWith('/continuations')).body.cardIds), ['b'])
  assert.equal(references.continuations.b.imageUrl, fresh)
  assert.equal(references.lightingRanges.b, undefined)
})

test('当前预览和任务记录都在弹框内按显示文字原样复制', async () => {
  const task = { id: 'next', cardId: 'b', cardVersion: 1, status: 'processing', taskId: 22, modelLabel: 'custom-model' }
  const images = [{ index: 7, name: '上一段尾帧', url: '/static/continuations/accepted.jpg' }]
  const app = controller([task], { onFinalPrompt: body => body.jobId
    ? finalDelivery({ prompt: '以@图片7作为本段首帧。\n\n原提示词', images, source: 'submitted' })
    : finalDelivery() })
  app.project.settings = { defaultVideoResolution: '1080P' }
  app.episode.videoResolutions = { b: '480P' }
  app.videoPromptMode.value = 'inline'
  await app.showFinalPrompt({ cardId: 'b', title: '当前分镜' })
  assert.equal(app.dialog.value, 'prompt-preview')
  assert.equal(app.calls[0].body.cardId, 'b')
  assert.equal(app.calls[0].body.cardVersion, 1)
  assert.equal(app.calls[0].body.model, 'custom-model')
  assert.equal(app.calls[0].body.resolution, '480P')
  assert.equal(app.calls[0].body.promptMode, 'inline')
  assert.equal(app.promptPreview.value.delivery.prompt, '原提示词')
  assert.equal(app.copied.length, 0)
  await app.copyPromptPreview()
  assert.equal(app.copied[0], '原提示词')
  await app.showFinalPrompt({ cardId: task.cardId, title: '任务记录', task })
  assert.equal(app.calls[1].body.jobId, task.id)
  assert.equal('resolution' in app.calls[1].body, false)
  assert.equal('promptMode' in app.calls[1].body, false)
  assert.equal(app.copied.length, 1)
  assert.match(app.promptPreview.value.delivery.prompt, /^以@图片7作为本段首帧。/u)
  assert.equal(app.promptPreview.value.delivery.images[0].url, images[0].url)
  await app.copyPromptPreview()
  assert.equal(app.copied[1], app.promptPreview.value.delivery.prompt)
  assert.equal(app.promptPreview.value.copied, true)
  assert.equal(app.calls.length, 2)
  assert.equal(app.submissions.length, 0)
})

test('更换角色音频进行中，当前预览和视频提交等待新声音保存', async () => {
  let finishReplacement
  const replacement = new Promise(resolve => { finishReplacement = resolve })
  let currentAudio = '/static/uploads/old.wav'
  const pending = replacement.then(() => { currentAudio = '/static/uploads/new.wav' })
  const heard = []
  const app = controller([], {
    pendingAudioEdits: id => id === 'project' ? pending : undefined,
    onFinalPrompt: () => finalDelivery({ audios: [{ index: 1, name: '侍卫', url: currentAudio }] }),
    onSubmit() { heard.push(currentAudio) },
  })
  const preview = app.showFinalPrompt({ cardId: 'a', title: '当前分镜' })
  const generation = app.requestVideoGeneration(['a'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(app.calls.length, 0)
  finishReplacement()
  await Promise.all([preview, generation])
  assert.equal(app.promptPreview.value.delivery.audios[0].url, '/static/uploads/new.wav')
  assert.deepEqual(heard, ['/static/uploads/new.wav'])
})

test('素材引用警告与最终提示词一起返回，仍可原样复制正文且不提交生成', async () => {
  const warnings = ['请确认本段引用的角色「吴良」。', '折扇缺少参考图。']
  const prompt = '画面与动作：吴良展开折扇。\n对白／音效：〈折扇轻响〉'
  const app = controller([], { onFinalPrompt: () => finalDelivery({ prompt, warnings }) })
  await app.showFinalPrompt({ cardId: 'a', title: '当前分镜' })
  const preview = app.promptPreview.value
  assert.equal(app.dialog.value, 'prompt-preview')
  assert.equal(preview.context, '待补齐素材 · custom-model')
  assert.deepEqual([...preview.delivery.warnings], warnings)
  assert.equal(preview.delivery.prompt, prompt)
  assert.equal(preview.pending, false)
  assert.equal(preview.error, '')
  await app.copyPromptPreview()
  assert.deepEqual(app.copied, [prompt])
  assert.deepEqual(app.calls.map(call => call.path), ['/projects/project/episodes/episode/final-prompt'])
  assert.equal(app.submissions.length, 0)
})

test('准备尾帧和光线参考时立即显示分镜正文，服务端核对后才可复制最终提示词', async () => {
  let completeSave, completePreview, requested
  const saving = new Promise(resolve => { completeSave = resolve })
  const preparing = new Promise(resolve => { completePreview = resolve })
  const previewRequested = new Promise(resolve => { requested = resolve })
  const app = controller([], { onSave: () => saving, onFinalPrompt: () => { requested(); return preparing } })
  app.episode.cards[0].prompt = '画面与动作：@吴良展开折扇。'
  const opened = app.showFinalPrompt({ cardId: 'a', title: '当前分镜' })
  assert.equal(app.dialog.value, 'prompt-preview')
  assert.equal(app.promptPreview.value.draft, app.episode.cards[0].prompt)
  assert.equal(app.promptPreview.value.pending, true)
  assert.equal(app.calls.length, 0)
  completeSave()
  await previewRequested
  await app.copyPromptPreview()
  assert.deepEqual(app.copied, [])

  const final = finalDelivery({ prompt: '以@图片1作为尾帧参考。@吴良展开折扇。' })
  completePreview(final)
  await opened
  assert.equal(app.promptPreview.value.pending, false)
  assert.equal(app.promptPreview.value.delivery.prompt, final.prompt)
  await app.copyPromptPreview()
  assert.deepEqual(app.copied, [final.prompt])
})

test('保存遇到已删除素材时直接预览和复制本机当前草稿，保留现存素材编号', async () => {
  const message = '引用的素材已移除，请更新本地草稿后再保存'
  const app = controller([], {
    connections: ['a/b'],
    onSave() { throw new ScriptVideoRequestError(message, 409, 'ASSET_REMOVED') },
  })
  const card = app.episode.cards[1]
  app.episode.modelName = 'wf-minimax-h3'
  app.episode.modelProvider = 'minimax'
  app.project.assets.push(
    { id: 'wu', kind: 'character', name: '吴良', image: '/static/uploads/wu.png', voiceAudio: { name: '吴良声音', url: '/static/uploads/wu.wav' } },
    { id: 'fan', kind: 'prop', name: '折扇', image: '/static/uploads/fan.png' },
  )
  const action = '@吴良展开@折扇。'
  const dialogue = '吴良：“这句只有本机草稿有。”'
  Object.assign(card, {
    assetIds: ['removed', 'fan', 'wu'], shots: [{ duration: 30, action, dialogue }],
    prompt: '镜头 01（0–30秒）\n画面与动作：' + action + '\n对白／音效：' + dialogue,
  })
  const before = structuredClone(card)
  await app.showFinalPrompt({ cardId: 'b', title: '待同步分镜' })
  const preview = app.promptPreview.value
  assert.equal(preview.context, '本机草稿 · 尚未同步')
  assert.equal(preview.error, '')
  assert.ok(preview.delivery.warnings.includes(message))
  assert.ok(preview.delivery.warnings.some(item => item.includes('removed')))
  assert.match(preview.delivery.prompt, /这句只有本机草稿有/u)
  assert.deepEqual(Array.from(preview.delivery.images, ref => [ref.index, ref.tag, ref.url]), [
    [1, '<Picture 1>', '/static/uploads/fan.png'], [2, '<Picture 2>', '/static/uploads/wu.png'],
  ])
  assert.deepEqual(Array.from(preview.delivery.audios, ref => [ref.index, ref.tag, ref.name, ref.url]), [
    [1, '<Audio 1>', '吴良', '/static/uploads/wu.wav'],
  ])
  assert.match(preview.delivery.pending, /尾帧/u)
  assert.equal(preview.delivery.firstFrame, undefined)
  await app.copyPromptPreview()
  assert.deepEqual(app.copied, [preview.delivery.prompt])
  assert.deepEqual(card, before)
  assert.equal(app.calls.length, 0)
})

test('登录、普通保存冲突和网络错误仍然中止预览，不用本机草稿代替', async () => {
  for (const error of [
    new ScriptVideoRequestError('请重新登录', 401),
    new ScriptVideoRequestError('版本冲突', 409, 'CONFLICT'),
    new Error('网络断开'),
  ]) {
    const app = controller([], { onSave() { throw error } })
    await app.showFinalPrompt({ cardId: 'a', title: '当前分镜' })
    assert.equal(app.promptPreview.value.delivery, null)
    assert.ok(app.promptPreview.value.error)
    assert.equal(app.calls.length, 0)
  }
})

test('历史任务可单独查看首帧，当前设置可显示等待及缺音频状态', async () => {
  const firstFrame = { name: '上一段尾帧', url: '/static/continuations/first.jpg' }
  const task = { id: 'old', cardId: 'b', cardVersion: 0, status: 'completed', taskId: 22, modelLabel: 'custom-model' }
  const app = controller([task], { onFinalPrompt: body => body.jobId
    ? finalDelivery({ firstFrame, source: 'submitted' })
    : finalDelivery({ pending: '上一段出片后会带入尾帧', missingVoices: ['赵峰'] }) })
  await app.showFinalPrompt({ cardId: task.cardId, title: '上一版', task })
  assert.equal(app.promptPreview.value.delivery.firstFrame.url, firstFrame.url)
  assert.equal(app.promptPreview.value.context, '任务记录 · custom-model')
  await app.showFinalPrompt({ cardId: 'b', title: '当前分镜' })
  assert.match(app.promptPreview.value.delivery.pending, /上一段/u)
  assert.equal(app.promptPreview.value.delivery.missingVoices[0], '赵峰')
  assert.equal(app.promptPreview.value.delivery.firstFrame, undefined)
  assert.equal(app.promptPreview.value.pending, false)
  assert.equal(app.submissions.length, 0)
})

test('预览发送保存后的分镜版本，未选模型时仍可预览', async () => {
  const app = controller([], { onSave() { app.episode.cards[0].version = 2 } })
  app.episode.modelConfigId = undefined
  app.episode.modelName = ''
  await app.showFinalPrompt({ cardId: 'a', title: '当前分镜' })
  assert.match(app.calls[0].path, /\/final-prompt$/)
  assert.equal(app.calls[0].body.cardVersion, 2)
  assert.equal(app.calls[0].body.configId, undefined)
  assert.match(app.promptPreview.value.context, /未选择视频模型/u)
})

test('剪贴板被拒绝时保留最终文本和重试状态，再次复制无需重新准备', async () => {
  let denyClipboard = true
  const app = controller([], { clipboardWrite: () => {
    if (denyClipboard) throw new Error('Clipboard denied')
  } })
  await app.showFinalPrompt({ cardId: 'a', title: '当前分镜' })
  await app.copyPromptPreview()
  assert.equal(app.dialog.value, 'prompt-preview')
  assert.equal(app.promptPreview.value.delivery.prompt, '原提示词')
  assert.equal(app.promptPreview.value.error, '')
  assert.equal(app.promptPreview.value.copied, false)
  assert.match(source, /promptPreview\.copied === false \? '可点击复制重试，或选中文本手动复制'/u)
  assert.equal(app.copied.length, 0)

  denyClipboard = false
  await app.copyPromptPreview()
  assert.equal(app.copied[0], app.promptPreview.value.delivery.prompt)
  assert.equal(app.promptPreview.value.copied, true)
  assert.equal(app.promptPreview.value.error, '')
  assert.equal(app.submissions.length, 0)
})

test('等待预览请求期间关闭弹框，忽略迟到的结果', async () => {
  let finish
  let started
  const prepared = new Promise(resolve => { finish = resolve })
  const requested = new Promise(resolve => { started = resolve })
  const app = controller([], { onFinalPrompt: () => { started(); return prepared } })
  const viewing = app.showFinalPrompt({ cardId: 'b', title: '当前分镜' })
  await requested
  assert.equal(app.promptPreview.value.pending, true)
  app.dialog.value = null
  finish(finalDelivery())
  await viewing
  assert.equal(app.dialog.value, null)
  assert.equal(app.promptPreview.value.delivery, null)
  assert.equal(app.copied.length, 0)
})

test('同场换机位的批量任务等待实际成片，另一场可先提交', async () => {
  let finish
  const prior = new Promise(resolve => { finish = resolve })
  const app = controller([], {
    cardIds: ['a', 'b', 'c'], lightingScenes: { a: '院落', b: '院落', c: '大殿' },
    onLookup: path => path.endsWith('/21') ? prior : undefined,
    onSubmit: path => ({ taskId: path.endsWith('/a/video') ? 21 : 22 }),
  })
  const batch = app.requestVideoGeneration(['a', 'b', 'c'])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(app.submissions.map(call => call.path.split('/').at(-2)), ['a', 'c'])
  finish({ status: 'completed', videoUrl: '/static/videos/task-21.mp4' })
  await batch
  assert.equal(app.submissions[2].path.split('/').at(-2), 'b')
})

test('尾帧与多个光线范围独立等待，只跳过手选或移除的来源并保留后段取光', async () => {
  for (const mode of ['off', 'manual']) {
    const results = { a: Promise.withResolvers(), b: Promise.withResolvers(), c: Promise.withResolvers() }
    const ids = ['a', 'b', 'c', 'd'], tasks = new Map(ids.map((id, i) => [id, 21 + i]))
    const app = controller([], {
      cardIds: ids, connections: ['b/c'], lightingScenes: { a: '松林', b: '院落', c: ['松林', '院落'], d: '松林' },
      onLookup: path => results[ids[Number(path.split('/').at(-1)) - 21]].promise,
      onSubmit: path => ({ taskId: tasks.get(path.split('/').at(-2)) }),
    })
    const choice = mode === 'off' ? { mode } : { mode, videoUrl: '/static/videos/source.mp4', seconds: 1 }
    // B's automatic tail is disabled in C, and C's first light range also has
    // an explicit choice. C should still wait for B's second-range light.
    app.episode.cards[2].referenceFrameSettings = { tail: choice, lighting: { 1: choice } }
    const batch = app.requestVideoGeneration(ids)
    const submitted = () => app.submissions.map(call => call.path.split('/').at(-2))
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(submitted(), ['a','b'])
    results.b.resolve({ status: 'completed', videoUrl: '/static/videos/b.mp4' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(submitted(), ['a','b','c'])
    results.c.resolve({ status: 'completed', videoUrl: '/static/videos/c.mp4' })
    await batch
    assert.deepEqual(submitted(), ids)
    results.a.resolve({ status: 'completed', videoUrl: '/static/videos/a.mp4' })
  }
})

test('关闭光线范围仍等待自动尾帧，单独关闭尾帧能直接提交', async () => {
  for (const disableTail of [false, true]) {
    const first = Promise.withResolvers()
    const app = controller([], {
      connections: ['a/b'], lightingScenes: { a: '大堂', b: '大堂' },
      onLookup: () => first.promise, onSubmit: path => ({ taskId: path.endsWith('/a/video') ? 21 : 22 }),
    })
    app.episode.cards[1].referenceFrameSettings = { ...(disableTail && { tail: { mode:'off' } }), lighting: { 1: { mode:'off' } } }
    const batch = app.requestVideoGeneration(['a','b'])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(app.submissions.length, disableTail ? 2 : 1)
    first.resolve({ status: 'completed', videoUrl: '/static/videos/a.mp4' })
    await batch
    assert.equal(app.submissions.length, 2)
  }
})

test('紧邻上一段没有成片时，批量生成不等待更早的同场光线', async () => {
  const earlier = Promise.withResolvers()
  const app = controller([{ id: 'prior', cardId: 'a', cardVersion: 1, status: 'processing', taskId: 21 }], {
    cardIds: ['a', 'b', 'c'],
    lightingScenes: { a: '松林', b: '院落', c: '松林' },
    onLookup: () => earlier.promise,
    onSubmit: () => ({ taskId: 23 }),
  })
  const batch = app.requestVideoGeneration(['c'])
  await new Promise(resolve => setImmediate(resolve))
  const submittedBeforeEarlier = app.submissions.map(call => call.path.split('/').at(-2))
  earlier.resolve({ status: 'completed', videoUrl: '/static/videos/earlier.mp4' })
  await batch

  assert.deepEqual(submittedBeforeEarlier, ['c'])
  assert.ok(!app.calls.some(call => call.method === 'GET' && call.path.endsWith('/video/21')))
})

test('分镜资料导出没有选择模型、没有自动续接时仍取回手选帧', async () => {
  const app = controller([], { onContinuations: () => ({ continuations: {}, lightingRanges: {} }) })
  const card = app.episode.cards[1]
  app.episode.modelConfigId = undefined
  app.episode.modelName = ''
  card.referenceFrameSettings = { tail: { mode: 'manual', videoUrl: '/static/videos/source.mp4', seconds: 1 } }
  await app.deliveryContinuations(app.project, app.episode, [card], app.videoPromptMode.value)
  assert.deepEqual(Array.from(app.calls.at(-1).body.cardIds), ['b'])
  assert.equal(Object.hasOwn(app.calls.at(-1).body, 'configId'), false)
  assert.equal(Object.hasOwn(app.calls.at(-1).body, 'model'), false)
})

test('第一段即梦直接提交时，仅续约后续分镜的排队提示', async () => {
  let heartbeat
  const entered = [Promise.withResolvers(), Promise.withResolvers()]
  const responses = [Promise.withResolvers(), Promise.withResolvers()]
  let index = 0
  const app = controller([], {
    queueTimer: fn => { heartbeat = fn },
    onSubmit: () => {
      const submitting = index++
      entered[submitting].resolve()
      return responses[submitting].promise
    },
  })
  app.episode.modelProvider = 'jimeng'
  app.episode.modelName = 'jimeng-seedance-2.5'
  const submitted = app.requestVideoGeneration(['a', 'b'])
  const latestReservation = () => app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/video-queue')).at(-1)
  await entered[0].promise
  await heartbeat()
  assert.deepEqual([...latestReservation().body.cardIds], ['b'])
  assert.equal(app.submissions.length, 1)
  responses[0].resolve({ taskId: 21 })
  await entered[1].promise
  const renewalCount = app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/video-queue')).length
  await heartbeat()
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/video-queue')).length, renewalCount)
  responses[1].resolve({ taskId: 22 })
  await submitted
  assert.equal(app.submissions.length, 2)
  assert.equal(app.calls.at(-1).method, 'DELETE')
})

test('其他页面占用按稳定分镜ID判断，本页版本变化后仍阻止重复生成', async () => {
  const app = controller([], { remoteActiveIds: ['a'] })
  app.episode.cards[0].version++
  await app.requestVideoGeneration(['a'])
  await app.requestVideoGeneration(['a', 'b'])
  assert.equal(app.calls.length, 0)
  await app.requestVideoGeneration(['b'])
  assert.equal(app.submissions.length, 1)
})

const precedingEpisode = (overrides = {}) => ({
  id: 'previous-episode', number: 1, _loaded: true, tasks: [],
  cards: [{ id: 'previous-last', version: 1, duration: 30, shots: [] }], ...overrides,
})

test('下一集第一段等待上一集末段尾帧，等待状态属于当前集且完成后刷新来源集', async () => {
  const ready = Promise.withResolvers(), lookup = Promise.withResolvers()
  const previous = precedingEpisode({ tasks: [
    { id: 'previous-task', cardId: 'previous-last', cardVersion: 1, status: 'processing', taskId: 61 },
  ] })
  const app = controller([], {
    cardIds: ['a'], previousEpisodes: [previous], connections: ['previous-last/a'],
    onLookup: () => { lookup.resolve(); return ready.promise },
  })
  const generation = app.requestVideoGeneration(['a'])
  await lookup.promise
  assert.equal(app.submissions.length, 0)
  assert.equal(app.videoTailWaiting.value, true)
  assert.equal(app.selectedEpisodeId.value, 'episode')
  ready.resolve({ status: 'completed', videoUrl: '/static/videos/previous-last.mp4' })
  await generation
  assert.equal(app.submissions.length, 1)
  assert.match(app.submissions[0].path, /episodes\/episode\/cards\/a\/video$/u)
  assert.deepEqual(app.refreshes[0], { projectId: 'project', episodeId: previous.id })
  assert.equal(app.videoTailWaiting.value, false)
  assert.equal(app.selectedEpisodeId.value, 'episode')
})

test('跨集同场换机位单独等待光线，手选或关闭后不等待上集任务', async () => {
  for (const mode of [undefined, 'manual', 'off']) {
    const ready = Promise.withResolvers()
    const previous = precedingEpisode({ tasks: [
      { id: 'previous-task', cardId: 'previous-last', cardVersion: 1, status: 'processing', taskId: 61 },
    ] })
    const app = controller([], {
      cardIds: ['a'], previousEpisodes: [previous], lightingScenes: { 'previous-last': '院落', a: '院落' },
      onLookup: () => ready.promise,
    })
    if (mode) app.episode.cards[0].referenceFrameSettings = { lighting: { 1: mode === 'off'
      ? { mode } : { mode, videoUrl: '/static/videos/manual.mp4', seconds: 1 } } }
    const generation = app.requestVideoGeneration(['a'])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(app.submissions.length, mode ? 1 : 0)
    ready.resolve({ status: 'completed', videoUrl: '/static/videos/previous-last.mp4' })
    await generation
    assert.equal(app.submissions.length, 1)
  }
})

test('生成和导出第一段只读加载上一集，保留当前分集选择并带入跨集参考帧', async () => {
  for (const action of ['generate', 'export']) {
    const previous = precedingEpisode({ _loaded: false, cards: [] })
    const app = controller([], {
      cardIds: ['a'], previousEpisodes: [previous], connections: ['previous-last/a'],
      onRefresh(_projectId, episodeId) {
        if (episodeId !== previous.id) return
        Object.assign(previous, precedingEpisode())
        Object.assign(previous.cards[0], { status: 'ready', videoUrl: '/static/videos/previous-last.mp4' })
      },
      onContinuations: () => ({ continuations: { a: { imageUrl: '/static/videos/previous-tail.jpg' } }, lightingRanges: {} }),
    })
    if (action === 'generate') {
      await app.requestVideoGeneration(['a'])
      assert.equal(app.submissions.length, 1)
    } else {
      const result = await app.deliveryContinuations(app.project, app.episode, app.episode.cards, app.videoPromptMode.value)
      assert.equal(result.continuations.a.imageUrl, '/static/videos/previous-tail.jpg')
      assert.deepEqual([...app.calls.find(call => call.path.endsWith('/continuations')).body.cardIds], ['a'])
    }
    assert.deepEqual(app.refreshes[0], { projectId: 'project', episodeId: previous.id })
    assert.equal(app.selectedEpisodeId.value, 'episode')
  }
})

test('上一集末段缺少成片时首段提示明确集号，空上一集不会回溯更早一集', async () => {
  const previous = precedingEpisode()
  const app = controller([], { cardIds: ['a'], previousEpisodes: [previous], connections: ['previous-last/a'] })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.submissions.length, 0)
  assert.match(app.toasts[0], /第 1 段需要第 1 集第 1 段的尾帧/u)

  previous.cards[0].status = 'ready'
  previous.cards[0].videoUrl = '/static/videos/previous-last.mp4'
  const empty = precedingEpisode({ id: 'empty-episode', number: 2, cards: [] })
  const separated = controller([], { cardIds: ['a'], previousEpisodes: [previous, empty], connections: ['previous-last/a'] })
  await separated.requestVideoGeneration(['a'])
  assert.equal(separated.submissions.length, 1)
  assert.ok(!separated.calls.some(call => call.method === 'GET'))
})

test('首段选帧监听上一集所有来源片段的成片、任务和排队变化', () => {
  const start = source.indexOf('const frameEditor = useScriptVideoReferenceFrames(')
  const end = source.indexOf('const pageVisible =', start)
  const previous = precedingEpisode({
    cards: [{ id: 'previous-first', version: 1 }, ...precedingEpisode().cards],
    tasks: [{ id: 'source-task', cardId: 'previous-first', status: 'processing' }],
  })
  const episode = { id: 'episode', cards: [{ id: 'a' }], tasks: [] }
  const project = { id: 'project', episodes: [previous, episode] }
  const sourceActivity = ref({ scope: 'project/episode', episodeId: previous.id, queuedCardIds: [] })
  let revision
  runInNewContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, {
    useScriptVideoReferenceFrames: (_current, sourceRevision) => { revision = sourceRevision },
    episodeOpen: ref(true), stage: ref('production'), selectedCard: ref(episode.cards[0]),
    currentEpisode: ref(episode), currentProject: ref(project), episodeKey: ref('project/episode'),
    previousScriptVideoCard, officialScriptVideoUrl, queuedCardIds: ref([]), referenceSourceActivity: sourceActivity,
    saveProjectNow: () => {},
  })
  const before = revision()
  Object.assign(previous.cards[0], { status: 'ready', videoUrl: '/static/videos/previous-first.mp4' })
  assert.notEqual(revision(), before)
  const rendered = revision()
  previous.tasks[0].status = 'completed'
  assert.notEqual(revision(), rendered)
  const completed = revision()
  sourceActivity.value.queuedCardIds = ['previous-last']
  assert.notEqual(revision(), completed)
  const queued = revision()
  Object.assign(previous.cards[1], { status: 'ready', videoUrl: '/static/videos/previous-last.mp4' })
  assert.notEqual(revision(), queued)
})
