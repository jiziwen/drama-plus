import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { effectScope, nextTick, ref, watch } from 'vue'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('const batchVideoAssetBindingCheck =')
const end = source.indexOf('const retryVideoVoiceWarning =', start)
assert.ok(start >= 0 && end > start)
const { outputText } = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

function testEditor(t) {
  const scope = effectScope()
  t.after(() => scope.stop())
  const timers = []
  const calls = []
  const episodeKey = ref('project/first')
  const episodeOpen = ref(true)
  const stage = ref('production')
  const assets = ref([{ id: 'scene', name: '初始场景' }])
  const cards = ref(['first', 'running', 'recovering', 'last'].map(id => ({
    id, assetBindingRequirements: [{}], missing: id !== 'first',
  })))
  const videoGenerationTaskByCard = ref(new Map([
    ['running', { status: 'processing' }],
    ['recovering', { recovery: true }],
  ]))
  const check = scope.run(() => runInNewContext(`${outputText}\nbatchVideoAssetBindingCheck`, {
    ref, watch, AbortController, episodeKey, episodeOpen, stage, cards, assets, videoGenerationTaskByCard,
    setTimeout(callback) { timers.push(callback) },
    isVideoDeliveryRecovery: task => task?.recovery,
    scriptVideoAssetBindingIssues(card, projectAssets) {
      calls.push([card.id, projectAssets[0].name])
      return card.missing ? [{}] : []
    },
  }))
  return {
    check, calls, timers, episodeKey, stage, assets, cards, videoGenerationTaskByCard,
    async turn() {
      assert.ok(timers.length > 0)
      timers.shift()()
      await nextTick()
      await nextTick()
    },
  }
}

test('逐段让出主线程，保留原段号并跳过处理中和可恢复的任务', async t => {
  const editor = testEditor(t)
  assert.equal(editor.check.value.checking, true)
  assert.equal(editor.calls.length, 0)

  await editor.turn()
  assert.deepEqual(editor.calls, [['first', '初始场景']])
  assert.equal(editor.check.value.checking, true)

  await editor.turn()
  assert.deepEqual(editor.calls, [['first', '初始场景'], ['last', '初始场景']])
  assert.equal(editor.check.value.checking, false)
  assert.match(editor.check.value.warning, /第 4 段/)
  assert.equal(editor.timers.length, 0)
})

test('数据变化或切集会取消旧检查，离开制作页后停止检查', async t => {
  const editor = testEditor(t)
  await editor.turn()

  editor.assets.value[0].name = '更新场景'
  await nextTick()
  await editor.turn()
  assert.equal(editor.calls.length, 1)
  await editor.turn()
  assert.deepEqual(editor.calls.at(-1), ['first', '更新场景'])

  editor.episodeKey.value = 'project/second'
  editor.cards.value = [{ id: 'second', assetBindingRequirements: [{}] }]
  await nextTick()
  await editor.turn()
  assert.equal(editor.calls.length, 2)
  await editor.turn()
  assert.deepEqual(editor.calls.at(-1), ['second', '更新场景'])
  assert.equal(editor.check.value.checking, false)
  assert.equal(editor.check.value.warning, '')

  editor.videoGenerationTaskByCard.value.set('second', { status: 'failed' })
  await nextTick()
  assert.equal(editor.check.value.checking, true)
  editor.stage.value = 'outline'
  await nextTick()
  await editor.turn()
  assert.equal(editor.calls.length, 3)
  assert.equal(editor.check.value.checking, false)
  assert.equal(editor.timers.length, 0)
})
