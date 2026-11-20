import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as vue from 'vue'
import ts from 'typescript'

const filename = 'ScriptVideoCharacterVoice.vue'
const source = readFileSync(new URL('../app/components/' + filename, import.meta.url), 'utf8')
const { descriptor } = parse(source, {filename})
const compiled = compileScript(descriptor, {id: 'voice', inlineTemplate: true})
const { outputText } = ts.transpileModule(compiled.content, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
})
const exported = {}
runInNewContext(outputText, {exports: exported, require: name => {
  assert.equal(name, 'vue')
  return vue
}})

const character = {id: 'hero', name: '守卫', kind: 'character', image: '/static/uploads/hero.png'}
function render(props = {asset: character}) {
  const events = []
  const emit = (...args) => events.push(args)
  const draw = exported.default.setup(props, {emit, expose() {}})
  const nodes = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    nodes.push(node)
    if (Array.isArray(node.children)) node.children.forEach(visit)
  }
  visit(draw({$emit: emit}, []))
  return {events, nodes, fileInput: nodes.find(n => n.type === 'input'), audio: nodes.find(n => n.type === 'audio')}
}

test('无声音时只发出选中的真实 File，取消选择不会上传，同一文件可再次选择', () => {
  const {nodes, fileInput, audio, events} = render()
  assert.equal(audio, undefined)
  assert.equal(fileInput.props.accept, '.mp3,.wav')
  assert.ok(nodes.some(n => n.type === 'small' && n.children === 'MP3 / WAV，建议用 5–10 秒的清晰人声，最大 15 MB'))
  assert.ok(nodes.some(n => n.type === 'button' && n.children === '上传角色声音'))
  const file = new File(['sample'], '守卫.wav', {type: 'audio/wav'})
  const selected = {files: [file], value: '守卫.wav'}
  fileInput.props.onChange({currentTarget: {files: [], value: ''}})
  fileInput.props.onChange({currentTarget: selected})
  assert.equal(selected.value, '')
  assert.deepEqual(events, [['upload', file]])
})

test('已有角色声音可实际试听、替换和移除，上传时两项操作均禁用', () => {
  const asset = {...character, voiceAudio: {url: '/static/uploads/original.mp3', name: '守卫原声.mp3'}}
  const {events, nodes, fileInput, audio} = render({asset})
  assert.equal(audio.props.src, asset.voiceAudio.url)
  assert.equal(audio.props.preload, 'metadata')
  assert.ok(Object.hasOwn(audio.props, 'controls'))
  assert.ok(nodes.some(n => n.type === 'span' && n.children === asset.voiceAudio.name))
  assert.ok(nodes.some(n => n.type === 'button' && n.children === '替换角色声音'))
  const next = new File(['recording'], '新声音.mp3', {type:'audio/mpeg'})
  fileInput.props.onChange({currentTarget:{files:[next], value:'新声音.mp3'}})
  nodes.find(n => n.type === 'button' && n.children === '移除角色声音').props.onClick()
  assert.deepEqual(events, [['upload', next], ['remove']])
  const busy = render({asset, uploading: true})
  assert.ok(busy.nodes.filter(n => n.type === 'button').every(n => n.props.disabled))
  busy.fileInput.props.onChange({currentTarget:{files:[next], value:''}})
  assert.deepEqual(busy.events, [])
})

test('场景等其他种类不显示角色声音上传入口', () => {
  assert.equal(render({asset: {...character, kind: 'scene'}}).fileInput, undefined)
})

test('默认要求声音参考，可选择模型配音并撤销，已上传声音仍可试听', () => {
  const voiceAudio = {url: '/static/uploads/original.mp3', name: '守卫原声.mp3'}
  const standard = render({asset: {...character, voiceAudio}})
  const checkbox = standard.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(checkbox.props.checked, false)
  checkbox.props.onChange({currentTarget: {checked: true}})
  assert.deepEqual(standard.events, [['model-voice', true]])

  const reference = render({asset: {...character, voiceAudio, voiceMode: 'model'}})
  const selected = reference.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(selected.props.checked, true)
  assert.equal(reference.audio.props.src, voiceAudio.url)
  assert.ok(reference.nodes.some(n => n.type === 'span' && n.children === '已上传的角色声音优先使用。关闭后，有对白或心声时需要参考音频。'))
  selected.props.onChange({currentTarget: {checked: false}})
  assert.deepEqual(reference.events, [['model-voice', false]])

  const disabled = render({asset: {...character, voiceMode: 'model'}, disabled: true})
  const disabledCheckbox = disabled.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(disabledCheckbox.props.disabled, true)
  disabledCheckbox.props.onChange({currentTarget: {checked: false}})
  assert.deepEqual(disabled.events, [])
})
