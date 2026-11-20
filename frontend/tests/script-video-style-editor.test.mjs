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
