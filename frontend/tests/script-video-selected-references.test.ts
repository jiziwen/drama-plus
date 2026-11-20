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
import { getScriptVideoPromptVoices } from '../../backend/src/services/script-video-delivery'

const filename = 'ScriptVideoPreviewEditor.vue'
const source = readFileSync(new URL('../app/components/' + filename, import.meta.url), 'utf8')
const script = compileScript(parse(source, {filename}).descriptor, {id: 'editor', inlineTemplate: true})
const { outputText } = ts.transpileModule(script.content, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}})
const component: any = {}
const menu = { name: 'MentionTextarea' }
const modules: Record<string, unknown> = {
  vue: { ...vue, useId: () => 'editor-validation', resolveComponent: (name: string) => name, withDirectives: (node: unknown) => node },
  'lucide-vue-next': { Eye: 'Eye', Sparkles: 'Sparkles', X: 'X' },
  './MentionTextarea.vue': { default: menu },
  '~/utils/scriptVideoPreview': preview,
  '~/utils/scriptVideoPromptVoiceView': promptVoiceView,
  '~/utils/scriptVideoPreviewValidation': validation,
  '../../../backend/src/services/script-video-delivery': { getScriptVideoPromptVoices },
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
  const props = vue.reactive({card, assets: assetList, outputMode:'internal', tab, completedTaskVideoUrl})
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
  assert.match(status('侍卫_夜行'), /仅文本提及/)
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
  assert.match(status('侍卫_夜行'), /仅文本提及/)
  assert.doesNotMatch(status('侍卫'), /配图/)
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
  assert.match(displayed, /@侍卫（音色参考@音频1）：“还没走。”；@侍卫_夜行（音色参考@音频2）（OS）：“我听见了。”/u)
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
  assert.match(displayed, /@侍卫（音色参考@音频1）【吩咐】：“带第三人进来。”第三人（音色参考@音频2）【领命】：“是！”/u)
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

test('无外部状态时默认打开正式分镜，并保留本地切换', () => {
  const editor = setup([], { openPrompt: false })
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '正式分镜')
  editor.tabButtons().find(n => n.children === '视频提示词').props.onClick()
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '视频提示词')
  assert.deepEqual(editor.tabChanges, ['prompt'])
})

test('外部恢复的编辑标签生效，AI 调整等编辑器内操作继续更新标签', () => {
  const editor = setup([], { tab: 'continuity', openPrompt: false })
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '连续性')
  assert.deepEqual(editor.tabChanges, [])
  editor.props.tab = 'prompt'
  assert.ok(editor.nodes().some(n => n.type === menu))
  const actions = editor.nodes().find(n => n.props?.class === 'sv-prompt-actions')
  const revise = flatten(actions).find(n => n.type === 'button')
  revise.props.onClick()
  assert.equal(editor.props.tab, 'revise')
  editor.nodes().find(n => n.type === 'ScriptVideoPreviewRevision').props.onClose()
  assert.equal(editor.props.tab, 'prompt')
  assert.deepEqual(editor.tabChanges, ['revise', 'prompt'])
})

test('预览标签待成片可用后恢复，等待期间回到正式分镜并保留原选择', () => {
  const editor = setup([], { tab: 'preview', openPrompt: false })
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '正式分镜')
  assert.equal(editor.props.tab, 'preview')
  assert.deepEqual(editor.tabChanges, [])
  editor.props.card.videoUrl = '/static/videos/ready.mp4'
  editor.props.card.status = 'ready'
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '成片预览')
  assert.equal(editor.nodes().find(n => n.type === 'video').props.src, '/static/videos/ready.mp4')

  editor.props.card.status = 'draft'
  assert.equal(editor.tabButtons().find(n => n.props['aria-pressed']).children, '上一版成片')
  assert.equal(editor.nodes().find(n => n.type === 'video').props.src, '/static/videos/ready.mp4')
  assert.equal(editor.nodes().find(n => n.type === 'a' && n.props.download === '').props.href, '/static/videos/ready.mp4')
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
