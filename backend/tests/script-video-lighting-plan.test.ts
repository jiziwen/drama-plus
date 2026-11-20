import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScriptVideoLightingPlan } from '../src/services/script-video-lighting-plan.js'

const assets = [{ id: 'yard', name: '偏殿院落', kind: 'scene' }, { id: 'hall', name: '瑶华宫', kind: 'scene' }]
const script = [
  '**场次**：54-01', '**场景**：偏殿院落', '**时间**：日间巳时', '**天气/环境**：阳光照射，青砖地面',
  '△画面：偏殿院落内，阳光照在青砖地面上。',
  '**场次**：54-02', '**场景**：瑶华宫', '**时间**：日间巳时', '**天气/环境**：殿内光线幽静，雕花窗',
].join('\n')
function card(id: string, scene: string, actions: string[], prompt = '') {
  return { id, scene, assetIds: ['yard', 'hall'], prompt, shots: actions.map((action, i) => ({
    id: id + i, camera: '中景固定', action, duration: 2, dialogue: '无对白。',
  })) }
}

test('同一场戏的反打与跨卡共享光线，明确的实际转场镜只从切点起采用新场光线', () => {
  const a = card('a', '场景：偏殿院落｜日间巳时', ['人物站在廊下。'])
  const b = card('b', '场景一：偏殿院落｜日间巳时；切换场景二：瑶华宫｜日间巳时', [
    '切到人物反打。', '人物看向瑶华宫方向。', '画面切入瑶华宫。', '烛台旁的人起身。',
  ])
  const c = card('c', '场号54-02｜瑶华宫（唯一空间）｜日间巳时', ['演员微笑。'])
  const result = buildScriptVideoLightingPlan([a, b, c], script, assets)
  assert.deepEqual(result.b.map(x => [x.sceneName, x.firstShot, x.lastShot, x.startSeconds, x.endSeconds, x.stableStartSeconds, x.stableEndSeconds]), [
    ['偏殿院落', 1, 2, 0, 4, 0, 4], ['瑶华宫', 3, 4, 4, 8, 6, 8],
  ])
  assert.equal(result.b[1].transitionIn, true)
  assert.equal(result.a[0].sceneKey, result.b[0].sceneKey)
  assert.equal(result.b[1].sceneKey, result.c[0].sceneKey)
  assert.match(result.b[0].lighting, /阳光照在青砖地面上/)
  assert.match(result.b[1].lighting, /殿内光线幽静/)
  assert.doesNotMatch(result.b[1].lighting, /阳光/)
})

test('新分镜的明确镜号范围适用于同地不同时段，并避开过渡镜', () => {
  const a = card('a', '场景一：偏殿院落｜日间巳时｜镜头1–2；场景二：偏殿院落｜深夜｜镜头3–4（镜头3转场）', ['站定。', '说话。', '叠化到夜。', '打灯。'])
  const b = card('b', '偏殿院落｜深夜', ['举起灯。'])
  const r = buildScriptVideoLightingPlan([a, b], script, assets)
  assert.equal(r.a.length, 2)
  assert.notEqual(r.a[0].sceneKey, r.a[1].sceneKey)
  assert.equal(r.a[1].sceneKey, r.b[0].sceneKey)
  assert.equal(r.a[1].stableStartSeconds, 6)
  assert.doesNotMatch(r.a[1].lighting, /阳光|日间/)
})

test('以编辑后的正式镜头为准，不把听见或看向另一地点当作切场', () => {
  const edited = card('e', '场景一：偏殿院落；场景二：瑶华宫', ['画面切至瑶华宫。', '人站起。', '人坐下。'],
    '镜头 01（0–2秒）\n画面与动作：两人看向瑶华宫；尚未切至瑶华宫。\n对白／音效：切至瑶华宫。\n' +
    '镜头 02（2–4秒）\n画面与动作：听到远处瑶华宫传来的脚步。\n' +
    '镜头 03（4–6秒）\n画面与动作：\n镜头切至瑶华宫。')
  const r = buildScriptVideoLightingPlan([edited], script, assets).e
  assert.deepEqual(r.map(x => [x.firstShot, x.lastShot]), [[1, 2], [3, 3]])
  assert.equal(r[1].stableStartSeconds, r[1].stableEndSeconds)
})

test('模糊地点、未定位的多场切点和歧义资产不会误用光线参考', () => {
  const ambiguous = card('a', '场景一：偏殿院落；场景二：瑶华宫', ['人物回头。', '人物起身。'])
  const missing = card('b', '场景一：偏殿院落；场景二：待定', ['人物回头。', '人物起身。'])
  const duplicate = card('c', '偏殿院落', ['人物起身。'])
  duplicate.assetIds.push('duplicate')
  const r = buildScriptVideoLightingPlan([ambiguous, missing, duplicate], script, [...assets, { ...assets[0], id: 'duplicate' }])
  assert.deepEqual(r.a, [])
  assert.deepEqual(r.b, [])
  assert.deepEqual(r.c, [])
})

test('同场真实光源变化建立新基准，跨卡保留变化后的状态', () => {
  const a = card('a', '偏殿院落｜日间巳时', ['站在廊下。', '廊下灯火骤然熄灭。', '侧身反打。'])
  const b = card('b', '偏殿院落｜日间巳时', ['换到人物对面。'])
  const r = buildScriptVideoLightingPlan([a,b], script, assets)
  assert.notEqual(r.a[0].sceneKey, r.a[1].sceneKey)
  assert.equal(r.a[1].sceneKey, r.b[0].sceneKey)
  assert.equal(r.a[1].stableStartSeconds, 4)
  assert.match(r.b[0].lighting, /灯火骤然熄灭/u)
})

test('旧大纲卡缺镜头、提示词、资产或时长时不妨碍另一段生成', () => {
  const ready = card('ready', '偏殿院落｜日间巳时', ['人物回头。'])
  const r = buildScriptVideoLightingPlan([{ id: 'empty' }, { id: 'old', scene: '偏殿院落', shots: ready.shots }, ready], '', [])
  assert.deepEqual(r.empty, [])
  assert.equal(r.old[0].sceneName, '偏殿院落')
  assert.equal(r.ready[0].sceneName, '偏殿院落')
})

test('同一院落的日照区变化与次日跳时各有独立基准', () => {
  const a = card('a', '偏殿院落｜清晨', ['他站在廊下。', '他从廊下走入阳光。', '反打，保持走位。', '次日深夜，他提着灯入画。'])
  const r = buildScriptVideoLightingPlan([a], '', assets).a
  assert.equal(new Set(r.map(x => x.sceneKey)).size, 3)
  assert.deepEqual(r.map(x => [x.firstShot, x.lastShot, x.stableStartSeconds]), [[1, 1, 0], [2, 3, 4], [4, 4, 8]])
  assert.match(r[2].lighting, /深夜/)
})

test('旧卡场景栏只有起始场景，仍按实际镜头中的明确切场结束旧光线', () => {
  const old = card('old', '偏殿院落', ['人站在廊下。', '视线转至瑶华宫。', '画面切入瑶华宫。'])
  const r = buildScriptVideoLightingPlan([old], script, assets).old
  assert.deepEqual(r.map(x => [x.sceneName, x.firstShot, x.lastShot]), [['偏殿院落', 1, 2], ['瑶华宫', 3, 3]])
})

test('同名同一时段有多场戏时按剧本天气选中正确场次，光线变化后改用新基准', () => {
  const weatherScript = ['场次：1-01', '场景：偏殿院落', '时间：白天', '天气：晴天',
    '场次：1-02', '场景：偏殿院落', '时间：白天', '天气：大雨'].join('\n')
  const cards = [card('a', '偏殿院落｜白天，晴天', ['站在门口。']),
    card('b', '偏殿院落｜白天，大雨', ['雨幕中的人。']), card('c', '场号1-02｜偏殿院落｜白天', ['反打。'])]
  for (const source of [weatherScript, '']) {
    const r = buildScriptVideoLightingPlan(cards, source, assets)
    assert.notEqual(r.a[0].sceneKey, r.b[0].sceneKey)
    assert.doesNotMatch(r.b[0].lighting, /晴/)
    if (source) assert.equal(r.b[0].sceneKey, r.c[0].sceneKey)
  }
})

test('切走再回到原剧本同一场次时复用基准，同名但无场次的地点不跨切点猜测', () => {
  const boards = [card('a', '偏殿院落', ['上场。']), card('b', '瑶华宫', ['上场。']), card('c', '偏殿院落', ['坐下。'])]
  const numbered = buildScriptVideoLightingPlan(boards, script, assets)
  assert.equal(numbered.a[0].sceneKey, numbered.c[0].sceneKey)
  const unnamed = buildScriptVideoLightingPlan(boards, '', assets)
  assert.notEqual(unnamed.a[0].sceneKey, unnamed.c[0].sceneKey)
})
