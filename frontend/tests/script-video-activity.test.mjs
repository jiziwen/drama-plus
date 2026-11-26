import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ref } from 'vue'
import ts from 'typescript'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('let requestActivityRefresh:')
const end = source.indexOf("watch(() => pageVisible.value && (dialog.value === 'project' || dialog.value === 'style')", start)
const poll = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

test('分集活动轮询保留有效状态并在收到无效响应后继续同步', async () => {
  const activity = { revision: 1, episodeRevision: 1, jobs: [], activeCardIds: ['active'], queuedCardIds: ['queued'] }
  const responses = [
    activity,
    { message: '服务返回了无法识别的结果' },
    { ...activity, activeCardIds: {} },
    { ...activity, queuedCardIds: {} },
    { ...activity, revision: 2, activeCardIds: ['next'], queuedCardIds: undefined },
  ]
  const sharedActivity = ref()
  const refreshes = []
  const timers = new Set()
  const episodeKey = ref('project/episode')
  let cleanup
  runInNewContext(poll, {
    AbortController, AbortSignal, sharedActivity, episodeKey,
    pageVisible: ref(true), episodeOpen: ref(true),
    currentProject: ref({ id: 'project' }),
    currentEpisode: ref({ id: 'episode', _episodeRevision: 1 }),
    sharedLoaded: new Map([['project', 1]]),
    stage: ref('materials'),
    watch: (scope, callback) => callback(scope(), undefined, value => { cleanup = value }),
    scriptVideoRequest: async () => responses.shift(),
    refreshProject: async (projectId, episodeId) => { refreshes.push({ projectId, episodeId }) },
    setTimeout: callback => { timers.add(callback); return callback },
    clearTimeout: callback => timers.delete(callback),
  })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const nextPoll = async () => {
    assert.equal(timers.size, 1)
    const [callback] = timers
    timers.delete(callback)
    callback()
    await flush()
  }

  await flush()
  const lastValid = sharedActivity.value
  assert.ok(lastValid.activeCardIds.includes('active'))
  assert.ok(lastValid.queuedCardIds.includes('queued'))
  for (let i = 0; i < 3; i++) {
    await nextPoll()
    assert.equal(sharedActivity.value, lastValid)
    assert.deepEqual(refreshes, [])
  }
  await nextPoll()
  assert.ok(sharedActivity.value.activeCardIds.includes('next'))
  assert.equal(sharedActivity.value.queuedCardIds.length, 0)
  assert.deepEqual(refreshes, [{ projectId: 'project', episodeId: undefined }])
  cleanup()
  assert.equal(timers.size, 0)
})
