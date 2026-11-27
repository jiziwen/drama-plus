import assert from 'node:assert/strict'
import test from 'node:test'
import {
  scriptVideoAssetImagePrompt, scriptVideoMidjourneySceneDescription, scriptVideoMidjourneyScenePrompt,
} from '../src/services/script-video-asset-image-prompt.js'

test('MJ 将场景档案压成四机位画面描述，保留空间细节并去掉通用排版说明', () => {
  const dossier = [
    '[0.画风与光影]：全局采用3D国漫仙侠，精细PBR哑光青石。',
    '[1.空间档案]：场景名：听雪楼-入门仪式台；类型：雪山露天高台；纯原创虚构环境与建筑美术设计。',
    '[2.建筑骨架]：北侧冰壁下为宽12米的青石高台，南侧九级白玉石阶落向积雪小径。',
    '[3.五方十字坐标陈设]：①西侧为青石剑碑；②东侧为霜林。',
    '[4.光影与色彩]：淡金晨光穿过冷蓝寒雾，精细PBR哑光青石。',
  ].join('\n')
  const savedPrompt = scriptVideoAssetImagePrompt('scene', dossier, '听雪楼')
  const prompt = scriptVideoMidjourneyScenePrompt(savedPrompt)

  assert.match(prompt, /同一空景的 2×2 场景设定图/u)
  assert.match(prompt, /左上入口向内正视 "FRONT"，右上从左侧 90° 平视 "SIDE"，左下朝入口 180° 反打 "REVERSE"，右下 45° 全局俯视 "OVERVIEW"/u)
  for (const detail of ['3D国漫仙侠', 'PBR哑光青石', '听雪楼-入门仪式台', '北侧冰壁', '宽12米', '南侧九级白玉石阶', '西侧青石剑碑', '东侧霜林', '淡金晨光穿过冷蓝寒雾']) {
    assert.ok(prompt.includes(detail), detail)
  }
  assert.doesNotMatch(prompt, /\[\d|【|场景名：|类型：|①|②|左上角仅标注|全局采用|原创虚构/u)
  assert.equal(prompt.match(/精细PBR哑光青石/gu)?.length, 1)
  assert.match(prompt, /--no people, watermarks$/u)
  assert.ok(prompt.length < savedPrompt.length)
})

test('MJ 在紧凑正文中使用语义改写，独立保留机位和原生参数', () => {
  const source = '[2.建筑骨架]：入口向南，青石高台在北侧冰壁下。'
  const savedPrompt = `${source}\n[5.四宫格多机位排版]旧版布局 --raw --stylize 30`
  assert.equal(scriptVideoMidjourneySceneDescription(savedPrompt), source)
  const preview = scriptVideoMidjourneyScenePrompt(savedPrompt, '南向入口、北侧冰壁下的青石高台')
  assert.match(preview, /"FRONT".*"OVERVIEW".*南向入口、北侧冰壁下的青石高台 --raw --stylize 30 --no people, watermarks$/u)
  assert.doesNotMatch(preview, /入口向南|旧版布局|建筑骨架/u)
})

test('MJ 保留旧场景的手写描述与末尾原生参数', () => {
  const prompt = scriptVideoMidjourneyScenePrompt('西侧石拱跨度 4.5 米。暖灯落在蓝灰地砖上。 --raw --no signage')

  assert.match(prompt, /西侧石拱跨度 4\.5 米，暖灯落在蓝灰地砖上 --raw --no signage$/u)
  assert.equal(prompt.match(/--no/gu)?.length, 1)
})
