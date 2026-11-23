import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import { computed, ref, watch, nextTick } from 'vue'

const source = readFileSync(new URL('../app/components/MentionTextarea.vue', import.meta.url), 'utf8')
const { descriptor } = parse(source)
const script = descriptor.scriptSetup.content.replace(/^import .*$/gm, '')
const rect = (left, top, right, bottom) => ({ left, top, right, bottom })
const token = (index, ...rects) => ({ dataset: { mentionIndex: String(index) }, getClientRects: () => rects })
const role = (value, image = '/' + value + '.png') => ({ value, label: value, image, kind: 'character', group: '角色' })

function controller(overrides = {}) {
  const props = { modelValue: '@侍卫长_礼服回头。@侍卫抬手。', options: [role('侍卫'), role('侍卫长_礼服')], previewOnHover: true, ...overrides }
  const events = [], mounted = [], unmounted = [], listeners = new Map()
  const audio = [], timers = new Map()
  const document = { activeElement: null }
  let nextTimer = 0
  const window = {
    innerWidth: 1000, innerHeight: 800,
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type) },
  }
  const value = runInNewContext(script + '\n;({ text, mention, taEl, backdropEl, dropdownEl, searchEl, searchQuery, groupedFiltered, flatList, preview, previewStyle, previewImageFailed, highlightedHtml, onPreviewMove, enterPreview, leavePreview, onTouchPreview, closePreview, onScroll, onBeforeInput, onInput, onBlur, onDropdownFocusOut, onCompositionStart, onCompositionEnd, onKeydown, onMentionKeydown, syncDisplay })', {
    ref, computed, watch, nextTick, window, document,
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: id => timers.delete(id),
    useScriptVideoAudioPreview: () => ({ player: ref(), scheduleAudioPreview: () => audio.push('start'), cancelAudioStart: () => audio.push('cancel'), stopAudioPreview: () => audio.push('stop') }),
    defineProps: () => props, defineEmits: () => (...event) => events.push(event), defineExpose: () => {},
    useI18n: () => ({ t: key => key }),
    onMounted: callback => mounted.push(callback), onBeforeUnmount: callback => unmounted.push(callback),
  })
  let tokens = [token(1, rect(100, 110, 200, 130)), token(0, rect(220, 110, 270, 130))]
  value.taEl.value = { getBoundingClientRect: () => rect(80, 90, 500, 400), scrollTop: 30, scrollLeft: 0 }
  document.activeElement = value.taEl.value
  value.backdropEl.value = { querySelectorAll: () => tokens, scrollTop: 0, scrollLeft: 0 }
  mounted.forEach(callback => callback())
  return { ...value, props, events, audio, window, document, listeners, setTokens: next => { tokens = next }, flushTimers: () => timers.forEach(callback => callback()), dispose: () => unmounted.forEach(callback => callback()) }
}

test('完整资产名在原始文本匹配后转义，特殊字符可预览且未知造型不误绑', () => {
  const app = controller({
    modelValue: '<script> @A&B（夜装）回头，@侍卫_未导入、@侍卫。',
    options: [role('侍卫'), role('A&B（夜装）')],
  })
  const html = app.highlightedHtml.value
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('data-mention-index="1">@A&amp;B（夜装）</span>'))
  assert.ok(html.includes('@侍卫_未导入、<span'))
  assert.equal((html.match(/data-mention-index=/g) || []).length, 2)
  app.dispose()
})

test('悬停命中真实 token 图片，不改提示词、光标或发送编辑事件，移出即关闭', () => {
  const app = controller()
  const original = app.text.value
  app.onPreviewMove({ clientX: 140, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option.value, '侍卫长_礼服')
  assert.equal(app.preview.value.option.image, '/侍卫长_礼服.png')
  assert.equal(app.previewStyle.value.left, '100px')
  assert.equal(app.previewStyle.value.top, '140px')
  assert.equal(app.text.value, original)
  assert.deepEqual(app.events, [])
  app.onPreviewMove({ clientX: 210, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option, null)
  app.dispose()
})

test('换行引用逐个矩形命中，裁剪区外、选择文字时和候选菜单打开时均不预览', () => {
  const app = controller()
  app.setTokens([token(1, rect(450, 110, 500, 130), rect(100, 135, 170, 155))])
  app.onPreviewMove({ clientX: 140, clientY: 145, buttons: 0 })
  assert.equal(app.preview.value.option.value, '侍卫长_礼服')
  app.onPreviewMove({ clientX: 200, clientY: 145, buttons: 0 })
  assert.equal(app.preview.value.option, null, '换行两块之间的非引用文本不能命中')
  app.setTokens([token(1, rect(100, 50, 170, 80))])
  app.onPreviewMove({ clientX: 140, clientY: 65, buttons: 0 })
  assert.equal(app.preview.value.option, null)
  app.setTokens([token(1, rect(100, 110, 200, 130))])
  app.onPreviewMove({ clientX: 140, clientY: 120, buttons: 1 })
  assert.equal(app.preview.value.option, null)
  app.mention.value.open = true
  app.onPreviewMove({ clientX: 140, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option, null)
  app.dispose()
})

test('滚动与未聚焦时的 Escape 关闭预览，窗口边缘定位不越界，卸载清理监听', () => {
  const app = controller()
  app.window.innerWidth = 320
  app.window.innerHeight = 300
  app.setTokens([token(0, rect(280, 270, 310, 290))])
  app.onPreviewMove({ clientX: 290, clientY: 280, buttons: 0 })
  assert.equal(app.previewStyle.value.left, '96px')
  assert.equal(app.previewStyle.value.top, '20px')
  app.listeners.get('keydown')({ key: 'Escape' })
  assert.equal(app.preview.value.option, null)
  app.onPreviewMove({ clientX: 290, clientY: 280, buttons: 0 })
  app.onScroll()
  assert.equal(app.preview.value.option, null)
  assert.equal(app.backdropEl.value.scrollTop, 30)
  app.dispose()
  assert.equal(app.listeners.size, 0)
})

test('旧流程默认不开启悬停，换图后失败占位状态会重置', () => {
  const app = controller({ previewOnHover: false })
  app.onPreviewMove({ clientX: 140, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option, null)
  app.props.previewOnHover = true
  app.onPreviewMove({ clientX: 140, clientY: 120, buttons: 0 })
  app.previewImageFailed.value = true
  app.onPreviewMove({ clientX: 240, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option.value, '侍卫')
  assert.equal(app.previewImageFailed.value, false)
  app.dispose()
})

test('口播内的角色别名只高亮并命中服装缩略图，不生成上标 @ 或改写原话', () => {
  const text = '顾凌天：“张浩。”'
  const options = [role('顾凌天_龙袍'),role('火枪卫小旗_飞鱼服')]
  const app = controller({modelValue:text, options, resolvePreviewRanges:()=>[
    {start:0,end:3,name:options[0].value}, {start:5,end:7,name:options[1].value},
  ]})
  assert.equal(app.text.value,text)
  assert.match(app.highlightedHtml.value,/data-mention-index="1">张浩</u)
  assert.doesNotMatch(app.highlightedHtml.value, /mention-virtual/u)
  assert.doesNotMatch(source, /content:\s*['"]@['"]/u)
  app.setTokens([token(1,rect(100,110,130,130))])
  app.onPreviewMove({clientX:110,clientY:120,buttons:0})
  assert.equal(app.preview.value.option.image,'/火枪卫小旗_飞鱼服.png')
  app.dispose()
})

test('同名资产按已解析的 ID 绑定悬浮缩略图', () => {
  const options = [
    { ...role('御书房', '/correct.png'), id: 'bound-room' },
    { ...role('御书房', '/other.png'), id: 'other-room' },
  ]
  const app = controller({
    modelValue: '@御书房',
    options,
    resolvePreviewRanges: () => [{ id: 'bound-room', name: '御书房', start: 0, end: 4 }],
  })
  assert.match(app.highlightedHtml.value, /data-mention-index="0">@御书房/u)
  app.setTokens([token(0, rect(100, 110, 130, 130))])
  app.onPreviewMove({ clientX: 110, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option.image, '/correct.png')
  app.dispose()
})

test('中文组合输入不触发引用选择，compositionend 在失焦前完成一次提交', () => {
  const app = controller({ modelValue: '对白：' })
  const target = app.taEl.value
  target.value = '对白：轻'
  target.selectionStart = target.value.length
  app.onInput({ target, isComposing: true })
  assert.equal(app.text.value, target.value)
  assert.deepEqual(app.events, [])

  app.mention.value.open = true
  app.onKeydown({ key: 'Enter', isComposing: true, preventDefault: () => assert.fail('IME confirmation should not select a mention') })
  target.value = '对白：轻声'
  target.selectionStart = target.value.length
  app.onInput({ target, isComposing: true })
  app.onCompositionEnd({ target })
  assert.equal(app.mention.value.open, false)
  assert.deepEqual(app.events, [['update:modelValue', '对白：轻声', target], ['compositionend']])
  app.onInput({ target, isComposing: false })
  assert.equal(app.events.length, 2, 'browsers that also dispatch a final input must not apply it twice')
  app.dispose()
})

test('在有源音频的引用上等待试听，进入播放器不关闭，触屏只打开控件', () => {
  const voice = { value: '音频1', kind: 'audio', audioUrl: '/reference.wav', previewOnly: true }
  const app = controller({ options: [voice] })
  app.setTokens([token(0, rect(100, 110, 160, 130))])

  app.onPreviewMove({ clientX: 120, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option.audioUrl, '/reference.wav')
  assert.deepEqual(app.audio, ['start'])
  app.leavePreview()
  app.enterPreview()
  app.flushTimers()
  assert.equal(app.preview.value.option.audioUrl, '/reference.wav')
  app.leavePreview()
  app.flushTimers()
  assert.equal(app.preview.value.option, null)
  assert.equal(app.audio.at(-1), 'stop')

  app.audio.length = 0
  app.onTouchPreview({ pointerType: 'touch', clientX: 120, clientY: 120, buttons: 0 })
  assert.equal(app.preview.value.option.audioUrl, '/reference.wav')
  assert.ok(!app.audio.includes('start'))
  assert.deepEqual(app.events, [])
  app.dispose()
})

test('本段参考素材保持在搜索首组，筛选后仍可选择项目中的其它素材', () => {
  const segment = '本片段参考素材'
  const app = controller({ options: [
    { ...role('音色[侍卫]'), kind: 'audio', group: '角色音色', menuGroup: segment },
    { ...role('院落'), kind: 'scene', group: '背景', menuGroup: segment },
    role('侍卫_夜行'),
    { ...role('音频1'), kind: 'audio', previewOnly: true },
  ] })
  assert.deepEqual(Array.from(app.groupedFiltered.value, group => group.group), [segment, '角色'])
  assert.equal(app.groupedFiltered.value[0].options.length, 2)
  assert.deepEqual(Array.from(app.flatList.value, option => option.value), ['音色[侍卫]', '院落', '侍卫_夜行'])
  app.searchQuery.value = '侍卫'
  assert.deepEqual(Array.from(app.flatList.value, option => option.value), ['音色[侍卫]', '侍卫_夜行'])
  app.dispose()
})

test('提示词键盘删除引用时记录删除前的位置，并将 Ctrl+Z 和 Cmd+Shift+Z 交给提示词历史', () => {
  const modelValue = '对白：@侍卫 @音频12：“别回头。”'
  const start = modelValue.indexOf('@侍卫'), end = start + '@侍卫'.length
  const app = controller({ modelValue, manageHistory: true,
    resolvePreviewRanges: () => [{ start, end }] })
  const ta = app.taEl.value
  Object.assign(ta, { value: modelValue, selectionStart: end, selectionEnd: end, selectionDirection: 'none',
    focus() {}, setSelectionRange(from, to) { ta.selectionStart = from; ta.selectionEnd = to } })
  let prevented = 0
  const preventDefault = () => { prevented++ }
  app.onKeydown({ key: 'Backspace', preventDefault })
  assert.equal(ta.value, '对白： @音频12：“别回头。”')
  assert.equal(app.events[0][3].selectionStart, end)
  app.onKeydown({ key: 'z', ctrlKey: true, preventDefault })
  app.onKeydown({ key: 'Z', metaKey: true, shiftKey: true, preventDefault })
  app.onBeforeInput({ inputType: 'historyUndo', cancelable: true, preventDefault })
  assert.deepEqual(app.events.slice(2), [['history', 'undo'], ['history', 'redo'], ['history', 'undo']])
  assert.equal(prevented, 4)
  app.dispose()
})

test('候选列表滚动仍打开，方向键滚动列表而不移动页面', async () => {
  const app = controller()
  app.mention.value.open = true
  const dropdown = {
    scrollTop: 0, clientTop: 0, clientHeight: 220,
    getBoundingClientRect: () => rect(0, 100, 240, 320),
    querySelector: () => ({ getBoundingClientRect: () => rect(0, 360, 240, 385) }),
  }
  app.dropdownEl.value = dropdown
  app.listeners.get('scroll')({ target: app.dropdownEl.value })
  assert.equal(app.mention.value.open, true)
  app.onKeydown({ key: 'ArrowDown', preventDefault() {} })
  await nextTick()
  assert.equal(dropdown.scrollTop, 65)
  app.listeners.get('scroll')({ target: {} })
  assert.equal(app.mention.value.open, false)
  app.dispose()
})

test('独立搜索按素材名称筛选，键盘选择后回到原提示词光标', () => {
  const original = '镜头 @魏 转向院门'
  const app = controller({ searchable: true, modelValue: original, options: [
    role('魏忠国_3DQ版'),
    { ...role('魏宅'), group: '场景' },
    { ...role('魏忠国_配音'), previewOnly: true },
  ] })
  const target = app.taEl.value
  target.value = original
  target.focus = () => { app.document.activeElement = target }
  target.setSelectionRange = (start, end) => { target.selectionStart = start; target.selectionEnd = end }
  const search = {
    focus() {
      app.document.activeElement = search
      app.onBlur({ relatedTarget: search })
    },
  }
  app.dropdownEl.value = { contains: node => node === search, scrollTop: 55 }
  app.searchEl.value = search
  app.mention.value = { open: true, start: 3, end: 5, query: '魏' }
  target.setSelectionRange(5, 5)
  app.onKeydown({ key: 'ArrowDown', altKey: true, preventDefault() {} })
  assert.equal(app.document.activeElement, search)
  assert.equal(app.searchQuery.value, '魏')
  assert.deepEqual(app.events, [])

  app.searchQuery.value = '3dq'
  assert.equal(app.dropdownEl.value.scrollTop, 0)
  assert.equal(app.flatList.value.length, 1)
  assert.equal(app.flatList.value[0].value, '魏忠国_3DQ版')
  assert.equal(app.text.value, original)
  app.onMentionKeydown({ key: 'Enter', isComposing: true, preventDefault: () => assert.fail('IME confirmation should not pick an asset') })
  assert.equal(app.mention.value.open, true)

  target.setSelectionRange(0, 0)
  app.onMentionKeydown({ key: 'Enter', preventDefault() {} })
  assert.equal(app.document.activeElement, target)
  assert.equal(app.text.value, '镜头 @魏忠国_3DQ版  转向院门')
  assert.equal(target.selectionStart, '镜头 @魏忠国_3DQ版 '.length)
  assert.equal(app.mention.value.open, false)
  assert.deepEqual(app.events.at(-1), ['commit', app.text.value])
  app.dispose()
})

test('搜索框移出焦点只提交提示词，重开不保留上一次搜索', () => {
  const app = controller({ searchable: true, modelValue: '动作 @' })
  app.mention.value = { open: true, start: 3, end: 4, query: '' }
  app.searchQuery.value = '查不到的素材'
  assert.equal(app.flatList.value.length, 0)
  app.onDropdownFocusOut({ relatedTarget: null })
  assert.equal(app.mention.value.open, false)
  assert.equal(app.searchQuery.value, '')
  assert.deepEqual(app.events, [['commit', '动作 @', true]])
  app.dispose()
})

test('未编辑的提示词失焦时保留原始换行', () => {
  const input = '开场\r\n对白'
  const app = controller({ modelValue: input })
  app.onBlur({ target: { value: input.replace('\r\n', '\n') }, relatedTarget: null })
  assert.deepEqual(app.events, [['commit', input, true]])
  app.dispose()
})

test('组合输入时失焦，等中文输入完成后保存最终文字且不重开候选', () => {
  const app = controller({ modelValue: '对白：' })
  const target = app.taEl.value
  app.onCompositionStart()
  target.value = '对白：qingsheng'
  app.onInput({ target, isComposing: true })
  app.document.activeElement = null
  app.onBlur({ target, relatedTarget: null })
  assert.deepEqual(app.events, [['compositionstart']])
  target.value = '对白：轻声'
  app.onCompositionEnd({ target })
  assert.deepEqual(app.events, [['compositionstart'], ['update:modelValue', '对白：轻声', target], ['compositionend'], ['commit', '对白：轻声', true]])
  assert.equal(app.mention.value.open, false)
  app.dispose()
})

test('格式化素材引用后恢复原滚动位置和选区，镜像同步滚动', () => {
  const app = controller({ modelValue: '逐镜检查\n画面与动作：侍卫推门。' })
  const target = app.taEl.value
  let nativeValue = app.text.value
  Object.defineProperty(target, 'value', {
    get: () => nativeValue,
    set(value) {
      nativeValue = value
      target.scrollTop = 0
      target.scrollLeft = 0
    },
  })
  target.scrollTop = 170
  target.scrollLeft = 10
  target.setSelectionRange = (start, end, direction) => Object.assign(target, { selectionStart: start, selectionEnd: end, selectionDirection: direction })
  const formatted = nativeValue.replace('侍卫', '@侍卫')
  const end = formatted.indexOf('。')
  app.syncDisplay(formatted, end - 2, end, 'backward')
  assert.equal(target.value, formatted)
  assert.deepEqual([target.selectionStart, target.selectionEnd, target.selectionDirection], [end - 2, end, 'backward'])
  assert.equal(target.scrollTop, 170)
  assert.equal(target.scrollLeft, 10)
  assert.equal(app.backdropEl.value.scrollTop, 170)
  assert.equal(app.backdropEl.value.scrollLeft, 10)
  app.dispose()
})
