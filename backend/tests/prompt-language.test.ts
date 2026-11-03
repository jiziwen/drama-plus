import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertChinesePrompt, isChinesePrompt, toChinesePrompt, CHINESE_PROMPT_RULE } from '../src/services/prompt-language.js'
import { buildLanguageDirective } from '../src/agents/language.js'

test('generation prompts require Chinese while allowing references and technical abbreviations', () => {
  for (const text of ['纯白背景，左侧正脸特写，右侧三张全身视图，脸和服装完全一致。', '@图片1小明缓缓转身，3D 动画，柔和棚拍光，4K 细节。']) assert.doesNotThrow(() => assertChinesePrompt(text))
  for (const text of ['', 'A red teapot on the table, cinematic lighting.', '中文 A red teapot on the table with a soft cinematic light.', '人物が静かに立っている。', '인물이 정면을 바라봅니다。']) assert.throws(() => assertChinesePrompt(text), /简体中文/)
  assert.equal(isChinesePrompt('A beautiful character portrait'), false)
  assert.equal(isChinesePrompt('high-quality，柔和日光，固定镜头，画面清晰。'), true)
  assert.equal(isChinesePrompt('high-quality，茶壶转动。'), true)
  assert.equal(isChinesePrompt('主体完整入镜，服装和五官清晰，柔和光线，纯白背景。white background'), true)
  assert.equal(isChinesePrompt('使用 gpt-image-2，柔和日光，固定镜头，画面清晰。'), true)
  assert.match(CHINESE_PROMPT_RULE, /与界面语言无关/)
})

test('legacy system style prefixes and mixed style terms remain unchanged without translation', async () => {
  const style = 'high-quality 3D CG animation still, cinematic lighting, modern game-engine render, Unreal Engine and Pixar quality'
  const prompt = `${style}，纯白背景，角色从正面、侧面、背面展示，服装和五官一致。`
  assert.equal(await toChinesePrompt(prompt, style), prompt)
  const mixed = 'high-quality 3D CG动画静帧，现代游戏引擎电影级渲染，细节清晰，角色造型一致。'
  assert.equal(await toChinesePrompt(mixed), mixed)
})
test('all interface language directives preserve Chinese generation prompts', () => {
  for (const language of ['en', 'ja', 'ko']) assert.match(buildLanguageDirective(language), /prompts.*Simplified Chinese/)
})
