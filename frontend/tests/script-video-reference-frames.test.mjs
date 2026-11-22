import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { useScriptVideoReferenceFrames } from '../app/composables/useScriptVideoReferenceFrames.ts'

const clip = '/static/videos/source.mp4'
const next = () => new Promise(resolve => setImmediate(resolve))
const rows = () => ({
  tail: { kind: 'tail', mode: 'auto', state: 'ready', videoUrl: clip, imageUrl: '/static/tail.jpg' },
  lighting: [{ kind: 'lighting', startShot: 2, endShot: 3, sceneName: '院落', mode: 'auto', state: 'ready', videoUrl: clip, imageUrl: '/static/light.jpg' }],
})

async function setup(t, candidate, read = rows) {
  const scope = effectScope(), selected = ref({ projectId: 'p', episodeId: 'e', card: { id: 'b' } })
  const revision = ref('1'), calls = [], saved = []
  t.after(() => scope.stop())
  const app = scope.run(() => useScriptVideoReferenceFrames(() => selected.value, () => revision.value,
    async () => { saved.push(JSON.stringify(selected.value.card.referenceFrameSettings)) },
    async (path, body, signal) => {
      calls.push({ path, body, signal })
      return body.kind ? candidate(body) : read()
    }))
  await next()
  return { app, selected, revision, calls, saved }
}

test('定位时准备一次，重复相同上游状态不额外请求；切卡或上一段出片后重新读取', async t => {
  const { app, calls, revision, selected } = await setup(t)
  assert.equal(app.frames.value.tail.videoUrl, clip)
  assert.equal(calls.length, 1)
  selected.value = { ...selected.value, card: { id: 'other' } }
  await next()
  assert.equal(calls.length, 2)
  assert.match(calls.at(-1).path, /cards\/other\/reference-frames$/u)
  revision.value = '2'
  await nextTick()
  revision.value = '3'
  await new Promise(resolve => setTimeout(resolve, 560))
  assert.equal(calls.length, 3)
})

test('同一片段的上一段成片消失时，立即清掉参考行并忽略迟到的旧读取', async t => {
  const previous = Promise.withResolvers()
  const empty = { tail: { kind: 'tail', mode: 'auto', state: 'missing' }, lighting: [] }
  let reads = 0
  const { app, calls, revision } = await setup(t, undefined, () => {
    reads++
    return reads === 1 ? rows() : reads === 2 ? previous.promise : empty
  })
  const refreshing = app.refresh()
  await next()
  const interrupted = calls.at(-1)
  assert.equal(app.frames.value.tail.videoUrl, clip)
  revision.value = '2'
  assert.equal(app.frames.value, undefined)
  assert.equal(interrupted.signal.aborted, true)

  previous.resolve(rows())
  await refreshing
  assert.equal(app.frames.value, undefined)
  await app.refresh()
  assert.deepEqual(app.frames.value, empty)
})

test('仅保存服务端截取成功的正确视频时间，保留并发更新的其它行，恢复最后一项时清理设置', async t => {
  const reply = Promise.withResolvers()
  const { app, selected, calls, saved } = await setup(t, () => reply.promise)
  const row = app.frames.value.lighting[0]
  const applying = app.choose(row, 'manual', 1.23456)
  assert.equal(selected.value.card.referenceFrameSettings, undefined)
  assert.deepEqual(calls.at(-1).body, { kind: 'lighting', startShot: 2, seconds: 1.23456, expectedVideoUrl: clip })
  selected.value.card.referenceFrameSettings = { tail: { mode: 'off' } }
  reply.resolve({ ...rows(), candidate: { imageUrl: '/static/picked.jpg', videoUrl: clip, seconds: 1.235 } })
  assert.equal(await applying, true)
  assert.deepEqual(selected.value.card.referenceFrameSettings, { tail: { mode: 'off' }, lighting: { 2: { mode: 'manual', videoUrl: clip, seconds: 1.235 } } })
  assert.match(saved.at(-1), /1\.235/u)
  await app.choose(app.frames.value.lighting[0], 'off')
  assert.deepEqual(selected.value.card.referenceFrameSettings.lighting, { 2: { mode: 'off' } })
  await app.choose(app.frames.value.lighting[0], 'auto')
  assert.deepEqual(selected.value.card.referenceFrameSettings, { tail: { mode: 'off' } })
  await app.choose(app.frames.value.tail, 'auto')
  assert.equal(Object.hasOwn(selected.value.card, 'referenceFrameSettings'), false)
})

test('截帧出错或返回另一条视频时不改参考设置，错误可见', async t => {
  for (const candidate of [
    () => { throw new Error('无法截帧') },
    () => ({ ...rows(), candidate: { imageUrl: '/static/other.jpg', videoUrl: '/static/videos/other.mp4', seconds: 2 } }),
  ]) {
    const { app, selected } = await setup(t, candidate)
    assert.equal(await app.choose(app.frames.value.tail, 'manual', 2), false)
    assert.ok(app.error.value)
    assert.equal(selected.value.card.referenceFrameSettings, undefined)
  }
})

test('截帧期间上一段视频失效，保留错误并刷新成空槽', async t => {
  const pending = Promise.withResolvers()
  const empty = { tail: { kind: 'tail', mode: 'auto', state: 'missing' }, lighting: [] }
  let reads = 0
  const { app, selected, revision, saved } = await setup(t, () => pending.promise, () => reads++ ? empty : rows())
  const initialSaves = [...saved]
  const applying = app.choose(app.frames.value.tail, 'manual', 1)
  revision.value = '2'
  await nextTick()
  assert.equal(app.frames.value, undefined)

  pending.reject(new Error('来源成片已更新'))
  assert.equal(await applying, false)
  assert.equal(selected.value.card.referenceFrameSettings, undefined)
  assert.deepEqual(saved, initialSaves)
  assert.match(app.error.value, /来源成片已更新/u)
  assert.deepEqual(app.frames.value, empty)
})

test('截帧中切换片段，迟到的结果与原片段按钮无法修改新片段', async t => {
  const reply = Promise.withResolvers()
  const { app, selected, calls } = await setup(t, () => reply.promise)
  const oldCard = selected.value.card, oldRow = app.frames.value.tail
  const applying = app.choose(oldRow, 'manual', 3)
  const capture = calls.at(-1)
  selected.value = { projectId: 'p', episodeId: 'other', card: { id: 'c' } }
  await next()
  assert.equal(capture.signal.aborted, true)
  reply.resolve({ ...rows(), candidate: { imageUrl: '/static/old.jpg', videoUrl: clip, seconds: 3 } })
  assert.equal(await applying, false)
  assert.equal(await app.choose(oldRow, 'off'), false)
  assert.equal(oldCard.referenceFrameSettings, undefined)
  assert.equal(selected.value.card.referenceFrameSettings, undefined)
})

test('播放器用当前停帧的时间提交，另一视频元素的时间不会套用到新行', async t => {
  const component = readFileSync(new URL('../app/components/ScriptVideoReferenceFrames.vue', import.meta.url), 'utf8')
  const body = component.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*$/gm, '')
  const script = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const props = { frames: rows(), choose: async (...params) => { calls.push(params); return true } }
  const calls = [], scope = effectScope()
  t.after(() => scope.stop())
  const picker = scope.run(() => runInNewContext(script + '\n;({ openPicker, metadata, useFrame, videos })', {
    URL, computed, ref, watch, defineProps: () => props, defineEmits: () => () => {},
  }))
  const row = props.frames.lighting[0]
  picker.openPicker(row)
  let paused = false
  const video = { currentSrc: 'https://test.invalid' + clip, baseURI: 'https://test.invalid/', duration: 5,
    currentTime: 0, pause() { paused = true } }
  picker.videos.value = [video]
  picker.metadata({ currentTarget: video }, row)
  video.currentTime = 2.875
  video.currentSrc = 'https://test.invalid/static/videos/other.mp4'
  picker.useFrame(row)
  assert.deepEqual(calls, [])
  video.currentSrc = 'https://test.invalid' + clip
  picker.useFrame(row)
  assert.deepEqual(calls, [[row, 'manual', 2.875]])
  assert.equal(paused, true)
})

test('应用旧的AI正文或历史文本时沿用当前片段的参考帧设置', () => {
  const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
  const body = page.slice(page.indexOf('function updateCard('), page.indexOf('function openBindingDialog('))
  const script = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const current = { tail: { mode: 'off' } }, stale = { lighting: { 1: { mode: 'off' } } }
  for (const setting of [undefined, current]) {
    const currentEpisode = ref({ cards: [{ id: 'b', version: 1, referenceFrameSettings: setting }] })
    const apply = runInNewContext(script + '\nupdateCard', { currentEpisode, stage: ref('production') })
    apply({ id: 'b', prompt: '新正文', referenceFrameSettings: stale })
    assert.equal(currentEpisode.value.cards[0].prompt, '新正文')
    assert.deepEqual(currentEpisode.value.cards[0].referenceFrameSettings, setting)
  }
})
