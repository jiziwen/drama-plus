import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createSSRApp, h } from 'vue'
import * as vue from 'vue'
import { renderToString } from '@vue/server-renderer'
import ts from 'typescript'
import * as style from '../../backend/src/services/script-video-style.ts'

const filename = 'ScriptVideoStylePresetEditor.vue'
const source = readFileSync(new URL('../app/components/' + filename, import.meta.url), 'utf8')
const { descriptor } = parse(source, {filename})
const compiled = compileScript(descriptor, {id: 'style-editor', inlineTemplate: true})
const { outputText } = ts.transpileModule(compiled.content, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
})
const component = {}
runInNewContext(outputText, {
  exports: component,
  require: name => {
    if (name === 'vue') return vue
    if (name.endsWith('/script-video-style')) return style
    if (name.endsWith('/scriptVideoClient')) return { createScriptVideoUuid: () => crypto.randomUUID() }
    throw new Error('Unexpected component import ' + name)
  },
})
const presets = style.SCRIPT_VIDEO_STYLE_PRESETS

test('实际界面仅呈现冷、暖两项，切换后完整显示项目所选前缀', async () => {
  assert.deepEqual(presets.map(item => item.name), ['冷色调', '暖色调'])
  for (const value of presets) {
    const app = createSSRApp({ render: () => h(component.default, {modelValue: value, presets}) })
    const markup = await renderToString(app)
    assert.equal((markup.match(/type="radio"/g) || []).length, 2)
    assert.ok(markup.includes('冷色调') && markup.includes('暖色调'))
    assert.ok(!markup.includes('自定义') && !markup.includes('<textarea'))
    const expected = await renderToString(h('pre', {'aria-label': '完整前缀原文'}, value.prefix))
    assert.ok(markup.includes(expected))
    assert.ok(!markup.includes('项目风格：' + value.name))
  }
})

test('选择风格时发送独立项目快照，不裁剪空行或改写任何字符', () => {
  const props = {presets, modelValue: presets[0]}
  const script = descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
  const {outputText} = ts.transpileModule(script, {compilerOptions:{target:ts.ScriptTarget.ES2022}})
  const context = {
    defineProps: () => props,
    defineEmits: () => (event, value) => {
      assert.equal(event, 'update:modelValue')
      props.modelValue = value
    },
    useId: () => 'test-group',
    ref: vue.ref,
    computed: getter => ({get value() { return getter() }}),
    formatScriptVideoStylePreset: style.formatScriptVideoStylePreset,
  }
  const controls = runInNewContext(outputText + '\n;({ selectPreset, prefix })', context)
  const literal = {id: 'warm', name: '暖色调', prefix: '  段首空格\r\n\r\n<与 & 均保留>\n'}
  controls.selectPreset(literal)
  assert.notEqual(props.modelValue, literal)
  assert.equal(props.modelValue.prefix, literal.prefix)
  assert.equal(controls.prefix.value, literal.prefix)
})

test('已选内置风格可直接使用最新预设，点击前保留旧快照，点击后完整更新预览', async () => {
  for (const latest of presets) {
    const oldPrefix = latest.name + '\r\n\r\n旧泛光段。\r\n'
    const saved = { ...latest, prefix: oldPrefix }
    const props = { presets, modelValue: saved }
    const app = createSSRApp({ render: () => h(component.default, props) })
    const markup = await renderToString(app)
    assert.match(markup, /使用最新预设/u)
    assert.match(markup, /旧泛光段。/u)
    assert.equal(props.modelValue, saved)

    const events = []
    const script = descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
    const { outputText } = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    const controls = runInNewContext(outputText + '\n;({ useLatestPreset, latestPreset, prefix })', {
      defineProps: () => props,
      defineEmits: () => (event, value) => { events.push([event, value]); props.modelValue = value },
      useId: () => 'test-group',
      ref: vue.ref,
      computed: getter => ({ get value() { return getter() } }),
      formatScriptVideoStylePreset: style.formatScriptVideoStylePreset,
    })
    assert.equal(events.length, 0)
    assert.equal(controls.latestPreset.value, latest)
    controls.useLatestPreset()
    assert.equal(events.length, 1)
    assert.equal(events[0][0], 'update:modelValue')
    assert.notEqual(props.modelValue, latest)
    assert.equal(props.modelValue.id, latest.id)
    assert.equal(props.modelValue.name, latest.name)
    assert.equal(props.modelValue.prefix, latest.prefix)
    assert.equal(controls.prefix.value, latest.prefix)
    assert.equal(controls.latestPreset.value, undefined)
    assert.equal(saved.prefix, oldPrefix)
  }
})

test('项目风格可以新增、编辑和删除自定义项，删除后回到冷色调', async () => {
  const id = 'custom-00000000-0000-4000-8000-000000000001'
  const keep = { id: 'custom-00000000-0000-4000-8000-000000000002', name: '定格动画', prefix: '羊毛毡质感' }
  const props = { modelValue: presets[0], presets, customPresets: { [keep.id]: keep } }
  const original = props.customPresets
  const render = () => renderToString(createSSRApp({ render: () => h(component.default, props) }))
  assert.match(await render(), /新增自定义风格/u)
  const script = descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
  const { outputText } = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
  const controls = runInNewContext(outputText + '\n;({ addCustomPreset, editCustomPreset, removeCustomPreset })', {
    defineProps: () => props,
    defineEmits: () => (event, value) => { props[event.slice('update:'.length)] = value },
    useId: () => 'test-group',
    ref: vue.ref,
    nextTick: vue.nextTick,
    computed: getter => ({ get value() { return getter() } }),
    createScriptVideoUuid: () => id.slice('custom-'.length),
    formatScriptVideoStylePreset: style.formatScriptVideoStylePreset,
  })
  await controls.addCustomPreset()
  controls.editCustomPreset('name', { target: { value: '水墨动画' } })
  controls.editCustomPreset('prefix', { target: { value: '宣纸纹理\n淡墨层次' } })
  assert.equal(props.modelValue.id, id)
  assert.equal(props.customPresets[id].prefix, '宣纸纹理\n淡墨层次')
  assert.equal(original[id], undefined)
  assert.match(await render(), /水墨动画.*风格名称.*风格提示词.*删除此风格/su)

  controls.removeCustomPreset()
  assert.equal(props.modelValue.id, 'cool')
  assert.equal(props.customPresets[id], undefined)
  assert.equal(props.customPresets[keep.id], keep)
  assert.doesNotMatch(await render(), /删除此风格/u)
})

test('当前内置快照和自定义风格均不显示更新按钮或自动替换前缀', async () => {
  for (const value of [
    ...presets,
    { id: 'custom', name: '我的风格', prefix: '自定义原文\r\n\r\n' },
  ]) {
    const snapshot = { ...value }
    const app = createSSRApp({ render: () => h(component.default, { modelValue: value, presets }) })
    const markup = await renderToString(app)
    assert.doesNotMatch(markup, /使用最新预设/u)
    assert.deepEqual(value, snapshot)
  }
})
