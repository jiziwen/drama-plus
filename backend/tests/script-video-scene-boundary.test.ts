import assert from 'node:assert/strict'
import test from 'node:test'
import { getScriptVideoContinuationScene } from '../src/services/script-video-scene-boundary.js'
import type { ScriptVideoAsset, ScriptVideoCard } from '../src/services/script-video-types.js'

const courtyard = { id: 'yard', name: '京城皇宫-偏殿院落', kind: 'scene' }
const hall = { id: 'hall', name: '京城皇宫-瑶华宫大殿', kind: 'scene' }
const assets = [courtyard, hall]
const state = '顾凌天右手向前伸出，掌心未与小旗接触。'
const camera = '近景｜平视｜固定机位，顾凌天居中'

function card(input: Partial<ScriptVideoCard> = {}): ScriptVideoCard {
  return {
    id: 'card', title: '片段', summary: '事件', combat: false, duration: 8, version: 1, status: 'draft',
    assetIds: [courtyard.id], scene: `场号51-01｜${courtyard.name}（唯一空间）｜日间`,
    opening: '', ending: state, prompt: '',
    shots: [{ id: 's', duration: 8, camera, action: state, dialogue: '无对白。' }],
    ...input,
  }
}

test('paired same-shot notes continue in the same named space without requiring matching prose', () => {
  const previous = card({ scene: `场景一：${hall.name}｜日间；切换场景二：${courtyard.name}｜日间`, assetIds: ['yard', 'hall'],
    ending: '顾凌天的手臂仍停在半空。下一段从本段尾帧继续。' })
  const next = card({ opening: '同一镜头续接上一段尾帧，顾凌天右手开始向上。', scene: `场景一：${courtyard.name}；场景二：${hall.name}` })
  assert.equal(getScriptVideoContinuationScene(previous, next, assets), courtyard)
  assert.equal(getScriptVideoContinuationScene({ ...previous, scene: hall.name }, next, assets), undefined)
  assert.equal(getScriptVideoContinuationScene({ ...previous, ending: state }, next, assets), undefined)
})

test('an opening cut, different camera scale or story-only handoff never adopts the previous tail', () => {
  const positiveOpening = `同一镜头续接上一段尾帧，${state}`
  const nextWith = (firstCamera: string, action = state) => card({ opening: positiveOpening,
    shots: [{ id: 's', duration: 8, camera: firstCamera, action, dialogue: '无对白。' }] })
  assert.equal(getScriptVideoContinuationScene(card(), nextWith('全景｜平视｜固定机位'), assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), nextWith('近景｜平视｜反打'), assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), nextWith(camera, '首镜硬切到顾凌天同伴。'), assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), nextWith(camera, '画面切至' + courtyard.name + '。'), assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), card({ opening: '仅延续上一段的剧情，其余重新起镜。' }), assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), card({ opening: '←承上视频编号01：顾凌天来到房门前。' }), assets), undefined)
})

test('edited 承上 and 衔接 instructions override structured text and may explicitly rule out a tail', () => {
  const from = card({ ending: state, prompt: `→衔接：${state}下一段切到另一机位。` })
  const to = card({ opening: `同一镜头续接上一段尾帧。${state}` })
  assert.equal(getScriptVideoContinuationScene(from, to, assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card({ ending: '下一段不使用本段尾帧。' }), to, assets), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), { ...to, prompt: '←承上：不使用上一段尾帧。' }, assets), undefined)

  const editedCamera = to.prompt + '\n镜头 01（0–8秒）\n景别／机位／运动：特写，顾凌天正面\n画面与动作：' + state
  assert.equal(getScriptVideoContinuationScene(card(), { ...to, prompt: editedCamera }, assets), undefined)
})

test('an outgoing same-shot instruction must agree with the next opening and the real final frame', () => {
  const prev = card({ ending: `下一段从本段尾帧继续。${state}` })
  const shot = { ...prev.shots[0], camera: `${camera}，继续固定构图` }
  const next = card({ opening: `←承上：${state}`, shots: [shot] })
  assert.equal(getScriptVideoContinuationScene(prev, next, assets), courtyard)
  assert.equal(getScriptVideoContinuationScene(prev, { ...next, opening: '←承上：角色走到院门外。' }, assets), undefined)
})

test('legacy handoff requires matching actual content and camera description', () => {
  const previous = card({ ending: `→衔接至视频编号02：${state}` })
  const next = card({ opening: `←承上视频编号01：${state}顾凌天继续向前。` })
  assert.equal(getScriptVideoContinuationScene(previous, next, assets), courtyard)
  assert.equal(getScriptVideoContinuationScene(previous, { ...next, opening: `${next.opening}同场切镜。` }, assets), undefined)
  assert.equal(getScriptVideoContinuationScene(previous, { ...next, opening: `${next.opening}不要同场切镜。` }, assets), courtyard)
  const cameraChange = { ...next, shots: [{ ...next.shots[0], camera: '近景｜平视｜固定，切到小旗半侧脸' }] }
  assert.equal(getScriptVideoContinuationScene(previous, cameraChange, assets), undefined)
  const futureOnly = card({ ending: '下一段开始时顾凌天站在院门外检查锁链。' })
  assert.equal(getScriptVideoContinuationScene(futureOnly, { ...next, opening: '←承上：顾凌天站在院门外检查锁链。' }, assets), undefined)
})

test('same-name scene assets remain ambiguous unless both cards bind to the same identity', () => {
  const duplicate: ScriptVideoAsset = { ...courtyard, id: 'duplicate' }
  const next = card({ opening: `同一镜头续接上一段尾帧。${state}` })
  assert.equal(getScriptVideoContinuationScene(card(), next, [...assets, duplicate]), courtyard)
  assert.equal(getScriptVideoContinuationScene(card(), { ...next, assetIds: ['duplicate'] }, [...assets, duplicate]), undefined)
  assert.equal(getScriptVideoContinuationScene(card(), { ...next, assetIds: ['yard', 'duplicate'] }, [...assets, duplicate]), undefined)
})

test('the same explicit, unambiguous location can continue without a scene image', () => {
  const scene = '东厢房'
  const previous = card({ scene, assetIds: [], ending: '下一段从本段尾帧继续。' })
  const next = card({ scene, assetIds: [], opening: '同一镜头续接上一段尾帧。' })
  assert.deepEqual(getScriptVideoContinuationScene(previous, next, []), { id: `scene-label:${scene}`, name: scene })
  assert.equal(getScriptVideoContinuationScene(previous, { ...next, scene: '西厢房' }, []), undefined)
  for (const uncertain of ['同上', '待定', '东厢房、走廊']) {
    assert.equal(getScriptVideoContinuationScene({ ...previous, scene: uncertain }, { ...next, scene: uncertain }, []), undefined)
  }
})

test('跨集承接说明识别上集尾帧与下集续接，保留切镜和禁用判断', () => {
  const previous = card({ ending: `${state}下一集从本集尾帧继续。` })
  const next = card({ opening: `同一镜头续接上集尾帧。${state}` })
  assert.equal(getScriptVideoContinuationScene(previous, next, assets), courtyard)
  assert.equal(getScriptVideoContinuationScene(previous, { ...next, opening: '不使用上一集尾帧。' }, assets), undefined)
  assert.equal(getScriptVideoContinuationScene({ ...previous, ending: `${state}下集切到另一机位。` }, next, assets), undefined)
})
