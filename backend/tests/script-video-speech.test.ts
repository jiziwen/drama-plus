import assert from 'node:assert/strict'
import test from 'node:test'
import { assertScriptVideoCards } from '../src/services/script-video-types.js'

test('silent performance and labelled gun foley are not invented dialogue', () => {
  const card = { id: 'one', title: '屏息', summary: '顾凌天闭眼屏息。', duration: 2, assetIds: [], combat: false, prompt: '总时长：2秒\n顾凌天闭眼屏息，枪声从院外传来。', status: 'draft' as const, version: 1, shots: [{ id: 'shot', duration: 2, camera: '近景／平视／固定', action: '顾凌天闭眼屏息。', dialogue: '顾凌天【屏息未出声】：鼻息压得极轻，几乎听不见。\n枪声：一记短促爆响，在院落外炸出回音。' }] }
  assert.doesNotThrow(() => assertScriptVideoCards({ cards: [card], script: '△画面：顾凌天闭眼屏息，院外响枪。', assets: [] }))
})
