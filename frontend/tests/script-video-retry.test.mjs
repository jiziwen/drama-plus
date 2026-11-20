import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { computed, reactive, ref } from 'vue'
import ts from 'typescript'
import { usesJimengVideo } from '../app/utils/jimengVideo.ts'

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
  onLookup, onSubmit, onFinalPrompt, clipboardWrite, onSave, missingVoices = () => [],
  connections = [], lightingScenes = {}, cardIds = ['a', 'b'],
  jimengApproval,
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
  const value = runInNewContext(controllerSource + '\n;({ requestVideoGeneration, cancelVideoGeneration, confirmVideoRetry, pendingVideoRetry, videoTaskError, showFinalPrompt, copyPromptPreview, promptPreview, batchVideoVoiceWarning, videoVoiceWarningForCard, activeVideoRun })', {
    ref, computed, reactive, dialog, ScriptVideoRequestError, alive: true, AbortController, AbortSignal, requestController: new AbortController(),
    usesJimengVideo, jimengVideoConfirmation: ref({ approve: jimengApproval, cancel() {} }),
    outputMode: ref('internal'), promptReturnFocus: null,
    episodeKey: ref('project/episode'), previewId: () => 'video-request-fixture',
    setTimeout: done => queueMicrotask(done), clearTimeout,
    episodeLock: { owns: (projectId, episodeId) => leaseActive.value && projectId === project.id && episodeId === episode.id },
    getScriptVideoContinuationScene: (previous, next) => connections.includes(`${previous.id}/${next.id}`),
    buildScriptVideoLightingPlan: () => Object.fromEntries(Object.entries(lightingScenes).map(([id, sceneKey]) =>
      [id, [{ sceneKey }]])),
    currentProject: ref(project), currentEpisode: ref(episode), projects: ref([project]), tasks: computed(() => episode.tasks),
    cards: computed(() => episode.cards), assets: computed(() => project.assets),
    saveProjectNow: async () => { await onSave?.() }, installProject: async () => {},
    navigator: { clipboard: { writeText: async text => {
      await clipboardWrite?.(text)
      copied.push(text)
    } } },
    validatePreviewCards: () => ({ ok: true }),
    getScriptVideoMissingVoices: missingVoices,
    buildScriptVideoDelivery: () => ({ voices: [] }),
    toast: { error: message => toasts.push(message), success: () => {}, info: message => toasts.push(message) },
    scriptVideoRequest: async (path, method = 'GET', body) => {
      calls.push({ path, method, body })
      if (method === 'GET' && path === '/projects/project') return project
      if (method === 'GET') {
        return onLookup?.(path, episode) || { status: 'completed', videoUrl: '/static/videos/task-21.mp4' }
      }
      if (path.endsWith('/final-prompt')) return onFinalPrompt?.(body) || finalDelivery()
      if (path.endsWith('/video-cancel')) return { canceled: 1, upstreamUnconfirmed: 0 }
      if (path.endsWith('/video/quote')) return { quote_id: 'script-video-quote', credits: 15, model: body.model }
      return onSubmit?.(path, body, episode) || { taskId: 21 }
    },
  })
  return { ...value, dialog, calls, episode, toasts, copied, leaseActive,
    get submissions() { return calls.filter(call => call.method === 'POST' && !/\/(?:final-prompt|quote|video-cancel)$/.test(call.path)) },
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

test('即梦逐段报价，用户拒绝时取消，确认后带同一报价提交', async () => {
  let approved = false
  const app = controller([], { jimengApproval: async (quote, _label, _replacing, duration) => {
    assert.equal(app.submissions.length, 0)
    assert.equal(quote.credits, 15)
    assert.equal(duration, 18)
    return approved
  } })
  app.episode.modelProvider = 'jimeng'
  app.episode.modelName = 'jimeng-seedance-2.5'
  app.episode.videoDurations = { a: 18 }
  await app.requestVideoGeneration(['a'])
  assert.equal(app.submissions.length, 0)
  approved = true
  await app.requestVideoGeneration(['a'])
  const quotes = app.calls.filter(call => call.path.endsWith('/video/quote'))
  assert.equal(quotes.length, 2)
  assert.equal(app.submissions.length, 1)
  assert.equal(quotes[1].path, `${app.submissions[0].path}/quote`)
  assert.equal(quotes[1].body.duration, 18)
  assert.deepEqual({ ...app.submissions[0].body }, { ...quotes[1].body, jimengQuoteId: 'script-video-quote' })
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

test('即梦报价确认时失去分集占用，取消提交', async () => {
  const app = controller([], { jimengApproval: async () => {
    app.leaseActive.value = false
    return true
  } })
  app.episode.modelProvider = 'jimeng'
  app.episode.modelName = 'jimeng-seedance-2.5'
  await app.requestVideoGeneration(['a'])
  assert.ok(app.calls.some(call => call.path.endsWith('/video/quote')))
  assert.equal(app.submissions.length, 0)
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
  assert.equal(app.submissions.length, 1)
  assert.equal(app.submissions[0].path, '/projects/project/video/17/recover')
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
