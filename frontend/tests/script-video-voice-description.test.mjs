import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const start = source.indexOf('async function loadCharacterVoiceDescription(')
const end = source.indexOf('async function generateCharacterVoice(', start)
assert.ok(start >= 0 && end > start)
const script = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

test('saves new role before requesting a description and keeps replies scoped to the originating project', async () => {
  const calls = [], pending = []
  const context = {
    currentProject: {value:{id:'old', assets:[{id:'hero', kind:'character'}]}}, currentEpisode: {value:{id:'episode'}},
    episodeOpen: {value:true}, requireSharedProjectEdit: () => true, alive: true,
    voiceDescriptions: {value:new Map()}, voiceDescriptionKey: (...args) => JSON.stringify(args),
    saveProjectNow: async id => calls.push(['save', id]),
    scriptVideoRequest: (...args) => { calls.push(args); return new Promise(resolve => pending.push(resolve)) }, encodeURIComponent,
  }
  runInNewContext(script, context)
  const oldRequest = context.loadCharacterVoiceDescription('hero')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls[0][0], 'save')
  assert.equal(calls[1][0], '/projects/old/assets/hero/voice-description')
  assert.equal(calls[1][2].episodeId, 'episode')
  context.currentProject.value = {id:'new', assets:[{id:'hero', kind:'character'}]}
  const newRequest = context.loadCharacterVoiceDescription('hero')
  await new Promise(resolve => setImmediate(resolve))
  pending[1]({text:'新角色声音'})
  pending[0]({text:'旧角色声音'})
  await Promise.all([oldRequest, newRequest])
  assert.equal(context.voiceDescriptions.value.get('["old","episode","hero"]').result.text, '旧角色声音')
  assert.equal(context.voiceDescriptions.value.get('["new","episode","hero"]').result.text, '新角色声音')
})
