import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindJimengPrompt } from '../src/services/jimeng-video.js'

test('Jimeng sends each bound mention as a single canvas resource', () => {
  const references = [
    { kind: 'image', resourceId: 'image-first' },
    { kind: 'audio', resourceId: 'voice' },
    { kind: 'image', resourceId: 'image-second' },
    { kind: 'video', resourceId: 'clip' },
  ] as const

  assert.equal(
    bindJimengPrompt('画面：@图片2人物，动作参考@视频1。\n对白：@图片2人物 @音频1：“请看图片2。”', references),
    '画面：{{res:image-second}}人物，动作参考{{res:clip}}。\n对白：{{res:image-second}}人物 {{res:voice}}：“请看图片2。”',
  )
  assert.equal(
    bindJimengPrompt('缺少@图片12、@音频2；保留{{文字}}。\n@图片\n2 个角色', references),
    '缺少@图片12、@音频2；保留\\{{文字}}。\n@图片\n2 个角色',
  )
})
