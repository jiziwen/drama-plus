import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as vue from 'vue'
import ts from 'typescript'
import * as preview from '../app/utils/scriptVideoPreview'
import * as promptVoiceView from '../app/utils/scriptVideoPromptVoiceView'
import * as validation from '../app/utils/scriptVideoPreviewValidation'
import { buildScriptVideoDelivery, getScriptVideoPromptVoices } from '../../backend/src/services/script-video-delivery'
import { getScriptVideoStylePreset, scriptVideoPromptStylePrefix, splitScriptVideoPromptStyle } from '../../backend/src/services/script-video-style'

const filename = 'ScriptVideoPreviewEditor.vue'
const source = readFileSync(new URL('../app/components/' + filename, import.meta.url), 'utf8')
const script = compileScript(parse(source, {filename}).descriptor, {id: 'editor', inlineTemplate: true})
const { outputText } = ts.transpileModule(script.content, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}})
const component: any = {}
const menu = { name: 'MentionTextarea' }
let nextId = 0
const modules: Record<string, unknown> = {
  vue: { ...vue, useId: () => `editor-${++nextId}`, resolveComponent: (name: string) => name, withDirectives: (node: unknown) => node },
  'lucide-vue-next': { Eye: 'Eye', Headphones: 'Headphones', Maximize2: 'Maximize2', Minimize2: 'Minimize2', Sparkles: 'Sparkles', Upload: 'Upload', X: 'X' },
  './MentionTextarea.vue': { default: menu },
  '~/utils/scriptVideoPreview': preview,
  '~/utils/scriptVideoPromptVoiceView': promptVoiceView,
  '~/utils/scriptVideoPreviewValidation': validation,
  '../../../backend/src/services/script-video-delivery': { getScriptVideoPromptVoices },
  '../../../backend/src/services/script-video-style': { splitScriptVideoPromptStyle },
}
runInNewContext(outputText, {exports: component, require: (id: string) => modules[id]})

function flatten(node: any): any[] {
  if (!node || typeof node !== 'object') return []
  return [node, ...(Array.isArray(node.children) ? node.children.flatMap(flatten) : [])]
}
const makeAsset = (id: string, name: string): preview.PreviewAsset => ({id, name, kind:'character', image: '/static/' + id + '.png'})
const assets = [makeAsset('guard','侍卫'), makeAsset('night','侍卫_夜行'), makeAsset('other','第三人')]
type EditorTab = 'shots' | 'prompt' | 'revise' | 'continuity' | 'preview'
function setup(ids: string[], { tab, openPrompt = true, completedTaskVideoUrl, assetList = assets }: {
  tab?: EditorTab; openPrompt?: boolean; completedTaskVideoUrl?: string; assetList?: preview.PreviewAsset[]
} = {}) {
  const card: preview.PreviewCard = {id:'c', title:'片段', summary:'', duration:3, assetIds:ids, shots:[], prompt:'@侍卫_夜行 入场。', status:'draft', version:1, combat:false}
  const props = vue.reactive({card, assets: assetList, tab, completedTaskVideoUrl})
  const tabChanges: EditorTab[] = []
  const draw = component.default.setup(props, {expose() {}, emit(event: string, next: preview.PreviewCard | EditorTab) {
    if (event === 'update' && typeof next !== 'string') props.card = next
    if (event === 'update:tab' && typeof next === 'string') {
      tabChanges.push(next)
      if (props.tab !== undefined) props.tab = next
    }
  }})
  function nodes() { return flatten(draw({}, [])) }
  function tabButtons() { return flatten(nodes().find(n => n.type === 'nav')).filter(n => n.type === 'button') }
  if (openPrompt) tabButtons().find(n => n.children === '视频提示词').props.onClick()
  return {props, nodes, tabButtons, tabChanges, names: () => nodes().filter(n => n.type === 'button' && n.props?.['aria-label']?.startsWith('移除参考素材')).map(n => n.props['aria-label'])}
}

function editPrompt(textarea: any, text: string) {
  return textarea.props['onUpdate:modelValue'](text, { value: text, selectionStart: text.length, selectionEnd: text.length })
}

test('参考素材列表保留已绑定素材的选择顺序', () => {
  const editor = setup(['night','guard'])
  assert.deepEqual(editor.names(), ['移除参考素材 侍卫_夜行', '移除参考素材 侍卫'])
})

test('点参考图打开预览，只有独立的移除按钮改变素材绑定', async () => {
  const editor = setup(['night', 'guard'])
  const card = editor.props.card
  const view = editor.nodes().find(node => node.props?.['aria-label'] === '查看参考图 侍卫_夜行')
  await view.props.onClick()
  const dialog = editor.nodes().find(node => node.type === 'dialog')
  assert.equal(flatten(dialog).find(node => node.type === 'img').props.src, assets[1]!.image)
  assert.equal(editor.props.card, card)
  assert.deepEqual(editor.names(), ['移除参考素材 侍卫_夜行', '移除参考素材 侍卫'])

  editor.nodes().find(node => node.props?.['aria-label'] === '移除参考素材 侍卫_夜行').props.onClick()
  assert.deepEqual(Array.from(editor.props.card.assetIds), ['guard'])
})

test('编辑正式镜头后配图随画面更新，保留候选和未修改的发声角色', () => {
  const editor = setup(['night', 'guard'])
  Object.assign(editor.props.card, {
    openingRecap: '侍卫_夜行刚退场。',
    opening: '切到空门廊。',
    openingAssetIds: [],
    prompt: '前镜回顾：侍卫_夜行刚退场。\n←承上：切到空门廊。\n镜头 01（0–3秒）\n画面与动作：@侍卫 入场。\n对白／音效：@侍卫：“走吧。”',
    shots: [{ id: 'shot', duration: 3, camera: '中景', action: '@侍卫 入场。', dialogue: '@侍卫：“走吧。”', visualAssetIds: ['guard'], speakerAssetIds: ['guard'] }],
  })
  const status = (name: string) => flatten(editor.nodes().find(node => node.props?.['aria-label'] === `查看参考图 ${name}`)).find(node => node.type === 'small')?.children
  assert.match(status('侍卫_夜行'), /配图/)
  assert.match(status('侍卫'), /配图/)

  editor.tabButtons().find(n => n.children === '正式分镜').props.onClick()
  editor.nodes().find(n => n.type === 'button' && n.children === '编辑镜头').props.onClick()
  const duration = editor.nodes().find(n => n.props?.['aria-label'] === '镜头 1 时长（秒）')
  duration.props.onChange({ target: { value: '4' } })
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.visualAssetIds ?? []), ['guard'])
  const action = editor.nodes().find(n => n.props?.['aria-label'] === '镜头 1 画面与动作')
  action.props.onInput({ target: { value: '@第三人 从门外进来。' } })
  editor.tabButtons().find(n => n.children === '视频提示词').props.onClick()
  assert.equal(editor.props.card.promptNeedsSync, true)
  assert.equal(editor.props.card.shots[0]!.visualAssetIds, undefined)
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.speakerAssetIds ?? []), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.assetIds), ['night', 'guard', 'other'])
  assert.match(status('侍卫_夜行'), /配图/)
  assert.match(status('侍卫'), /配图/)
  assert.match(status('第三人'), /配图/)
})

test('直接修改视频提示词时让引用按新提示词重新判定', async () => {
  const editor = setup(['night', 'guard'])
  Object.assign(editor.props.card, {
    openingRecap: '侍卫_夜行在前镜退场。',
    openingAssetIds: ['guard'],
    shots: [{ id: 'shot', duration: 3, camera: '中景', action: '@侍卫 入场。', dialogue: '@侍卫：“走吧。”', visualAssetIds: ['guard'], speakerAssetIds: ['guard'] }],
  })
  const textarea = editor.nodes().find(n => n.type === menu)
  await editPrompt(textarea, '前镜回顾：侍卫_夜行在前镜退场。\n镜头 01（0–3秒）\n画面与动作：@第三人 来到门前。')
  assert.equal(editor.props.card.openingAssetIds, undefined)
  assert.equal(editor.props.card.shots[0]!.visualAssetIds, undefined)
  assert.equal(editor.props.card.shots[0]!.speakerAssetIds, undefined)
  assert.equal(editor.props.card.openingRecap, '侍卫_夜行在前镜退场。')
  assert.deepEqual(Array.from(editor.props.card.assetIds), ['night', 'guard', 'other'])
})

test('添加复述和等待对象时保留逐镜绑定，正文人物仍作为模型参考', async () => {
  const editor = setup(['guard', 'night'])
  const prompt = [
    '人物：侍卫_夜行在话中被提及。',
    '镜头 01（0–1秒）',
    '画面与动作：@侍卫在门边。',
    '对白／音效：@侍卫：“侍卫_夜行已经离开了。”',
    '镜头 02（1–3秒）',
    '画面与动作：@侍卫_夜行从墙后走过。',
    '对白／音效：无对白。',
  ].join('\n')
  Object.assign(editor.props.card, { prompt, shots: [
    { id: 'shot-1', duration: 1, camera: '近景', action: '@侍卫在门边。', dialogue: '@侍卫：“侍卫_夜行已经离开了。”',
      visualAssetIds: ['guard'], speakerAssetIds: ['guard'] },
    { id: 'shot-2', duration: 2, camera: '中景', action: '@侍卫_夜行从墙后走过。', dialogue: '无对白。',
      visualAssetIds: ['night'], speakerAssetIds: [] },
  ] })
  const textarea = () => editor.nodes().find(node => node.type === menu)
  const recapEdit = prompt.replace('在话中被提及', '只在报信中被提及')
  await editPrompt(textarea(), recapEdit)
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.visualAssetIds ?? []), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.speakerAssetIds ?? []), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.shots[1]!.visualAssetIds ?? []), ['night'])

  const actionEdit = recapEdit.replace('@侍卫在门边。', '@侍卫在门边，继续等待第三人。')
  await editPrompt(textarea(), actionEdit)
  textarea().props.onCommit(actionEdit)
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.visualAssetIds ?? []), ['guard'])
  assert.deepEqual(new Set(validation.getPreviewMaterialUse(editor.props.card, assets, {}).imageIds), new Set(['guard', 'night', 'other']))
  assert.match(editor.props.card.prompt, /继续等待@第三人。/u)
  assert.match(editor.props.card.prompt, /“侍卫_夜行已经离开了。”/u)

  const manualEdit = actionEdit.replace('@侍卫在门边', '@第三人在门边')
  await editPrompt(textarea(), manualEdit)
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.speakerAssetIds ?? []), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.shots[1]!.visualAssetIds ?? []), ['night'])
  const used = validation.getPreviewMaterialUse(editor.props.card, assets, {})
  assert.deepEqual(new Set(used.imageIds), new Set(['other', 'night', 'guard']))
  assert.deepEqual(used.speakerIds, ['guard'])
})

test('正式分镜的补充画面引用立即出现在参考素材，并带入最终提示词', async () => {
  const pendant: preview.PreviewAsset = { id: 'pendant', name: '玉佩', kind: 'prop', image: '/static/pendant.png' }
  const assetList = [...assets, pendant]
  const base = '镜头 01（0–3秒）\n画面与动作：@侍卫 站在门边。\n对白／音效：@侍卫：“@第三人 还没来。”'
  for (const prompt of [
    base + '\n补充镜头指示：近距离展示 @玉佩 。',
    base + '\n近距离展示 @玉佩 。',
    base.replace('@侍卫：“@第三人 还没来。”', '无。') + '\n桌面摆放 @玉佩 。',
    base.replace('@侍卫：“@第三人 还没来。”', '无对白。仅保留旗布轻响 @玉佩 '),
    base + '；画面与动作：手持 @玉佩 。',
    '独立生成：近距离展示 @玉佩 。\n' + base,
    '参考图：@玉佩 \n' + base,
  ]) {
    const editor = setup(['guard'], { assetList })
    Object.assign(editor.props.card, { prompt: base, shots: [
      { id: 'shot', duration: 3, camera: '中景', action: '侍卫站在门边。', dialogue: '侍卫：“@第三人 还没来。”',
        visualAssetIds: ['guard'], speakerAssetIds: ['guard'] },
    ] })
    await editPrompt(editor.nodes().find(n => n.type === menu), prompt)
    assert.deepEqual(Array.from(editor.props.card.assetIds), ['guard', 'pendant'])
    assert.deepEqual(editor.names(), ['移除参考素材 侍卫', '移除参考素材 玉佩'])
    assert.match(flatten(editor.nodes().find(n => n.props?.['aria-label'] === '查看参考图 玉佩'))
      .find(n => n.type === 'small')?.children, /配图/)
    const result = buildScriptVideoDelivery(editor.props.card, assetList)
    assert.deepEqual(result.images.map(asset => asset.id), ['guard', 'pendant'])
    assert.match(result.prompt, /@图片2玉佩/u)
    assert.doesNotMatch(result.prompt, /@图片\d+第三人/u)
  }
})

test('冷暖色预设折叠显示，编辑正文后仍保存完整风格内容与素材引用', async () => {
  for (const id of ['cool', 'warm']) {
    const editor = setup(['guard'])
    const preset = getScriptVideoStylePreset(id)!
    const prefix = scriptVideoPromptStylePrefix(preset).replaceAll('\r\n', '\n')
    const body = '画面与动作：@侍卫 守门。'
    editor.props.card.prompt = prefix + '\n\n' + body
    const textarea = editor.nodes().find(n => n.type === menu)
    assert.equal(textarea.props['model-value'], body)
    const detail = editor.nodes().find(n => n.type === 'ScriptVideoPromptStyle')
    assert.equal(detail.props.preset.name, preset.name)
    const edited = '画面与动作：@第三人 推门。'
    await editPrompt(textarea, edited)
    const current = editor.nodes().find(n => n.type === menu)
    const hit = current.props['resolve-preview-ranges'](edited).find((ref: { id: string }) => ref.id === 'other')
    assert.equal(edited.slice(hit.start, hit.end), '@第三人')
    current.props.onCommit(edited, true)
    assert.equal(editor.props.card.prompt, prefix + '\n\n' + edited)
    assert.deepEqual(Array.from(editor.props.card.assetIds), ['guard', 'other'])

    editor.props.card.manuallyAdded = true
    await editPrompt(editor.nodes().find(n => n.type === menu), '')
    assert.equal(editor.nodes().find(n => n.type === menu).props['model-value'], '')
    assert.equal(editor.nodes().find(n => n.type === 'button' && n.props?.class === 'sv-button sv-primary').props.disabled, true)
  }
})

test('移除绑定也会从开场、逐镜配图和声音标注移除该素材', () => {
  const editor = setup(['guard', 'night'])
  Object.assign(editor.props.card, {
    openingAssetIds: ['guard', 'night'],
    prompt: '←承上：@侍卫 和 @侍卫_夜行 站在门边。\n镜头 01（0–3秒）\n画面与动作：@侍卫_夜行 推门。\n对白／音效：@侍卫_夜行：“随我来。”',
    shots: [{ id: 'shot', duration: 3, camera: '中景', action: '@侍卫_夜行 推门。', dialogue: '@侍卫_夜行：“随我来。”', visualAssetIds: ['guard', 'night'], speakerAssetIds: ['night'] }],
  })
  editor.nodes().find(n => n.props?.['aria-label'] === '移除参考素材 侍卫_夜行').props.onClick()
  assert.deepEqual(Array.from(editor.props.card.assetIds), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.excludedAssetIds ?? []), ['night'])
  assert.deepEqual(Array.from(editor.props.card.openingAssetIds ?? []), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.visualAssetIds ?? []), ['guard'])
  assert.deepEqual(Array.from(editor.props.card.shots[0]!.speakerAssetIds ?? []), [])
})

test('空片段可通过全项目 @ 菜单新增素材，移除后不影响同名前缀或配图顺序', async () => {
  const editor = setup([])
  editor.props.card.prompt = ''
  assert.ok(editor.nodes().some(n => n.children === '本片段尚无可用参考素材'))
  const textarea = editor.nodes().find(n => n.type === menu)
  assert.deepEqual(Array.from(textarea.props.options, (x: {value: string}) => x.value), ['侍卫','侍卫_夜行','第三人'])
  await editPrompt(textarea, '@第三人 离开。@侍卫_夜行 与 @侍卫 留下。')
  assert.deepEqual(editor.names(), ['移除参考素材 第三人', '移除参考素材 侍卫_夜行', '移除参考素材 侍卫'])
  editor.nodes().find(n => n.props?.['aria-label'] === '移除参考素材 侍卫').props.onClick()
  assert.deepEqual(editor.names(), ['移除参考素材 第三人', '移除参考素材 侍卫_夜行'])
  assert.equal(editor.props.card.prompt, '@第三人 离开。@侍卫_夜行 与 侍卫 留下。')
})

test('生成按钮说明资产、时长和提示词阻塞原因，切换标签也可见', () => {
  const editor = setup(['night'])
  const card = editor.props.card
  card.shots = [{ id: 'shot', duration: 31, camera: '中景', action: '侍卫入场', dialogue: '' }]
  card.prompt = '@没有登记的资产 入场。'
  card.promptNeedsSync = true
  for (const tab of ['正式分镜', '视频提示词', '连续性']) {
    editor.nodes().find(n => n.type === 'button' && n.children === tab).props.onClick()
    const nodes = editor.nodes()
    const footer = nodes.find(n => n.type === 'footer')
    const reason = flatten(footer).find(n => n.props?.role === 'status')
    const action = flatten(footer).find(n => n.type === 'button' && n.props?.class === 'sv-button sv-primary')
    const message = flatten(reason).filter(n => n.type === 'p').map(n => n.children).join('\n')
    assert.match(message, /找不到素材 @没有登记的资产/)
    assert.match(message, /超过单段 30 秒上限/)
    assert.match(message, /视频提示词待同步/)
    assert.equal(action.props.disabled, true)
    assert.equal(action.props['aria-describedby'], reason.props.id)
    assert.equal(nodes.filter(n => n.props?.id === reason.props.id).length, 1)
  }

  card.shots[0]!.duration = 3
  card.prompt = '@侍卫_夜行 入场。'
  card.promptNeedsSync = false
  const nodes = editor.nodes()
  assert.equal(nodes.find(n => n.type === 'button' && n.props?.class === 'sv-button sv-primary').props.disabled, false)
  assert.ok(!nodes.some(n => n.props?.id === 'editor-validation'))
})

test('编辑器只绑定当前镜头和说话者，保留正文引用的缩略图位置', async () => {
  const editor = setup([])
  editor.props.card.shots = [{ id: 'shot', duration: 3, camera: '中景', action: '侍卫入场', dialogue: '' }]
  const textarea = editor.nodes().find(n => n.type === menu)
  const prompt = [
    '画面与动作：@侍卫 入场。',
    '对白／音效：@侍卫_夜行：“@第三人 还要去找 @未登记的场景。”',
    '→衔接至视频编号02：下一段转到@未登记的场景。',
  ].join('\n')
  await editPrompt(textarea, prompt)
  textarea.props.onCommit(prompt)
  assert.deepEqual(editor.names(), ['移除参考素材 侍卫', '移除参考素材 侍卫_夜行'])
  assert.equal(editor.props.card.prompt, prompt)
  assert.equal(editor.nodes().find(n => n.type === 'button' && n.props?.class === 'sv-button sv-primary').props.disabled, false)
  const currentTextarea = editor.nodes().find(n => n.type === menu)
  const visual = currentTextarea.props['resolve-preview-ranges'](prompt).find((hit: { id: string }) => hit.id === 'guard')
  assert.equal(prompt.slice(visual.start, visual.end), '@侍卫')
})

test('视频提示词在对白和心声处显示音频引用，保存时保留原文', async () => {
  const assetList = assets.map(asset => ({
    ...asset, voiceAudio: { url: `/static/uploads/${asset.id}.wav`, name: `${asset.name}.wav` },
  }))
  const editor = setup(['guard', 'night', 'other'], { assetList })
  const original = [
    '镜头 01（0–3秒）',
    '画面与动作：@侍卫 和 @第三人 站在门边。',
    '对白／音效：@侍卫：“还没走。”；@侍卫_夜行（OS）：“我听见了。”',
  ].join('\n')
  editor.props.card.prompt = original
  const textarea = editor.nodes().find(n => n.type === menu)
  const displayed = textarea.props['model-value'] as string
  assert.match(displayed, /^画面与动作：@侍卫 和 @第三人 站在门边。$/mu)
  assert.match(displayed, /@侍卫 @音频1：“还没走。”；@侍卫_夜行 @音频2（OS）：“我听见了。”/u)
  const ranges = textarea.props['resolve-preview-ranges'](displayed) as { id: string; start: number; end: number }[]
  assert.deepEqual(Array.from(ranges)
    .filter(hit => hit.id.startsWith('voice-'))
    .map(hit => displayed.slice(hit.start, hit.end)), ['@音频1', '@音频2'])

  const edited = displayed.replace('还没走。', '快走吧。')
  await editPrompt(textarea, edited)
  textarea.props.onCommit(edited)
  assert.equal(editor.props.card.prompt, original.replace('还没走。', '快走吧。'))
  assert.match(editor.nodes().find(n => n.type === menu).props['model-value'], /@音频1.*快走吧。/u)
})

test('服务端规范的短 OS 首次显示音频与正确高亮，中文编辑保存保留原话和表演标记', async () => {
  const assetList = [assets[1]!, assets[2]!].map(asset => ({
    ...asset, voiceAudio: { url: '/static/uploads/' + asset.id + '.wav', name: asset.name + '.wav' },
  }))
  const editor = setup(['night', 'other'], { assetList })
  const original = [
    '镜头 01（0–3秒）',
    '画面与动作：@侍卫_夜行 和 @第三人 站在门边。',
    '对白／音效：@侍卫_夜行【克制】(OS) ：“第三人，先别走。”；@第三人【低声】：“我等你。”',
  ].join('\n')
  editor.props.card.prompt = original
  const field = () => editor.nodes().find(n => n.type === menu)
  const displayed = field().props['model-value'] as string
  assert.match(displayed, /@侍卫_夜行 @音频1【克制】\(OS\) ：“第三人，先别走。”/u)
  assert.match(displayed, /@第三人 @音频2【低声】：“我等你。”/u)
  assert.doesNotMatch(displayed, /内心 OS|角色闭口|嘴唇不动|不对口型/u)
  const ranges = field().props['resolve-preview-ranges'](displayed) as { start: number; end: number }[]
  assert.deepEqual(Array.from(ranges).map(hit => displayed.slice(hit.start, hit.end)),
    ['@侍卫_夜行', '@第三人', '@侍卫_夜行', '@音频1', '第三人', '@第三人', '@音频2'])

  field().props.onFocus()
  field().props.onCompositionstart()
  const edited = displayed.replace('先别走。', '先等等。')
  const composing = editPrompt(field(), edited)
  field().props.onCompositionend()
  await composing
  field().props.onCommit(edited, true)
  assert.equal(editor.props.card.prompt, original.replace('先别走。', '先等等。'))
  assert.match(field().props['model-value'], /@音频1【克制】\(OS\) ：“第三人，先等等。”/u)
  assert.match(field().props['model-value'], /@音频2【低声】：“我等你。”/u)
  assert.doesNotMatch(editor.props.card.prompt, /@音频\d+/u)
})

test('编辑续接对白的 OS 标记保留手写的内心字样和原有音色引用', async () => {
  const lead = { ...assets[0]!, voiceAudio: { url: '/static/uploads/guard.wav', name: '侍卫配音.wav' } }
  for (const marker of ['(内心OS)', '（内心 OS）', '内心 (OS)']) {
    const editor = setup(['guard'], { assetList: [lead] })
    const original = '镜头 01（0–3秒）\n画面与动作：@侍卫 站在门边。\n对白／音效：@侍卫（内心OS、续）【低沉／紧凑】 (OS)：“别回头。”'
    editor.props.card.prompt = original
    const field = () => editor.nodes().find(n => n.type === menu)
    field().props.onFocus()
    const displayed = field().props['model-value']
    assert.match(displayed, /@侍卫 @音频1（内心OS、续）/u)
    const edited = displayed.replace(' (OS)：', ` ${marker}：`)
    await editPrompt(field(), edited)
    field().props.onCommit(edited, true)
    assert.equal(editor.props.card.prompt, original.replace(' (OS)：', ` ${marker}：`))
    assert.equal(field().props['model-value'], edited)
  }
})

test('旧提示词首次打开即显示正式人物引用，预览位置和对白原话保持准确', () => {
  const editor = setup(['night', 'other'])
  const original = [
    '镜头 01（0–3秒）',
    '画面与动作：侍卫_夜行带第三人进门。',
    '对白／音效：侍卫_夜行：“第三人，跟上。”',
  ].join('\n')
  editor.props.card.prompt = original
  const textarea = editor.nodes().find(n => n.type === menu)
  const displayed = textarea.props['model-value'] as string
  assert.match(displayed, /画面与动作：@侍卫_夜行带@第三人进门。/u)
  assert.match(displayed, /对白／音效：@侍卫_夜行：“第三人，跟上。”/u)
  const ranges = textarea.props['resolve-preview-ranges'](displayed) as { id: string; start: number; end: number }[]
  assert.deepEqual(Array.from(ranges).map(hit => displayed.slice(hit.start, hit.end)),
    ['@侍卫_夜行', '@第三人', '@侍卫_夜行', '第三人'])
  textarea.props.onCommit(displayed, true)
  assert.equal(editor.props.card.prompt, displayed)
})

test('输入人物名自动补正式引用并映射光标，下一次编辑不会覆盖邻接文字', async () => {
  const editor = setup(['night'], { assetList: [{ ...assets[1]!, originalName: '侍卫' }] })
  editor.props.card.prompt = '画面与动作：门开。'
  const field = () => editor.nodes().find(n => n.type === menu)
  field().props.onFocus()
  const input = '画面与动作：侍卫推门。'
  const caret = '画面与动作：侍卫'.length
  const synced: unknown[][] = []
  field().ref.r.value = { syncDisplay: (...args: unknown[]) => synced.push(args) }
  field().props['onUpdate:modelValue'](input, { value: input, selectionStart: caret, selectionEnd: caret })
  const displayed = field().props['model-value'] as string
  assert.equal(displayed, '画面与动作：@侍卫_夜行推门。')
  assert.deepEqual(synced.at(-1)?.slice(0, 3), [displayed, caret + 4, caret + 4])
  const edited = displayed.replace('推门', '轻轻推门')
  await editPrompt(field(), edited)
  field().props.onCommit(edited, true)
  assert.equal(editor.props.card.prompt, edited)
})

test('回顾和独立生成中的人物写入正式引用与素材绑定，对白仅保留原话', async () => {
  const editor = setup(['night'])
  const original = [
    '前镜回顾：侍卫_夜行在门前站定。',
    '独立生成：第三人留在侍卫_夜行身侧。',
    '镜头 01（0–3秒）',
    '画面与动作：侍卫_夜行推门。',
    '对白／音效：侍卫_夜行：“第三人，跟上。”',
  ].join('\n')
  editor.props.card.prompt = original
  const field = () => editor.nodes().find(n => n.type === menu)
  const displayed = field().props['model-value'] as string
  assert.match(displayed, /前镜回顾：@侍卫_夜行在门前站定。/u)
  assert.match(displayed, /独立生成：@第三人留在@侍卫_夜行身侧。/u)
  assert.match(displayed, /对白／音效：@侍卫_夜行：“第三人，跟上。”/u)
  const edited = displayed.replace('在门前站定', '仍在门前站定')
  await editPrompt(field(), edited)
  assert.deepEqual(new Set(editor.props.card.assetIds), new Set(['night', 'other']))
  field().props.onCommit(edited, true)
  assert.equal(editor.props.card.prompt, edited)
  const ranges = field().props['resolve-preview-ranges'](edited) as { start: number; end: number }[]
  assert.deepEqual(Array.from(ranges).map(hit => edited.slice(hit.start, hit.end)),
    ['@侍卫_夜行', '@第三人', '@侍卫_夜行', '@侍卫_夜行', '@侍卫_夜行', '第三人'])
  const delivery = buildScriptVideoDelivery(editor.props.card, assets)
  assert.deepEqual(new Set(delivery.images.map(asset => asset.id)), new Set(['night', 'other']))
})

test('上传的项目音频是可选择的 @ 素材，填写后可预览并成为最终附件', async () => {
  const rain: preview.PreviewAsset = { id: 'rain', name: '素材-音频1', kind: 'audio', image: '',
    voiceAudio: { name: '音频1.wav', url: '/static/uploads/rain.wav' } }
  const editor = setup([], { assetList: [rain] })
  const field = () => editor.nodes().find(n => n.type === menu)
  const option = field().props.options.find((item: { id: string }) => item.id === rain.id)
  assert.equal(option.kind, 'audio')
  assert.equal(option.previewOnly, undefined)
  assert.equal(option.audioUrl, rain.voiceAudio!.url)

  const text = `对白／音效：〈远处渐响 @${option.value}〉`
  await editPrompt(field(), text)
  field().props.onCommit(text, true)
  assert.equal(editor.props.card.prompt, text)
  assert.deepEqual(Array.from(editor.props.card.assetIds), [rain.id])
  const range = field().props['resolve-preview-ranges'](text).find((item: { id: string }) => item.id === rain.id)
  assert.equal(text.slice(range.start, range.end), `@${rain.name}`)

  const delivery = buildScriptVideoDelivery(editor.props.card, [rain])
  assert.deepEqual(delivery.images, [])
  assert.equal(delivery.voices[0]?.asset.voiceAudio?.url, rain.voiceAudio!.url)
  assert.match(delivery.prompt, /远处渐响 @音频1/u)
})

test('视频提示词在同一行紧接的两段对白各引用一次音频', () => {
  const assetList = assets.map(asset => ({
    ...asset, voiceAudio: { url: `/static/uploads/${asset.id}.wav`, name: `${asset.name}.wav` },
  }))
  const editor = setup(['guard', 'other'], { assetList })
  const original = [
    '镜头 01（0–3秒）',
    '画面与动作：@侍卫 和 @第三人 站在门边。',
    '对白／音效：@侍卫【吩咐】：“带第三人进来。”第三人【领命】：“是！”',
  ].join('\n')
  editor.props.card.prompt = original
  const textarea = editor.nodes().find(n => n.type === menu)
  const displayed = textarea.props['model-value'] as string
  assert.match(displayed, /@侍卫 @音频1【吩咐】：“带第三人进来。”@第三人 @音频2【领命】：“是！”/u)
  const ranges = textarea.props['resolve-preview-ranges'](displayed) as { id: string; start: number; end: number }[]
  assert.deepEqual(Array.from(ranges)
    .filter(hit => hit.id.startsWith('voice-'))
    .map(hit => displayed.slice(hit.start, hit.end)), ['@音频1', '@音频2'])
  assert.equal(editor.props.card.prompt, original)
})

test('自动保存整理的提示词只在结束编辑后回填，编辑中的引用和换行保持原位', async () => {
  const editor = setup(['guard'])
  editor.props.card.prompt = '第一行\r\n画面与动作：@侍卫 守在门边。'
  await vue.nextTick()
  const editorField = () => editor.nodes().find(n => n.type === menu)
  editorField().props.onFocus()
  const typed = '@' + editorField().props['model-value']
  assert.equal(typed, '@第一行\n画面与动作：@侍卫 守在门边。')
  await editorField().props['onUpdate:modelValue'](typed, { value: typed, selectionStart: 1, selectionEnd: 1 })
  const stored = '统一风格\n\n' + typed
  editor.props.card = { ...editor.props.card, prompt: stored }
  await vue.nextTick()
  assert.equal(editorField().props['model-value'], typed)
  editorField().props.onCommit(typed, true)
  assert.equal(editorField().props['model-value'], stored)
  assert.equal(editor.props.card.prompt, stored)
})

test('编辑后失焦时，较早的属性回填不能盖掉刚输入的提示词', async () => {
  const editor = setup(['guard'])
  const field = () => editor.nodes().find(n => n.type === menu)
  const before = { ...editor.props.card, prompt: '镜头 09\n画面与动作：@侍卫 守在门边。' }
  editor.props.card = before
  field().props.onFocus()
  const edited = before.prompt.replace('守在门边', '走向城门')
  await editPrompt(field(), edited)

  editor.props.card = before
  await vue.nextTick()
  assert.equal(field().props['model-value'], edited)
  field().props.onCommit(edited, true)
  assert.equal(editor.props.card.prompt, edited)
  assert.equal(field().props['model-value'], edited)
})

test('没有待补引用的旧提示词失焦后保留原始换行', () => {
  const editor = setup(['guard'])
  const original = '镜头 01（0–3秒）\r\n画面与动作：@侍卫 推门。\r\n对白／音效：无对白。'
  editor.props.card.prompt = original
  const field = editor.nodes().find(n => n.type === menu)
  field.props.onFocus()
  field.props.onCommit(field.props['model-value'], true)
  assert.equal(editor.props.card.prompt, original)
})

test('编辑中的提示词在角色声音替换后立即试听新音频，保留原稿', async () => {
  const lead = { ...assets[0]!, voiceAudio: { url: '/static/uploads/old.wav', name: '原声.wav' } }
  const editor = setup(['guard'], { assetList: [lead] })
  const prompt = '镜头 01（0–3秒）\n画面与动作：@侍卫 站在门边。\n对白／音效：@侍卫：“走吧。”'
  editor.props.card.prompt = prompt
  const field = () => editor.nodes().find(n => n.type === menu)
  const audioUrl = () => field().props.options.find((option: { kind: string }) => option.kind === 'audio')?.audioUrl
  field().props.onFocus()
  const displayed = field().props['model-value']
  assert.equal(audioUrl(), '/static/uploads/old.wav')

  editor.props.assets = [{ ...lead, voiceAudio: { url: '/static/uploads/new.wav', name: '新声.wav' } }]
  await vue.nextTick()

  assert.equal(audioUrl(), '/static/uploads/new.wav')
  assert.equal(field().props['model-value'], displayed)
  field().props.onCommit(displayed, true)
  assert.equal(editor.props.card.prompt, prompt)
})

test('中文组合输入完成后才重算声音编号，且不把旧编号写入提示词', async () => {
  const [lead, other] = [assets[0]!, assets[2]!].map(asset => ({
    ...asset, voiceAudio: { url: `/static/uploads/${asset.id}.wav`, name: '参考.wav' },
  }))
  const editor = setup(['guard', 'other'], { assetList: [lead!, other!] })
  const prompt = '画面与动作：@侍卫 和 @第三人 站在门边。\n对白／音效：@侍卫：“走吧。”；@第三人：“好。”'
  editor.props.card.prompt = prompt
  const field = () => editor.nodes().find(n => n.type === menu)
  field().props.onFocus()
  field().props.onCompositionstart()
  const displayed = field().props['model-value'] as string
  assert.match(displayed, /@音频2/u)

  editor.props.assets = [{ ...lead!, voiceAudio: undefined }, other!]
  await vue.nextTick()
  assert.equal(field().props['model-value'], displayed)

  const composing = editPrompt(field(), displayed.replace('好。', '明白了。'))
  field().props.onCompositionend()
  await composing
  assert.equal(editor.props.card.prompt, prompt.replace('好。', '明白了。'))
  assert.doesNotMatch(field().props['model-value'], /@音频2/u)
  assert.match(field().props['model-value'], /第三人[^\n]*@音频1[^\n]*明白了。/u)
})

test('无外部状态时默认打开视频提示词，并保留本地切换', () => {
  const editor = setup([], { openPrompt: false })
  assert.deepEqual(editor.tabButtons().slice(0, 2).map(n => n.children), ['视频提示词', '正式分镜'])
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '视频提示词')
  editor.tabButtons().find(n => n.children === '正式分镜').props.onClick()
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '正式分镜')
  assert.deepEqual(editor.tabChanges, ['shots'])
})

test('外部恢复的编辑标签生效，AI 调整等编辑器内操作继续更新标签', () => {
  const editor = setup([], { tab: 'continuity', openPrompt: false })
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '连续性')
  assert.deepEqual(editor.tabChanges, [])
  editor.props.tab = 'prompt'
  assert.ok(editor.nodes().some(n => n.type === menu))
  const actions = editor.nodes().find(n => n.props?.class === 'sv-prompt-actions')
  const revise = flatten(actions).find(n => n.type === 'button' && Array.isArray(n.children) &&
    n.children.some((child: { children?: string }) => child.children?.includes('让 AI 调整')))
  revise.props.onClick()
  assert.equal(editor.props.tab, 'revise')
  editor.nodes().find(n => n.type === 'ScriptVideoPreviewRevision').props.onClose()
  assert.equal(editor.props.tab, 'prompt')
  assert.deepEqual(editor.tabChanges, ['revise', 'prompt'])
})

test('预览标签待成片可用后恢复，等待期间打开视频提示词并保留原选择', () => {
  const editor = setup([], { tab: 'preview', openPrompt: false })
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '视频提示词')
  assert.equal(editor.props.tab, 'preview')
  assert.deepEqual(editor.tabChanges, [])
  editor.props.card.videoUrl = '/static/videos/ready.mp4'
  editor.props.card.status = 'ready'
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '成片预览')
  assert.equal(editor.nodes().find(n => n.type === 'video').props.src, '/static/videos/ready.mp4')

  editor.props.card.status = 'draft'
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '上一版成片')
  assert.equal(editor.nodes().find(n => n.type === 'video').props.src, '/static/videos/ready.mp4')
  assert.equal(editor.nodes().find(n => n.type === 'a' && n.props.download?.endsWith('.mp4')).props.href, '/static/videos/ready.mp4')
  editor.tabButtons().find(n => n.children === '正式分镜').props.onClick()
  editor.props.card.status = 'ready'
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '正式分镜')
  assert.deepEqual(editor.tabChanges, ['shots'])
})

test('分镜没有成片链接时仍能预览已完成的任务，新成片就绪后优先播放新链接', () => {
  const previousUrl = '/static/videos/previous.mp4'
  const editor = setup([], { openPrompt: false, completedTaskVideoUrl: previousUrl })
  editor.tabButtons().find(n => n.children === '上一版成片').props.onClick()
  assert.equal(editor.nodes().find(n => n.type === 'video').props.src, previousUrl)
  assert.equal(editor.props.card.videoUrl, undefined)
  assert.equal(editor.props.card.status, 'draft')

  const currentUrl = '/static/videos/current.mp4'
  editor.props.card.videoUrl = currentUrl
  editor.props.card.status = 'ready'
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '成片预览')
  assert.equal(editor.nodes().find(n => n.type === 'video').props.src, currentUrl)
})
