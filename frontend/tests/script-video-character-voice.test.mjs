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
  return {...vue, useId: () => 'test-id', withDirectives: (node, directives) => ({...node, directives})}
}})

const character = {id: 'hero', name: '守卫', kind: 'character', image: '/static/uploads/hero.png'}
const voiceExample = '青年年龄感｜清朗青年男声，中低音区、略带松弛感｜清冷克制，措辞端正，句尾收稳｜中等音量｜正常语速｜中文普通话'
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
  assert.equal(fields[0].props.placeholder, voiceExample)
  fields[0].props['onUpdate:modelValue']('温暖的青年女声')
  fields[1].props['onUpdate:modelValue']('你好，我来了。')
  current = nodes()
  assert.equal(current.find(n => n.type === 'button' && n.children === '开始生成').props.disabled, false)
  assert.ok(current.some(n => n.type === 'option' && n.children === '即梦积分 · 720p'))
  assert.ok(current.some(n => n.type === 'small' && typeof n.children === 'string' && n.children.includes('5 秒、720p')))
  current.find(n => n.type === 'button' && n.children === '开始生成').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['generate', {configId: 7, model: option.model, description: '温暖的青年女声', dialogue: '你好，我来了。'}]])
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

test('打开试音直接预填已有剧本提取描述，点击生成前不提交任务', () => {
  const option = { key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p' }
  const asset = {...character, voiceDescription: {text: voiceExample, sourceLabel: '剧本提取'}}
  const {nodes, redraw, events} = render({asset, generationOptions: [option]})
  nodes.find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  assert.deepEqual(events, [])
  const form = redraw()
  assert.equal(form.find(n => n.type === 'textarea').directives[0][1], voiceExample)
  assert.equal(form.find(n => n.type === 'button' && n.children === '开始生成').props.disabled, false)
  assert.ok(form.some(n => n.type === 'small' && n.children === '描述来源：剧本提取'))
  redraw().find(n => n.type === 'button' && n.children === '开始生成').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [['generate', {
    configId: 7, model: 'jimeng', description: voiceExample, dialogue: '这也不会那也不会，你到底是怎么修炼到现在的。',
  }]])
})

test('冲突显示出处和原文，用户可明确确认继续使用现有描述', () => {
  const option = { key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p' }
  const clue = { facet: 'timbre', value: '清亮', source: 'explicit', evidence: [{title: '来客', episodeNumber: 3, quote: '声音清亮'}] }
  const discordant = {...clue, value: '嘶哑', evidence: [{title: '初见', episodeNumber: 1, quote: '声音嘶哑'}]}
  const voiceProfile = {id: 'guard-adult', character: '守卫', ageStage: 'adult', clues: [], conflicts: [clue, discordant]}
  const asset = {...character, voiceDescription: {text: '声音清亮', sourceLabel: '剧本提取'}, voiceProfile}
  const {nodes, redraw, events} = render({asset, generationOptions: [option]})
  assert.ok(nodes.some(n => n.type === 'small' && n.children === '剧本来源：第 1 集、第 3 集'))
  assert.ok(nodes.some(n => n.type === 'summary' && n.children === '查看有出入的声音线索'))
  assert.ok(nodes.some(n => n.type === 'li' && n.children === '第 1 集「声音嘶哑」'))
  nodes.find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  const generate = () => redraw().find(n => n.type === 'button' && n.children === '开始生成')
  assert.equal(generate().props.disabled, true)
  generate().props.onClick()
  assert.deepEqual(events, [])
  redraw().find(n => n.type === 'input' && n.props.type === 'checkbox' && n.props['onUpdate:modelValue'])
    .props['onUpdate:modelValue'](true)
  assert.equal(generate().props.disabled, false)
  generate().props.onClick()
  assert.equal(events[0][1].description, '声音清亮')
  assert.equal(events[0][1].confirmVoiceConflict, true)
})

test('异步保存的描述更新空表单并保留用户已经输入的描述', async () => {
  const option = { key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p' }
  const props = vue.reactive({asset: {...character}, generationOptions: [option]})
  const {nodes, redraw, events} = render(props)
  nodes.find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  const description = () => redraw().find(n => n.type === 'textarea')
  props.asset.voiceDescription = {text: '沙哑', sourceLabel: '剧本提取'}
  await vue.nextTick()
  assert.equal(description().directives[0][1], '沙哑')
  description().props['onUpdate:modelValue']('用户选择的声音')
  props.asset.voiceDescription = {text: '稍沙哑', sourceLabel: '剧本提取'}
  await vue.nextTick()
  redraw().find(n => n.type === 'button' && n.children === '开始生成').props.onClick()
  assert.equal(events[0][1].description, '用户选择的声音')
})

test('年龄待定时只能先确认造型的年龄，确认本身不发出生成事件', () => {
  const voiceProfile = {id: 'guard-unknown', character: '守卫', ageStage: 'unknown', ageConflict: ['child', 'adult'], clues: [], conflicts: [],
    ageEvidence: [{stage: 'child', title: '回忆', episodeNumber: 2, quote: '少年时的守卫'}]}
  const {nodes, redraw, events} = render({asset: {...character, voiceProfile}})
  assert.equal(nodes.some(n => n.type === 'button' && n.children === '生成角色声音'), false)
  assert.ok(nodes.some(n => n.type === 'li' && n.children === '儿童 · 第 2 集「少年时的守卫」'))
  const confirm = () => redraw().find(n => n.type === 'button' && n.children === '确认年龄阶段')
  assert.equal(confirm().props.disabled, true)
  confirm().props.onClick()
  const select = nodes.find(n => n.type === 'select')
  select.props['onUpdate:modelValue']('older_adult')
  confirm().props.onClick()
  assert.deepEqual(events, [])
  select.props['onUpdate:modelValue']('adult')
  assert.equal(confirm().props.disabled, false)
  confirm().props.onClick()
  assert.deepEqual(events, [['confirm-age', 'adult']])
})

test('同年龄共用生成声音可以试听，已生成的年龄组不会再次出现生成入口', () => {
  const voiceProfile = {id: 'guard-adult', character: '守卫', ageStage: 'adult', clues: [], conflicts: []}
  const voiceAudio = {url: '/static/uploads/voice.mp3', name: '守卫.mp3'}
  const hasGenerate = nodes => nodes.some(n => n.type === 'button' && n.children === '生成角色声音')
  const linked = render({asset: {...character, voiceProfile, voiceAudio}, sharedVoicePresent: true})
  assert.equal(linked.audio.props.src, voiceAudio.url)
  assert.ok(linked.nodes.some(n => n.type === 'small' && n.children === '同一年龄阶段的角色造型共用这段声音。'))
  assert.equal(hasGenerate(linked.nodes), false)
  assert.equal(hasGenerate(render({asset: {...character, voiceProfile}, alreadyGenerated: true}).nodes), false)
  assert.equal(hasGenerate(render({asset: {...character, voiceProfile: {...voiceProfile, audioConflict: true}}}).nodes), false)
  assert.equal(hasGenerate(render({asset: {...character, voiceAudio}}).nodes), true)
})

test('之前手动保存的声音描述可直接复用', () => {
  const option = {key: '7/jimeng', label: '即梦', configId: 7, model: 'jimeng', resolution: '720p'}
  const asset = {...character, voiceDescription: {text: '声音清亮', sourceLabel: '手动编辑'}}
  const {nodes, redraw, events} = render({asset, generationOptions: [option]})
  nodes.find(n => n.type === 'button' && n.children === '生成角色声音').props.onClick()
  const generate = redraw().find(n => n.type === 'button' && n.children === '开始生成')
  assert.equal(generate.props.disabled, false)
  generate.props.onClick()
  assert.equal(events[0][1].description, '声音清亮')
})

test('试音区显示各易装身份及其对应的剧本提取描述', () => {
  const variants = [
    { disguise: 'male_as_female', ageStage: 'adult', label: '守卫 · 成年 · 男扮女装', description: '成年感｜轻细女声｜压低声音，收尾轻｜轻声｜正常语速｜中文普通话' },
    { disguise: 'female_as_male', ageStage: 'unknown', label: '守卫 · 女扮男装', description: '年龄感自然｜偏低男声｜简短利落｜中等音量｜正常语速｜中文普通话' },
  ]
  for (const { disguise, ageStage, label, description } of variants) {
    const asset = {
      ...character,
      voiceProfile: { id: disguise, character: character.name, ageStage, disguise, clues: [], conflicts: [] },
      voiceDescription: { text: description, sourceLabel: '剧本提取' },
    }
    const { nodes, redraw } = render({ asset })
    assert.ok(nodes.some(node => node.type === 'small' && node.children === label))
    nodes.find(node => node.type === 'button' && node.children === '生成角色声音').props.onClick()
    assert.equal(redraw().find(node => node.type === 'textarea').directives[0][1], description)
  }
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
