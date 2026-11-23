import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { applyScriptVideoChanges, diffScriptVideoChanges } from '../../backend/src/services/script-video-sync'
import { mergeScriptVideoProject } from '../app/utils/scriptVideoStateMerge'
import { ScriptVideoRequestError } from '../app/utils/scriptVideoClient'

const file = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const page = parse(file).descriptor.scriptSetup!.content
const section = page.slice(page.indexOf('function copy<T>'), page.indexOf('async function saveProjectNow('))
const script = ts.transpileModule(section, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const summary = (revision: number, title = '七天') => ({
  id: 'p', title, revision, assets: [], episodes: [
    { id: 'e1', title: '第一集', revision }, { id: 'e2', title: '第二集', revision },
  ],
})
const episode = (script: string) => ({ id: 'e1', title: '第一集', script, cards: [], tasks: [] })

function editor() {
  const projects: any[] = [], disk: any[] = [], writers = new Map(), serverSnapshots = new Map()
  const online = { onLine: true }
  let handle: (...args: any[]) => any = () => { throw new Error('unexpected request') }
  const view = runInNewContext(script + '\n;({materialize,acceptProject,refreshProject,writeStatus,syncProject})', {
    projects: { value: projects }, serverSnapshots, writers, diskQueues: new Map(), sharedLoaded: new Map(),
    locallySaved: { value: new Set() }, pendingEdits: { value: new Set() }, saveErrors: { value: {} },
    applyScriptVideoChanges, diffScriptVideoChanges, mergeScriptVideoProject, ScriptVideoRequestError, AbortSignal,
    selectedProjectId: { value: 'p' }, selectedEpisodeId: { value: 'e1' }, previewId: () => 'test-client',
    canSend: true, alive: true, navigator: online, draftAccount: 'admin', tabId: 'tab-A',
    placeholderEpisode: { script: '', cards: [], tasks: [] },
    loadStylePresets: async () => {},
    scriptVideoRequest: (...args: any[]) => handle(...args),
    writeScriptVideoDraft: async (_account: string, _tab: string, _id: string, row?: unknown) => { disk.push(row) },
  })
  return { view, projects, disk, online, writers, serverSnapshots,
    request(fn: typeof handle) { handle = fn },
    load() { view.acceptProject(view.materialize(summary(1), [episode('原稿')])) },
  }
}

test('离线编辑写入本机，恢复后仅重放同序号字段修改，保存中继续输入另发一批', async () => {
  const app = editor()
  app.load()
  const local = app.projects[0], initial = clone(local)
  local.episodes[0].script = '离线改稿'
  app.online.onLine = false
  await assert.rejects(app.view.syncProject('p'), /已保存到本机/)
  const draft = app.disk.at(-1)
  assert.equal(draft.sending.sequence, 1)
  assert.equal(draft.account, 'admin')
  assert.equal(draft.tabId, 'tab-A')
  assert.deepEqual(clone(draft.sending.changes.map((change: any) => [change.id, change.fields])), [['e1', { script: '离线改稿' }]])

  // Restore the same persisted row as a page reload, then simulate a lost acknowledgement.
  const reopened = editor(), routes: string[] = [], requests: any[] = []
  reopened.projects.push(clone(draft.local))
  reopened.serverSnapshots.set('p', clone(draft.base))
  reopened.writers.set('p', { clientId: draft.clientId, sequence: draft.sequence, sending: clone(draft.sending) })
  let server = initial, attempt = 0
  reopened.request((path, method, body) => {
    routes.push(method + ' ' + path)
    requests.push(clone(body))
    if (++attempt === 1) {
      server = applyScriptVideoChanges(server, body.changes)
      throw new TypeError('disconnected after server commit')
    }
    if (attempt === 2) {
      reopened.projects[0].episodes[0].script = '继续编辑'
      server.title = '其他页面的项目名'
    }
    if (attempt > 2) server = applyScriptVideoChanges(server, body.changes)
    return Promise.resolve({ project: summary(body.sequence + 1, server.title), episodes: [server.episodes[0]],
      sequence: body.sequence, revision: body.sequence + 1 })
  })
  await assert.rejects(reopened.view.syncProject('p'), /disconnected/)
  await reopened.view.syncProject('p')
  assert.deepEqual(requests[0], requests[1])
  assert.deepEqual(requests.map(req => req.sequence), [1, 1, 2])
  assert.equal(routes.every(path => path === 'PATCH /projects/p/changes'), true)
  assert.equal(server.episodes[0].script, '继续编辑')
  assert.equal(reopened.projects[0].title, '其他页面的项目名')
  assert.equal(reopened.projects[0].episodes[1]._loaded, false)
  assert.equal(reopened.disk.at(-1), undefined)
  assert.equal(reopened.view.writeStatus('p'), false)
})

test('分集正文和共享目录独立按版本更新，迟到的旧响应不能使当前正文回退', async () => {
  const app = editor()
  app.load()
  app.request(async () => ({ episode: episode('最新正文'), revision: 7, episodeRevision: 7 }))
  await app.view.refreshProject('p', 'e1', undefined, false)
  app.request(async () => summary(6, '共享新标题'))
  await app.view.refreshProject('p')
  assert.equal(app.projects[0].title, '共享新标题')
  assert.equal(app.projects[0].episodes[0].script, '最新正文')
  assert.equal(app.projects[0].revision, 7)
  app.request(async () => ({ episode: episode('旧正文'), revision: 5, episodeRevision: 5 }))
  await app.view.refreshProject('p', 'e1', undefined, false)
  assert.equal(app.projects[0].episodes[0].script, '最新正文')
  assert.equal(app.projects[0].episodes[1]._loaded, false)
  assert.equal(app.view.writeStatus('p'), false)
})

test('视频提示词保存中撤回时，轮询先读到已提交稿也会保留用户最后一次编辑', async () => {
  const app = editor(), started = Promise.withResolvers<void>(), ack = Promise.withResolvers<void>()
  const serverEpisode = { ...episode('正文'), cards: [{ id: 'card', prompt: '原提示词', shots: [] }] }
  app.view.acceptProject(app.view.materialize(summary(1), [serverEpisode]))
  const local = app.projects[0]
  const card = () => local.episodes[0].cards[0]
  let server = clone(local), revision = 1, title = '七天', readBeforeWrite = false
  const requests: any[] = []
  app.request(async (path, method, body) => {
    if (method === 'GET') {
      if (path.includes('view=summary')) return summary(revision, title)
      if (readBeforeWrite) return { episode: serverEpisode, revision: 1, episodeRevision: 1 }
      return { episode: clone(server.episodes[0]), revision, episodeRevision: revision }
    }
    requests.push(clone(body.changes))
    server = applyScriptVideoChanges(server, body.changes)
    revision++
    const response = { project: summary(revision, title), episodes: [clone(server.episodes[0])], sequence: body.sequence, revision }
    if (body.sequence === 1) {
      started.resolve()
      await ack.promise
    }
    return response
  })
  card().prompt = '暂存修改'
  const writing = app.view.syncProject('p')
  await started.promise
  try {
    // A read already in flight can return the state from before the write.
    readBeforeWrite = true
    await app.view.refreshProject('p', 'e1', undefined, false)
    assert.equal(card().prompt, '暂存修改')
    readBeforeWrite = false

    card().prompt = '原提示词'
    title = '其他页面的新项目名'
    await app.view.refreshProject('p', 'e1')
    assert.equal(card().prompt, '原提示词')
    assert.equal(local.title, title)
    title = '其他页面的第二次更名'
    revision++
    await app.view.refreshProject('p', 'e1')
    assert.equal(card().prompt, '原提示词')
    assert.equal(local.title, title)
  } finally {
    ack.resolve()
    await writing
  }
  assert.equal(server.episodes[0].cards[0].prompt, '原提示词')
  assert.deepEqual(requests.map(changes => changes.map((change: any) => [change.target, change.fields])), [
    [['card', { prompt: '暂存修改' }]],
    [['card', { prompt: '原提示词' }]],
  ])
  assert.equal(app.view.writeStatus('p'), false)
})
