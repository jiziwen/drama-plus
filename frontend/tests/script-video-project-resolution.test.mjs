import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { normalizeScriptVideoResolution, SCRIPT_VIDEO_DEFAULT_RESOLUTIONS } from '../../backend/src/services/script-video-resolution.ts'
import { applyScriptVideoChanges, diffScriptVideoChanges } from '../../backend/src/services/script-video-sync.ts'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('const projectResolutionOptions =')
const end = source.indexOf('const episodeProgressSelection =', start)
assert.ok(start >= 0 && end > start)
const { outputText } = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

function toolbar(project) {
  const currentProject = ref(project)
  const canEditSharedProject = ref(true)
  const controls = runInNewContext(`${outputText}\n;({ projectResolution, projectResolutionOptions })`, {
    computed, currentProject, canEditSharedProject, normalizeScriptVideoResolution, SCRIPT_VIDEO_DEFAULT_RESOLUTIONS,
  })
  return { currentProject, canEditSharedProject, ...controls }
}

test('项目分辨率按项目存储，清除后恢复模型默认并保留分段覆盖', () => {
  const legacy = {
    id: 'first', title: '第一个项目', settings: { combatEnabled: false }, assets: [],
    episodes: [{ id: 'episode-1', cards: [{ id: 'card-1' }], resolution: '480P', videoResolutions: { 'card-1': '1080P' } }],
  }
  const view = toolbar(structuredClone(legacy))
  assert.equal(view.projectResolution.value, '')
  assert.deepEqual(Array.from(view.projectResolutionOptions, option => option.value), ['', ...SCRIPT_VIDEO_DEFAULT_RESOLUTIONS])

  view.projectResolution.value = '720P'
  const changes = diffScriptVideoChanges(legacy, view.currentProject.value)
  assert.deepEqual(changes, [{ target: 'project', fields: { 'settings.defaultVideoResolution': '720P' }, unset: [] }])
  const saved = applyScriptVideoChanges(legacy, changes)
  assert.deepEqual(saved.episodes, legacy.episodes)
  assert.equal(saved.settings.combatEnabled, false)

  view.currentProject.value = { ...legacy, id: 'second' }
  assert.equal(view.projectResolution.value, '')
  view.currentProject.value = structuredClone(saved)
  assert.equal(view.projectResolution.value, '720P')
  view.projectResolution.value = ''
  assert.deepEqual(applyScriptVideoChanges(saved, diffScriptVideoChanges(saved, view.currentProject.value)), legacy)
})

test('无法编辑项目或值无效时保留原分辨率', () => {
  const view = toolbar({ id: 'project', settings: { defaultVideoResolution: '720P' } })
  view.projectResolution.value = 'invalid'
  assert.equal(view.projectResolution.value, '720P')
  view.canEditSharedProject.value = false
  view.projectResolution.value = '1080P'
  assert.equal(view.projectResolution.value, '720P')
})
