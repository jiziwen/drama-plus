import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import {
  captureScriptVideoScroll,
  readScriptVideoViewPosition,
  restoreScriptVideoScroll,
  restoreScriptVideoStage,
  writeScriptVideoViewPosition,
  type ScriptVideoViewPosition,
} from '../app/utils/scriptVideoViewPosition'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

function inTab<T>(storage: ReturnType<typeof memoryStorage>, callback: () => T) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: { sessionStorage: storage }, configurable: true })
  try { return callback() }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

test('刷新后从同一浏览器标签页恢复项目、分集、片段、输出模式和滚动位置', () => {
  const position: ScriptVideoViewPosition = {
    projectId: 'seven', episodeId: 'ep54', stage: 'production', cardId: 'card2', tab: 'prompt', outputMode: 'external',
    scroll: { prompt: { top: 215, left: 0 }, segments: { top: 0, left: 176 } },
  }
  const storage = memoryStorage()
  inTab(storage, () => writeScriptVideoViewPosition(position))
  assert.deepEqual(inTab(storage, readScriptVideoViewPosition), position)

  const otherTab = memoryStorage()
  assert.equal(inTab(otherTab, readScriptVideoViewPosition), undefined)
  inTab(otherTab, () => writeScriptVideoViewPosition({ projectId: 'different' }))
  assert.deepEqual(inTab(otherTab, readScriptVideoViewPosition), { projectId: 'different' })
  assert.deepEqual(inTab(storage, readScriptVideoViewPosition), position)
})

test('无效和损坏的存储回到可用的选择', () => {
  const storage = memoryStorage()
  storage.setItem('script-video-view-position', '{invalid')
  assert.equal(inTab(storage, readScriptVideoViewPosition), undefined)
  storage.setItem('script-video-view-position', JSON.stringify({
    projectId: 'seven', episodeId: 'ep54', stage: 'video', tab: 'invalid', outputMode: 'pdf', cardId: 123,
  }))
  assert.deepEqual(inTab(storage, readScriptVideoViewPosition), { projectId: 'seven', episodeId: 'ep54' })
  storage.setItem('script-video-view-position', JSON.stringify({ episodeId: 'ep54', stage: 'production' }))
  assert.equal(inTab(storage, readScriptVideoViewPosition), undefined)
  const blocked = () => { throw new Error('Session storage is blocked') }
  inTab({ getItem: blocked, setItem: blocked }, () => {
    assert.doesNotThrow(() => writeScriptVideoViewPosition({ projectId: 'seven' }))
    assert.equal(readScriptVideoViewPosition(), undefined)
  })
})

test('恢复时按当前分集前置条件选择可用的制作步骤', () => {
  const ready = { confirmed: true, outlineConfirmed: true, cardCount: 2, hasStoryboard: true }
  assert.equal(restoreScriptVideoStage(undefined, ready), undefined)
  assert.equal(restoreScriptVideoStage('materials', ready), 'materials')
  assert.equal(restoreScriptVideoStage('production', ready), 'production')
  assert.equal(restoreScriptVideoStage('outline', ready), 'outline')
  assert.equal(restoreScriptVideoStage('outline', { ...ready, confirmed: false }), 'materials')
  assert.equal(restoreScriptVideoStage('production', { ...ready, cardCount: 0 }), 'materials')
  assert.equal(restoreScriptVideoStage('production', { ...ready, outlineConfirmed: false }), 'outline')
  assert.equal(restoreScriptVideoStage('production', { ...ready, hasStoryboard: false }), 'outline')
})

function panels(values: Record<string, { scrollTop: number; scrollLeft: number }>) {
  return { querySelector: (selector: string) => values[selector] ?? null } as unknown as HTMLElement
}

test('独立还原提示词及片段轨道的滚动，并忽略无效坐标', () => {
  const initial = panels({
    '.sv-body': { scrollTop: 0, scrollLeft: 0 },
    'textarea.sv-prompt-input': { scrollTop: 215, scrollLeft: 0 },
    '.vp-card-track': { scrollTop: 0, scrollLeft: 176 },
  })
  const offsets = captureScriptVideoScroll(initial)
  assert.deepEqual(offsets, { prompt: { top: 215, left: 0 }, segments: { top: 0, left: 176 } })
  const target = {
    '.sv-body': { scrollTop: 10, scrollLeft: 11 },
    '.vp-outline-list': { scrollTop: 12, scrollLeft: 13 },
    'textarea.sv-prompt-input': { scrollTop: 0, scrollLeft: 0 },
    '.vp-card-track': { scrollTop: 0, scrollLeft: 0 },
  }
  restoreScriptVideoScroll(panels(target), {
    ...offsets,
    editor: { top: -2, left: -3 },
    outline: { top: Number.NaN, left: 0 },
    script: { top: 99, left: 99 },
  })
  assert.deepEqual(target, {
    '.sv-body': { scrollTop: 0, scrollLeft: 0 },
    '.vp-outline-list': { scrollTop: 12, scrollLeft: 13 },
    'textarea.sv-prompt-input': { scrollTop: 215, scrollLeft: 0 },
    '.vp-card-track': { scrollTop: 0, scrollLeft: 176 },
  })
})

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = page.indexOf('async function selectEpisode(')
const end = page.indexOf('async function leaveEpisode(', start)
const controller = ts.transpileModule(page.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

test('进入分集后按服务端最新片段恢复，已移除的片段保留分集默认选项', async () => {
  const episode = { id: 'ep54', confirmed: true, outlineConfirmed: true }
  async function open(cardId: string) {
    const state = {
      currentProject: { value: { id: 'seven', episodes: [episode] } }, currentEpisode: { value: episode },
      episodeNavigationBusy: { value: false }, selectingEpisode: { value: false },
      episodeAccessNotice: { value: '' }, selectedEpisodeId: { value: '' }, selectedCardId: { value: '' },
      cards: { value: [{ id: 'removed' }] }, hasStoryboard: { value: true }, restoredStage: { value: undefined },
      editorTab: { value: 'shots' }, outputMode: { value: 'internal' }, dialog: { value: null }, assetSearch: { value: '' },
      episodeLock: { owns: () => false, enter: async () => {} }, saveProjectNow: async () => {},
      scriptVideoRequest: async () => [{ id: 'first' }, { id: 'second' }],
      installProject: async (cards: { id: string }[]) => {
        state.cards.value = cards
        state.selectedCardId.value = cards[0]!.id
      },
      restoreScriptVideoStage, restoreEpisodeAIJobs: async () => {},
      toast: { error: (error: string) => assert.fail(error) },
    }
    const selectEpisode = runInNewContext(`${controller}\nselectEpisode`, state)
    await selectEpisode('ep54', { projectId: 'seven', episodeId: 'ep54', cardId, stage: 'production', tab: 'prompt', outputMode: 'external' })
    return [state.selectedEpisodeId.value, state.restoredStage.value, state.selectedCardId.value, state.editorTab.value, state.outputMode.value]
  }
  assert.deepEqual(await open('second'), ['ep54', 'production', 'second', 'prompt', 'external'])
  assert.deepEqual(await open('removed'), ['ep54', 'production', 'first', 'shots', 'external'])
})
