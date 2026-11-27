import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { AICOST_VIDEO_RATIOS, AICOST_VIDEO_RESOLUTIONS, aicostVideoModelCapabilities } from '../../backend/src/services/aicost-video-models'
import { jimengVideoModel } from '../../backend/src/services/jimeng-video-models'
import { LIBTV_VIDEO_RATIOS, libtvVideoModel } from '../../backend/src/services/libtv-video-models'
import { seedanceModelLimits } from '../../backend/src/services/seedance-models'
import { usesJimengVideo } from '../app/utils/jimengVideo'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const slice = (from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)))
const setup = ts.transpileModule([
  slice('let nextPreviewId', 'const loadingProjects'),
  'const currentEpisode = ref(makeEpisode("新分集", 1))',
  'const videoSelectionPending = ref(false)',
  slice('const videoModel =', 'const videoDuration ='),
  slice('function setVideoModel(', 'function beginTextRun('),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function editor() {
  const state = runInNewContext(setup + '\n;({ currentEpisode, videoModel, resolution, setVideoModel })', {
    computed, ref, usesJimengVideo, jimengVideoModel, libtvVideoModel, seedanceModelLimits,
    aicostVideoModelCapabilities, AICOST_VIDEO_RATIOS, AICOST_VIDEO_RESOLUTIONS, LIBTV_VIDEO_RATIOS,
  })
  // The picker first updates the episode's model key, then emits the selected model's capabilities.
  function select(model: string, provider: string, configId = 1) {
    const key = `config:${configId}:${model}`
    state.videoModel.value = key
    state.setVideoModel({ key, model, provider, configId, label: model, minDuration: 4, maxDuration: 30,
      wholeSeconds: true, maxAudioReferences: 10, maxAudioDuration: 15 })
  }
  return { ...state, select }
}

test('新分集及切换至支持480P的新模型默认480P，重复加载同一模型保留已选清晰度', () => {
  const view = editor()
  assert.equal(view.currentEpisode.value.resolution, '480P')
  view.select('doubao-seedance-2-5', 'volcengine')
  for (const saved of ['720P', '1080P', '720p']) {
    view.currentEpisode.value.resolution = saved
    view.select('doubao-seedance-2-5', 'volcengine')
    assert.equal(view.currentEpisode.value.resolution, saved)
    assert.equal(view.resolution.value, saved.toUpperCase())
  }
  view.select('doubao-seedance-2-5-flash', 'volcengine')
  assert.equal(view.resolution.value, '480P')
})

test('不支持480P的模型采用支持清单的第一项，已存的不兼容选项也回退为合法值', () => {
  const view = editor()
  view.select('seedance2.5-ae', 'aicost')
  assert.equal(view.resolution.value, '720P')
  view.select('minimax-h3', 'aicost')
  assert.equal(view.resolution.value, '1440P')
  view.currentEpisode.value.resolution = '1080P'
  view.select('minimax-h3', 'aicost')
  assert.equal(view.resolution.value, '1440P')
})

test('跟随全局默认缓存生效模型但不固定分集模型键', () => {
  const view = editor()
  view.setVideoModel({ key: '', model: 'doubao-seedance-2-5', provider: 'volcengine', configId: 12,
    label: '全局', minDuration: 4, maxDuration: 30, wholeSeconds: true, maxAudioReferences: 10, maxAudioDuration: 15 })
  assert.equal(view.videoModel.value, '')
  assert.equal(view.currentEpisode.value.modelConfigId, 12)
  assert.equal(view.currentEpisode.value.modelName, 'doubao-seedance-2-5')
  assert.equal(view.resolution.value, '480P')
})
