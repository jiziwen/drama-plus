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

test('同一片段的来源状态变化时，保留旧参考行直到确认成片消失', async t => {
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
  await nextTick()
  assert.equal(app.frames.value.tail.videoUrl, clip)
  assert.equal(interrupted.signal.aborted, false)

  previous.resolve(rows())
  await refreshing
  await new Promise(resolve => setTimeout(resolve, 560))
  assert.equal(calls.length, 3)
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

test('首段可从上一集早段选尾帧或风格帧，保存对应片段和成片时间', async t => {
  const earlier = { cardId: 'previous-first', videoUrl: '/static/videos/earlier.mp4', sourceLabel: '上一集 · 第 1 段' }
  const state = () => ({
    tail: { kind: 'tail', mode: 'auto', state: 'missing' },
    lighting: [{ kind: 'lighting', startShot: 2, mode: 'auto', state: 'missing' }],
    previousEpisodeSources: [earlier],
  })
  const { app, selected, calls } = await setup(t, () => ({
    ...state(), candidate: { imageUrl: '/static/early.jpg', videoUrl: earlier.videoUrl, seconds: 1.125, sourceCardId: earlier.cardId },
  }), state)
  assert.equal(await app.choose(app.frames.value.tail, 'manual', 1.125, earlier), true)
  assert.deepEqual(calls.find(call => call.body.kind === 'tail').body,
    { kind: 'tail', seconds: 1.125, expectedVideoUrl: earlier.videoUrl, sourceCardId: earlier.cardId })
  assert.equal(await app.choose(app.frames.value.lighting[0], 'manual', 1.125, earlier), true)
  const selection = { mode: 'manual', videoUrl: earlier.videoUrl, seconds: 1.125, sourceCardId: earlier.cardId }
  assert.deepEqual(selected.value.card.referenceFrameSettings, { tail: selection, lighting: { 2: selection } })
})

test('跨集截帧期间所选早段成片发生变化，拒绝保存已失效的旧来源', async t => {
  const earlier = { cardId: 'previous-first', videoUrl: '/static/videos/earlier.mp4', sourceLabel: '上一集 · 第 1 段' }
  const updated = { ...earlier, videoUrl: '/static/videos/earlier-remade.mp4' }
  const reply = Promise.withResolvers()
  let reads = 0
  const { app, selected, revision } = await setup(t, () => reply.promise, () => ({
    ...rows(), previousEpisodeSources: [reads++ ? updated : earlier],
  }))
  const applying = app.choose(app.frames.value.tail, 'manual', 1, earlier)
  revision.value = '2'
  await nextTick()
  reply.resolve({ ...rows(), candidate: { imageUrl: '/static/early.jpg', videoUrl: earlier.videoUrl, seconds: 1, sourceCardId: earlier.cardId } })
  assert.equal(await applying, false)
  assert.match(app.error.value, /来源成片已变化/u)
  assert.equal(selected.value.card.referenceFrameSettings, undefined)
})

test('截帧校验不因其它分集继续同步而拒绝仍可用的来源', async t => {
  const capture = Promise.withResolvers(), recheck = Promise.withResolvers()
  let reads = 0
  const { app, selected, revision } = await setup(t, () => capture.promise, () => ++reads === 2 ? recheck.promise : rows())
  const applying = app.choose(app.frames.value.tail, 'manual', 1.125)
  revision.value = '2'
  await nextTick()
  capture.resolve({ ...rows(), candidate: { imageUrl: '/static/picked.jpg', videoUrl: clip, seconds: 1.125 } })
  await next()
  assert.equal(reads, 2)
  revision.value = '3'
  await nextTick()
  recheck.resolve(rows())
  assert.equal(await applying, true)
  assert.deepEqual(selected.value.card.referenceFrameSettings?.tail, { mode: 'manual', videoUrl: clip, seconds: 1.125 })
})

test('中间片段可从项目任意集为尾帧和风格帧手选来源，保存分集归属', async t => {
  const future = { cardId: 'future-part', sourceEpisodeId: 'episode-99', videoUrl: '/static/videos/future.mp4', sourceLabel: '第99集 · 第2段 · 雨夜' }
  const state = () => ({ ...rows(), projectSources: [future], previousEpisodeSources: [] })
  const { app, selected, calls } = await setup(t, body => ({
    ...state(), candidate: { imageUrl: '/static/picked.jpg', videoUrl: future.videoUrl, seconds: body.seconds,
      sourceCardId: future.cardId, sourceEpisodeId: future.sourceEpisodeId },
  }), state)
  for (const kind of ['tail', 'lighting']) {
    const row = kind === 'tail' ? app.frames.value.tail : app.frames.value.lighting[0]
    assert.equal(await app.choose(row, 'manual', 0.75, future), true)
  }
  const manual = { mode: 'manual', videoUrl: future.videoUrl, seconds: 0.75,
    sourceCardId: future.cardId, sourceEpisodeId: future.sourceEpisodeId }
  assert.deepEqual(selected.value.card.referenceFrameSettings, { tail: manual, lighting: { 2: manual } })
  assert.equal(calls.filter(call => call.body.sourceEpisodeId === future.sourceEpisodeId).length, 2)
})

test('同名片段跨集选帧不能接收另一集的候选，空项目目录不会退回旧来源', async t => {
  const source = { cardId: 'same-part', sourceEpisodeId: 'episode-99', videoUrl: clip, sourceLabel: '第99集 · 第1段' }
  const { app, selected } = await setup(t, () => ({
    ...rows(), projectSources: [source], candidate: { imageUrl: '/static/wrong.jpg', videoUrl: clip, seconds: 1,
      sourceCardId: source.cardId, sourceEpisodeId: 'episode-1' },
  }), () => ({ ...rows(), projectSources: [source] }))
  assert.equal(await app.choose(app.frames.value.tail, 'manual', 1, source), false)
  assert.equal(selected.value.card.referenceFrameSettings, undefined)
  const empty = await setup(t, () => { throw new Error('不应截帧') }, () => ({
    ...rows(), projectSources: [], previousEpisodeSources: [source],
  }))
  assert.equal(await empty.app.choose(empty.app.frames.value.tail, 'manual', 1, source), false)
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
  assert.equal(app.frames.value.tail.videoUrl, clip)

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

function framePlayer(t, frames, calls, choose = async () => true) {
  const component = readFileSync(new URL('../app/components/ScriptVideoReferenceFrames.vue', import.meta.url), 'utf8')
  const body = component.split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import .*$/gm, '')
  const script = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const props = { get frames() { return typeof frames === 'function' ? frames() : frames },
    choose: (...params) => { calls.push(params); return choose(...params) } }
  const scope = effectScope()
  t.after(() => scope.stop())
  return scope.run(() => runInNewContext(script + '\n;({ openPicker, metadata, useFrame, videos, canPick, pickedSource, sourceOptions, changeSource, ready, seconds })', {
    URL, computed, ref, watch, defineProps: () => props, defineEmits: () => () => {},
  }))
}

test('后台慢刷新和连续状态同步期间可保留并保存当前帧', async t => {
  const pending = Promise.withResolvers()
  let reads = 0
  const { app, revision, selected } = await setup(t, body => ({
    ...rows(), candidate: { imageUrl: '/static/picked.jpg', videoUrl: clip, seconds: body.seconds },
  }), () => ++reads === 2 ? pending.promise : rows())
  let applying
  const calls = [], picker = framePlayer(t, () => app.frames.value, calls, (...params) => {
    applying = app.choose(...params)
    return applying
  })
  const row = app.frames.value.tail
  picker.openPicker(row)
  picker.videos.value = [{ currentSrc: 'https://test.invalid' + clip, baseURI: 'https://test.invalid/', duration: 5,
    currentTime: 2.875, pause() {} }]
  const video = picker.videos.value[0]
  picker.metadata({ currentTarget: video }, row)
  await nextTick()

  const refreshing = app.refresh()
  await next()
  for (const update of ['2', '3', '4']) {
    revision.value = update
    await nextTick()
  }
  assert.equal(app.loading.value, false)
  assert.equal(picker.ready.value, true)
  assert.equal(picker.seconds.value, 2.875)
  assert.equal(reads, 2)
  assert.equal(app.frames.value.tail, row)
  picker.useFrame(row)
  assert.deepEqual(calls, [[row, 'manual', 2.875]])
  assert.equal(await applying, true)
  assert.deepEqual(selected.value.card.referenceFrameSettings?.tail, { mode: 'manual', videoUrl: clip, seconds: 2.875 })

  pending.resolve(rows())
  await refreshing
})

test('播放器用当前停帧的时间提交，另一视频元素的时间不会套用到新行', async t => {
  const frames = rows(), calls = []
  const picker = framePlayer(t, frames, calls)
  const row = frames.lighting[0]
  picker.openPicker(row)
  let paused = false
  picker.videos.value = [{ currentSrc: 'https://test.invalid' + clip, baseURI: 'https://test.invalid/', duration: 5,
    currentTime: 0, pause() { paused = true } }]
  const video = picker.videos.value[0]
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

test('拖到30秒片尾时提交精确结束时间，交由后台截取最后显示的一帧', t => {
  const frames = rows(), calls = [], picker = framePlayer(t, frames, calls)
  const row = frames.lighting[0]
  picker.openPicker(row)
  picker.videos.value = [{ currentSrc: 'https://test.invalid' + clip, baseURI: 'https://test.invalid/',
    duration: 30, currentTime: 30, pause() {} }]
  picker.metadata({ currentTarget: picker.videos.value[0] }, row)
  picker.useFrame(row)
  assert.deepEqual(calls, [[row, 'manual', 30]])
})

test('上一集尾段没有成片时仍可打开选帧，切到其他段会重置播放器', t => {
  const first = { cardId: 'previous-1', videoUrl: '/static/videos/previous-1.mp4', sourceLabel: '第 1 段' }
  const third = { cardId: 'previous-3', videoUrl: '/static/videos/previous-3.mp4', sourceLabel: '第 3 段' }
  const row = { kind: 'tail', mode: 'auto', state: 'missing' }
  const calls = []
  const picker = framePlayer(t, { tail: row, lighting: [], previousEpisodeSources: [first, third] }, calls)
  assert.equal(picker.canPick(row), true)
  picker.openPicker(row)
  assert.equal(picker.pickedSource.value, third.videoUrl)
  const video = source => ({ currentSrc: 'https://test.invalid' + source.videoUrl, baseURI: 'https://test.invalid/',
    duration: 5, currentTime: 2, pause() {} })
  const oldVideo = video(third)
  picker.videos.value = [oldVideo]
  const wrappedOld = picker.videos.value[0]
  picker.metadata({ currentTarget: wrappedOld }, row)
  assert.equal(picker.ready.value, true)
  picker.changeSource(picker.sourceOptions.value[0].value)
  assert.equal(picker.pickedSource.value, first.videoUrl)
  assert.equal(picker.ready.value, false)
  assert.equal(picker.seconds.value, undefined)
  picker.useFrame(row)
  assert.deepEqual(calls, [])
  picker.videos.value = [video(first)]
  const newVideo = picker.videos.value[0]
  picker.metadata({ currentTarget: wrappedOld }, row)
  assert.equal(picker.ready.value, false)
  picker.metadata({ currentTarget: newVideo }, row)
  picker.useFrame(row)
  assert.deepEqual(calls, [[row, 'manual', 2, first]])
})

test('项目来源扩大后打开选帧仍先显示原自动来源，不提前修改默认选择', t => {
  const adjacent = { cardId: 'prior', sourceEpisodeId: 'episode-25', videoUrl: clip, sourceLabel: '第25集 · 第1段' }
  const future = { cardId: 'future', sourceEpisodeId: 'episode-99', videoUrl: '/static/videos/future.mp4', sourceLabel: '第99集 · 第3段' }
  const frames = { ...rows(), projectSources: [adjacent, future] }
  const calls = [], picker = framePlayer(t, frames, calls)
  picker.openPicker(frames.tail)
  assert.equal(picker.pickedSource.value, clip)
  assert.equal(picker.sourceOptions.value.length, 2)
  assert.deepEqual(calls, [])
  picker.changeSource(picker.sourceOptions.value[1].value)
  assert.equal(picker.pickedSource.value, future.videoUrl)
  assert.deepEqual(calls, [], '浏览其他分集的成片不应保存设置')
  const video = { currentSrc: 'https://test.invalid' + future.videoUrl, baseURI: 'https://test.invalid/', duration: 5, currentTime: 1, pause() {} }
  picker.videos.value = [video]
  picker.metadata({ currentTarget: picker.videos.value[0] }, frames.tail)
  picker.useFrame(frames.tail)
  assert.deepEqual(calls, [[frames.tail, 'manual', 1, future]])
})

test('自动来源的旧成片不在全项目目录时仍优先播放原来源', t => {
  const future = { cardId: 'future', sourceEpisodeId: 'episode-99', videoUrl: '/static/videos/future.mp4', sourceLabel: '第99集 · 第3段' }
  const frames = { ...rows(), projectSources: [future] }
  const picker = framePlayer(t, frames, [])
  picker.openPicker(frames.tail)
  assert.equal(picker.pickedSource.value, clip)
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
