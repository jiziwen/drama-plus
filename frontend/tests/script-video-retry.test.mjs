import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { computed, reactive, ref } from 'vue'
import ts from 'typescript'
import { officialScriptVideoUrl } from '../../backend/src/services/script-video-versions.ts'
import { buildScriptVideoDelivery, scriptVideoDeliveryTags } from '../../backend/src/services/script-video-delivery.ts'
import { hasScriptVideoPromptBody, splitScriptVideoPromptStyle } from '../../backend/src/services/script-video-style.ts'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('const taskActions =')
const end = source.indexOf('function checkForAction(', start)
const controllerSource = ts.transpileModule(source.slice(start, end), {
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
  onLookup, onSubmit, onFinalPrompt, onContinuations, clipboardWrite, onSave, onRefresh, missingVoices = () => [],
  connections = [], lightingScenes = {}, cardIds = ['a', 'b'],
  remoteActiveIds = [], queueTimer = setInterval,
} = {}) {
  const calls = []
  const episode = {
    id: 'episode', confirmed: true, outlineConfirmed: true, modelConfigId: 1,
    modelName: 'custom-model', modelMaxDuration: 30, modelMaxAudioReferences: null,
    aspectRatio: '16:9', resolution: '720p', tasks: initialTasks,
    cards: cardIds.map(id => ({ id, version: 1, duration: 30, shots: lightingScenes[id] ? [{}] : [] })),
  }
  const project = { id: 'project', assets: [], episodes: [episode] }
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
  const value = runInNewContext(controllerSource + '\n;({ requestVideoGeneration, cancelVideoGeneration, confirmVideoRetry, pendingVideoRetry, videoTaskError, showFinalPrompt, copyPromptPreview, promptPreview, batchVideoVoiceWarning, videoVoiceWarningForCard, activeVideoRun, activeVideoRequests, deliveryContinuations })', {
    ref, computed, reactive, dialog, activeCardIds: ref(remoteActiveIds), requestActivityRefresh: () => {}, setInterval: queueTimer, clearInterval, ScriptVideoRequestError, alive: true, AbortController, AbortSignal, requestController: new AbortController(),
    officialScriptVideoUrl,
    outputMode: ref('internal'), promptReturnFocus: null,
    episodeKey, previewId: () => 'video-request-fixture',
    setTimeout: done => queueMicrotask(done), clearTimeout,
    episodeLock: { owns: (projectId, episodeId) => leaseActive.value && projectId === selectedProjectId.value && episodeId === selectedEpisodeId.value },
    getScriptVideoContinuationScene: (previous, next) => connections.includes(`${previous.id}/${next.id}`),
    buildScriptVideoLightingPlan: () => Object.fromEntries(Object.entries(lightingScenes).map(([id, scenes]) =>
      [id, (Array.isArray(scenes) ? scenes : [scenes]).map((sceneKey, i) => ({ sceneKey, firstShot: i + 1 }))])),
    currentProject, currentEpisode, projects, tasks: computed(() => currentEpisode.value.tasks),
    cards: computed(() => currentEpisode.value.cards), assets: computed(() => currentProject.value.assets),
    saveProjectNow: async id => { await onSave?.(id) }, refreshProject: async (projectId, episodeId) => { refreshes.push({ projectId, episodeId }); await onRefresh?.(projectId, episodeId) },
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
      if (path.endsWith('/video-cancel')) return { canceled: 1, upstreamUnconfirmed: 0 }
      return onSubmit?.(path, body, episode) || { taskId: 21 }
    },
  })
  return { ...value, dialog, calls, episode, project, toasts, copied, leaseActive, navigate, navigateBack, refreshes,
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

test('批量使用每段自己的出片时长，最终提示词预览复用当前设置', async () => {
  const app = controller()
  app.episode.videoDurations = { a: 12 }
  await app.showFinalPrompt({ cardId: 'a', title: '片段 A' })
  assert.equal(app.calls.find(call => call.path.endsWith('/final-prompt')).body.duration, 12)
  await app.requestVideoGeneration(['a', 'b'])
  assert.deepEqual(app.submissions.map(call => call.body.duration), [12, undefined])
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
  const generation = app.requestVideoGeneration(['a', 'b'])
  await started
  const other = app.navigate(otherProject)
  assert.equal(app.activeVideoRun.value, undefined)
  assert.ok(app.activeVideoRequests.value.has('project/episode'))
  finishFirst({ taskId: 21 })
  await generation
  assert.equal(app.submissions.length, 2)
  assert.ok(app.submissions.every(call => call.path.startsWith('/projects/project/episodes/episode/cards/')))
  assert.ok(app.submissions.every(call => call.body.model === 'custom-model' && call.body.resolution === '720p'))
  assert.ok(app.refreshes.every(call => call.projectId === 'project' && call.episodeId === 'episode'))
  assert.equal(other.episode.tasks.length, 0)
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

test('已出片但保存失败时恢复任务号，不重新提交', async () => {
  const app = controller([failed('delivery', 'a', 'DELIVERY_FAILED', 17)], { missingVoices: () => ['阿离'] })
  await app.requestVideoGeneration(['a'])
  assert.equal(app.dialog.value, null)
  assert.equal(app.submissions.length, 0)
  assert.equal(app.calls.filter(call => call.method === 'POST' && call.path === '/projects/project/video/17/recover').length, 1)
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
  const references = await app.deliveryContinuations(app.project, app.episode, [app.episode.cards[1]])
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
  await app.showFinalPrompt({ cardId: 'b', title: '当前分镜' })
  assert.equal(app.dialog.value, 'prompt-preview')
  assert.equal(app.calls[0].body.cardId, 'b')
  assert.equal(app.calls[0].body.cardVersion, 1)
  assert.equal(app.calls[0].body.model, 'custom-model')
  assert.equal(app.promptPreview.value.delivery.prompt, '原提示词')
  assert.equal(app.copied.length, 0)
  await app.copyPromptPreview()
  assert.equal(app.copied[0], '原提示词')
  await app.showFinalPrompt({ cardId: task.cardId, title: '任务记录', task })
  assert.equal(app.calls[1].body.jobId, task.id)
  assert.equal(app.copied.length, 1)
  assert.match(app.promptPreview.value.delivery.prompt, /^以@图片7作为本段首帧。/u)
  assert.equal(app.promptPreview.value.delivery.images[0].url, images[0].url)
  await app.copyPromptPreview()
  assert.equal(app.copied[1], app.promptPreview.value.delivery.prompt)
  assert.equal(app.promptPreview.value.copied, true)
  assert.equal(app.calls.length, 2)
  assert.equal(app.submissions.length, 0)
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

test('外部交付没有选择模型、没有自动续接时仍取回手选帧', async () => {
  const app = controller([], { onContinuations: () => ({ continuations: {}, lightingRanges: {} }) })
  const card = app.episode.cards[1]
  app.episode.modelConfigId = undefined
  app.episode.modelName = ''
  card.referenceFrameSettings = { tail: { mode: 'manual', videoUrl: '/static/videos/source.mp4', seconds: 1 } }
  await app.deliveryContinuations(app.project, app.episode, [card])
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
