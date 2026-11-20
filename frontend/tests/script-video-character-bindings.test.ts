import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import * as identities from '../../backend/src/services/script-video-asset-identity'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const setup = parse(page).descriptor.scriptSetup!.content
const tree = ts.createSourceFile('page.ts', setup, ts.ScriptTarget.Latest)
const handlers = tree.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['chooseBinding', 'characterSummaryMatcher', 'summarizeAIError'].includes(node.name?.text || ''))
const { outputText } = ts.transpileModule(handlers.map(node => node.getText(tree)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

function character(id: string, originalName: string, name: string) {
  return { id, kind: 'character', originalName, name, sourcePath: '七天_素材/角色/' + id + '/' + originalName + '.png' }
}
const medics = character('北蛮随军军医', '群体', '群体')
const officers = character('锦衣卫众', '群体', '七天_素材/角色/锦衣卫众/群体')
const guards = character('阿勒图雅亲卫', '群体', '七天_素材/角色/阿勒图雅亲卫/群体')
function card(id: string, summary: string, assetIds: string[]) {
  return { id, summary, assetIds, version: 1 }
}
function bindingPage(assets: Array<ReturnType<typeof character>>, initial: Array<ReturnType<typeof card>>, global = true) {
  const cards = {value: initial}
  const controls = runInNewContext(outputText + '\n;({chooseBinding,summarizeAIError})', {
    ...identities, assets: {value: assets}, cards,
    selectedCard: {get value() { return cards.value[0] }},
    currentEpisode: {value: {outlineConfirmed: true}}, bindCharacterToEpisode: {value: global},
  })
  return {cards, ...controls}
}

test('大纲资产选择保留多个目录群体，其他片段与稳定 @ 引用保持原样', () => {
  const medicalCard = card('医官', '群体围观。', [medics.id])
  const guardCard = card('亲卫', '阿勒图雅亲卫停步。', [guards.id])
  const ui = bindingPage([officers, medics, guards], [
    card('入宫', '锦衣卫众和北蛮随军军医到场。\n【待确认造型】北蛮随军军医/群体', [medics.id, guards.id]),
    medicalCard, guardCard, card('守门', '锦衣卫众集结。', []),
  ])
  ui.chooseBinding(officers)
  assert.deepEqual(Array.from(ui.cards.value[0].assetIds), [medics.id, guards.id, officers.id])
  assert.ok(ui.cards.value[0].summary.includes('绑定 @' + officers.name + '。'))
  assert.ok(ui.cards.value[0].summary.includes('【待确认造型】北蛮随军军医/群体'))
  assert.equal(ui.cards.value[1], medicalCard)
  assert.equal(ui.cards.value[2], guardCard)
  assert.deepEqual(Array.from(ui.cards.value[3].assetIds), [officers.id])
  ui.chooseBinding(officers)
  assert.deepEqual(Array.from(ui.cards.value[0].assetIds), [medics.id, guards.id])
  assert.deepEqual(Array.from(ui.cards.value[3].assetIds), [])
  assert.equal(ui.cards.value[1], medicalCard)
  assert.ok(!ui.cards.value[0].summary.includes('绑定 @' + officers.name))
})

test('全局换装只影响同一人，角色名前缀相同的亲卫群体单独保留', () => {
  const basic = {id: '常服', name: '阿勒图雅', kind: 'character', sourcePath: '七天_素材/角色/阿勒图雅.png', originalName:'阿勒图雅'}
  const costume = {...basic, id: '红衣', name: '阿勒图雅_红衣', originalName: '阿勒图雅_红衣', sourcePath: '七天_素材/角色/阿勒图雅_红衣.png'}
  const unrelated = card('亲卫', '阿勒图雅亲卫到场。', [guards.id])
  for (const global of [true, false]) {
    const ui = bindingPage([basic, costume, guards], [
      card('换装', '阿勒图雅换装。', ['道具', basic.id, guards.id]), unrelated, card('到场', '阿勒图雅入场。', []),
    ], global)
    ui.chooseBinding(costume)
    assert.deepEqual(Array.from(ui.cards.value[0].assetIds), ['道具', costume.id, guards.id])
    assert.equal(ui.cards.value[1], unrelated)
    assert.deepEqual(Array.from(ui.cards.value[2].assetIds), global ? [costume.id] : [])
  }
})

test('真人与小剧场同镜时分别替换造型并保留各自的绑定说明', () => {
  const appearance = (id: string, name: string) => ({
    id, name, kind: 'character', originalName: name, sourcePath: '七天_素材/角色/' + name + '.png',
  })
  const live = appearance('live', '咖妃')
  const dressed = appearance('dressed', '咖妃_宫装')
  const chibi = appearance('chibi', '咖妃_3DQ版')
  const chibiDressed = appearance('chibi-dressed', '咖妃_3DQ版_宫装')
  const bind = (asset: typeof live) => '【已确认人物造型】咖妃 绑定 @' + asset.name + '。'
  const ui = bindingPage([live, dressed, chibi, chibiDressed], [
    card('同镜', '小咖妃跳到咖妃肩头。\n' + bind(live) + '\n' + bind(chibi), [live.id, chibi.id]),
    card('真人', '小咖妃是昵称，真人咖妃坐在榻边。', [live.id]),
    card('小剧场', '3DQ版小咖妃举起小木牌。', []),
  ])
  ui.chooseBinding(dressed)
  assert.deepEqual(Array.from(ui.cards.value[0].assetIds), [dressed.id, chibi.id])
  assert.ok(ui.cards.value[0].summary.includes(bind(chibi)))
  assert.ok(ui.cards.value[0].summary.includes(bind(dressed)))
  assert.ok(!ui.cards.value[0].summary.includes(bind(live)))
  ui.chooseBinding(chibiDressed)
  assert.deepEqual(Array.from(ui.cards.value[0].assetIds), [dressed.id, chibiDressed.id])
  assert.deepEqual(Array.from(ui.cards.value[1].assetIds), [dressed.id])
  assert.deepEqual(Array.from(ui.cards.value[2].assetIds), [chibiDressed.id])
  assert.ok(ui.cards.value[0].summary.includes(bind(dressed)))
  assert.ok(ui.cards.value[0].summary.includes(bind(chibiDressed)))
})

test('状态提示说明失败原因，长候选列表仅在详情呈现', () => {
  const {summarizeAIError} = bindingPage([], [])
  const error = '请确定七天的造型：' + [officers, guards].map(asset => asset.name).join('、').repeat(60)
  assert.equal(summarizeAIError(error), '上次 AI 编排要求确认人物造型。')
  assert.equal(summarizeAIError('模型输出格式不完整。；cards.0.duration 应为数字'), 'cards.0.duration 应为数字')
  assert.ok(summarizeAIError('模型连接失败 ' + 'a'.repeat(200)).length <= 60)
})

test('旧时长取舍显示可重新生成，涉及人物身份的澄清仍按原问题展示', () => {
  const {summarizeAIError} = bindingPage([], [])
  const history = '本集为单一场景，共27句对白。最小排法实测约需 210 秒，比原稿预计120秒多约90秒。请确认取舍：A. 按约210秒编排；B. 压到约180秒。'
  assert.equal(summarizeAIError(history), '上次编排因时长确认暂停，可重新生成。')
  assert.match(summarizeAIError('已确认大纲中有两段台词无法在30秒内按自然语速完整说完。请确认处理方式。'), /再次生成时会自动调整分段/)
  const characterQuestion = '预计时长120秒。请确认取舍：这句台词由顾凌天还是周虎说？'
  assert.equal(summarizeAIError(characterQuestion), characterQuestion)
})
