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
  return {...vue, useId: () => 'test-id'}
}})

const character = {id: 'hero', name: '守卫', kind: 'character', image: '/static/uploads/hero.png'}
function render(props = {asset: character}) {
  const events = []
  const emit = (...args) => events.push(args)
  const draw = exported.default.setup(props, {emit, expose() {}})
  function redraw() {
    const nodes = []
    function visit(node) {
      if (!node || typeof node !== 'object') return
      nodes.push(node)
      if (Array.isArray(node.children)) node.children.forEach(visit)
    }
    visit(draw({$emit: emit}, []))
    return nodes
  }
  const nodes = redraw()
  return {events, nodes, redraw, fileInput: nodes.find(n => n.type === 'input'), audio: nodes.find(n => n.type === 'audio')}
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

test('角色声音显示缺少 Mini 配置，启用后默认选择并提交该服务', async () => {
  const events = []
  const option = { key: '7/jimeng-seedance-2.0-mini', label: '即梦积分', configId: 7, model: 'jimeng-seedance-2.0-mini', resolution: '720p' }
  const low = { key: '8/libtv-mini', label: 'LibTV', configId: 8, model: 'libtv-mini', resolution: '480p' }
  const props = vue.reactive({ asset: character, generationOptions: [] })
  const draw = exported.default.setup(props, {emit: (...args) => events.push(args), expose() {}})
  function nodes() {
    const result = []
    function visit(node) { if (!node || typeof node !== 'object') return; result.push(node); if (Array.isArray(node.children)) node.children.forEach(visit) }
    visit(draw({$emit: (...args) => events.push(args)}, []))
    return result
  }
  nodes().find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  let current = nodes()
  assert.equal(current.find(n => n.type === 'select').props.disabled, true)
  assert.ok(current.some(n => n.type === 'option' && n.children === '暂无可用的视频服务'))
  props.generationOptions = [option]
  await vue.nextTick()
  current = nodes()
  assert.equal(current.find(n => n.type === 'select').props.disabled, false)
  assert.equal(current.find(n => n.type === 'button' && n.children === '开始生成').props.disabled, true)
  const fields = current.filter(n => n.type === 'textarea')
  fields[0].props['onUpdate:modelValue']('温暖的青年女声')
  fields[1].props['onUpdate:modelValue']('你好，我来了。')
  current = nodes()
  assert.equal(current.find(n => n.type === 'button' && n.children === '开始生成').props.disabled, false)
  assert.ok(current.some(n => n.type === 'option' && n.children === '即梦积分 · 720p'))
  assert.ok(current.some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、720p')))
  current.find(n => n.type === 'button' && n.children === '开始生成').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['open-description'], ['generate', {configId: 7, model: option.model, description: '温暖的青年女声', dialogue: '你好，我来了。'}]])
  props.generationOptions = [low, option]
  await vue.nextTick()
  current = nodes()
  assert.ok(current.some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、720p')), '刷新后保留原有选择')
  current.find(n => n.type === 'select').props['onUpdate:modelValue'](low.key)
  current = nodes()
  assert.ok(current.some(n => n.type === 'option' && n.children === 'LibTV · 480p'))
  assert.ok(current.some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、480p')))
  const busy = render({asset: character, generating: true})
  assert.ok(busy.nodes.filter(n => n.type === 'button').every(n => n.props.disabled))
})

test('使用默认试音台词，异步描述不会覆盖用户输入', async () => {
  const events = []
  const option = { key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p' }
  const props = vue.reactive({asset: character, generationOptions: [option], descriptionSuggestion: undefined, descriptionLoading: true})
  const draw = exported.default.setup(props, {emit: (...args) => events.push(args), expose() {}})
  function nodes() {
    const result = []
    function visit(node) { if (!node || typeof node !== 'object') return; result.push(node); if (Array.isArray(node.children)) node.children.forEach(visit) }
    visit(draw({$emit: (...args) => events.push(args)}, []))
    return result
  }
  nodes().find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  const field = nodes().filter(n => n.type === 'textarea')[0]
  field.props['onUpdate:modelValue']('我手写的声音')
  field.props.onInput()
  props.descriptionSuggestion = { text: '迟到的建议', sourceLabel: '角色资料' }
  props.descriptionLoading = false
  await vue.nextTick()
  nodes().find(n => n.type === 'button' && n.children === '开始生成').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['open-description'], ['generate', {
    configId: 7, model: 'jimeng', description: '我手写的声音', dialogue: '这也不会那也不会，你到底是怎么修炼到现在的。',
  }]])
})

test('自动声音描述显示来源且可编辑', async () => {
  const props = vue.reactive({asset: character, descriptionSuggestion: undefined})
  const draw = exported.default.setup(props, {emit() {}, expose() {}})
  function nodes() {
    const result = []
    function visit(node) { if (!node || typeof node !== 'object') return; result.push(node); if (Array.isArray(node.children)) node.children.forEach(visit) }
    visit(draw({$emit() {}}, []))
    return result
  }
  nodes().find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  props.descriptionSuggestion = {text: ''}
  await vue.nextTick()
  assert.ok(nodes().some(n => n.type === 'small' && n.children === '剧本里的声音线索不足，请手动填写。'))
  props.descriptionSuggestion = {text: '声音清亮', sourceLabel: '人物介绍'}
  await vue.nextTick()
  assert.ok(nodes().some(n => n.type === 'small' && n.children === '来源：人物介绍'))
})

test('失败时显示原因，保留试音输入并允许重新生成', async () => {
  const option = {key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p'}
  const props = vue.reactive({asset: character, generating: false, generationError: '', generationOptions: [option]})
  const {nodes, redraw, events} = render(props)
  nodes.find(node => node.type === 'button' && node.children === '生成角色声音').props.onClick()
  const [description, dialogue] = redraw().filter(node => node.type === 'textarea')
  description.props['onUpdate:modelValue']('沉稳的中年男声')
  dialogue.props['onUpdate:modelValue']('来者何人？')

  props.generating = true
  props.generationError = '即梦：生成视频版权校验未通过（20115）'
  await vue.nextTick()
  assert.equal(redraw().some(node => node.props?.role === 'alert'), false)
  props.generating = false
  await vue.nextTick()
  const failed = redraw()
  const banner = failed.find(node => node.props?.role === 'alert')
  assert.ok(banner.children.some(node => node.children === '角色声音生成失败'))
  assert.ok(banner.children.some(node => node.children === props.generationError))
  const retry = failed.find(node => node.type === 'button' && node.children === '重新生成')
  assert.equal(retry.props.disabled, false)
  retry.props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(events.at(-1))), ['generate', {
    configId: 7, model: option.model, description: '沉稳的中年男声', dialogue: '来者何人？',
  }])
})

test('生成视频可展开播放，视频更换后自动收起，原音频仍可试听', async () => {
  const props = vue.reactive({ asset: {...character, voiceAudio: {url: '/static/uploads/voice.mp3', name: 'voice.mp3'}}, videoUrl: '/static/videos/task-10.mp4' })
  const draw = exported.default.setup(props, {emit() {}, expose() {}})
  function nodes() {
    const result = []
    function visit(node) { if (!node || typeof node !== 'object') return; result.push(node); if (Array.isArray(node.children)) node.children.forEach(visit) }
    visit(draw({$emit() {}}, []))
    return result
  }
  let current = nodes()
  assert.equal(current.find(n => n.type === 'audio').props.src, '/static/uploads/voice.mp3')
  const open = current.find(n => n.type === 'button' && n.children === '查看生成视频')
  assert.equal(open.props['aria-expanded'], false)
  open.props.onClick()
  current = nodes()
  const video = current.find(n => n.type === 'video')
  const close = current.find(n => n.type === 'button' && n.children === '收起生成视频')
  assert.equal(video.props.src, '/static/videos/task-10.mp4')
  assert.ok(Object.hasOwn(video.props, 'controls'))
  assert.equal(close.props['aria-controls'], video.props.id)
  assert.equal(close.props['aria-expanded'], true)
  props.videoUrl = '/static/videos/task-11.webm'
  await vue.nextTick()
  assert.equal(nodes().some(n => n.type === 'video'), false)
  assert.ok(nodes().some(n => n.type === 'button' && n.children === '查看生成视频'))
})

test('默认优先即梦，刷新选项保留手动选择，只有 LibTV 时使用 LibTV', async () => {
  const hd = { key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p' }
  const sd = { key: '8/libtv', label: 'LibTV', configId: 8, model: 'libtv', resolution: '480p' }
  const props = vue.reactive({ asset: character, generationOptions: [hd, sd] })
  const draw = exported.default.setup(props, {emit() {}, expose() {}})
  function nodes() {
    const result = []
    function visit(node) { if (!node || typeof node !== 'object') return; result.push(node); if (Array.isArray(node.children)) node.children.forEach(visit) }
    visit(draw({$emit() {}}, []))
    return result
  }
  nodes().find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  assert.ok(nodes().some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、720p')))
  nodes().find(n => n.type === 'select').props['onUpdate:modelValue'](sd.key)
  props.generationOptions = [{...hd}, {...sd}]
  await vue.nextTick()
  assert.ok(nodes().some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、480p')))
  nodes().find(n => n.type === 'select').props['onUpdate:modelValue'](hd.key)
  props.generationOptions = [{...sd}]
  await vue.nextTick()
  assert.ok(nodes().some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、480p')))
})

test('角色默认关闭模型配音，仅手动开启的角色勾选，参考音频仍可试听', () => {
  const voiceAudio = {url: '/static/uploads/original.mp3', name: '守卫原声.mp3'}
  for (const asset of [character, {...character, voiceAudio}]) {
    const standard = render({asset})
    const checkbox = standard.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
    assert.equal(checkbox.props.checked, false)
    checkbox.props.onChange({currentTarget: {checked: true}})
    assert.deepEqual(standard.events, [['model-voice', true]])
  }

  const reference = render({asset: {...character, voiceAudio, voiceMode: 'reference'}})
  const selected = reference.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(selected.props.checked, false)
  assert.equal(reference.audio.props.src, voiceAudio.url)
  assert.ok(reference.nodes.some(n => n.type === 'span' && n.children === '已设置的角色声音优先使用。关闭后，有对白或心声时需要参考音频。'))
  selected.props.onChange({currentTarget: {checked: true}})
  assert.deepEqual(reference.events, [['model-voice', true]])

  const disabled = render({asset: {...character, voiceMode: 'model'}, disabled: true})
  const disabledCheckbox = disabled.nodes.find(n => n.type === 'input' && n.props.type === 'checkbox')
  assert.equal(disabledCheckbox.props.checked, true)
  assert.equal(disabledCheckbox.props.disabled, true)
  disabledCheckbox.props.onChange({currentTarget: {checked: false}})
  assert.deepEqual(disabled.events, [])
})
