import assert from 'node:assert/strict'
import test from 'node:test'
import { findPreviewAssetMentions } from '../app/utils/scriptVideoPreviewMentions'
import type { PreviewAsset } from '../app/utils/scriptVideoPreview'

function character(id: string, name: string): PreviewAsset {
  return { id, name, kind: 'character', image: id + '.png' }
}

test('中文镜头描述中优先引用最长已知名称，姓名后可直接衔接动作', () => {
  const assets = [character('short', '侍卫'), character('long', '侍卫长'), character('variant', '侍卫长_礼服')]
  const text = '镜头从@侍卫长_礼服向左拉开，@侍卫长低头，@侍卫抬手。'
  const result = findPreviewAssetMentions(text, assets)
  assert.deepEqual(result.assetIds, ['variant', 'long', 'short'])
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.mentions.map(hit => text.slice(hit.start, hit.end)), ['@侍卫长_礼服', '@侍卫长', '@侍卫'])
})

test('空格、括号、斜杠与逗号都是已知文件名的一部分，范围精确覆盖名称', () => {
  const assets = [
    character('frank', 'Frank Lee (young, night)'),
    character('bowl', '道具/药碗（青釉，裂纹）'),
  ]
  const text = '🎬 @Frank Lee (young, night) turns to @道具/药碗（青釉，裂纹）。'
  const result = findPreviewAssetMentions(text, assets)
  assert.deepEqual(result.unknown, [])
  assert.deepEqual(result.assetIds, ['frank', 'bowl'])
  assert.deepEqual(result.mentions.map(hit => text.slice(hit.start, hit.end)), assets.map(asset => '@' + asset.name))
})

test('未导入的造型名称不能误绑为任何较短的基础角色', () => {
  const assets = [character('short', '侍卫'), character('long', '侍卫长'), character('frank', 'Frank')]
  const result = findPreviewAssetMentions('@侍卫长_夜行服，@Frank-hooded，@侍卫_便装。', assets)
  assert.deepEqual(result.assetIds, [])
  assert.deepEqual(result.mentions, [])
  assert.deepEqual(result.unknown, ['侍卫长_夜行服', 'Frank-hooded', '侍卫_便装'])
})

test('重复引用保留每处文本位置，只绑定一次，未知引用单独报告', () => {
  const assets = [character('lead', '阿梨'), character('guard', '侍卫甲')]
  const text = '@阿梨回头。@未导入，@侍卫甲进门，@阿梨关门；@未导入。@unknown。'
  const result = findPreviewAssetMentions(text, assets)
  assert.deepEqual(result.assetIds, ['lead', 'guard'])
  assert.deepEqual(result.unknown, ['未导入', 'unknown'])
  assert.deepEqual(result.mentions.map(hit => text.slice(hit.start, hit.end)), ['@阿梨', '@侍卫甲', '@阿梨'])
})
