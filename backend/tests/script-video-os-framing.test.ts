import assert from 'node:assert/strict'
import test from 'node:test'
import { scriptVideoOsFraming } from '../src/services/script-video-os-framing'

test('直拍面部的心声镜头改取眼部或侧后方，保留人物动作', () => {
  const closeup = scriptVideoOsFraming('特写｜平视｜固定，@图片2赵峰面部', '@图片2赵峰抬眼，眼神炽热，嘴唇闭合，喉结微动。')
  assert.match(closeup!.camera, /双眼与眉部.*嘴部始终在画框外/u)
  assert.equal(closeup!.action, '@图片2赵峰抬眼，眼神炽热。')

  const medium = scriptVideoOsFraming('中近景｜平视｜固定，@图片2赵峰面部与胸前', '@图片2赵峰心中激荡，抱拳的手收紧；本镜闭口，只有心声。')
  assert.match(medium!.camera, /侧后方/u)
  assert.match(medium!.action, /@图片2赵峰心中激荡，抱拳的手收紧/u)
})

test('嘴部已经不入画、纯细节、背影和普通远景沿用已有镜头', () => {
  const safe = [
    ['面部近景，仅取双眼', '眼神一沉。'],
    ['特写，侧后方的肩背与握拳动作', '举起刀向城门走去。'],
    ['面部特写，嘴部不入画', '抬眼。'],
    ['面部近景', '脸部被遮挡，他握紧缰绳。'],
    ['全景，院落门口群像', '众人走入院落。'],
  ]
  for (const [camera, action] of safe) assert.equal(scriptVideoOsFraming(camera, action), undefined, camera)
})

test('跟拍中途转到嘴部特写时改侧后方跟拍，保留移动', () => {
  const result = scriptVideoOsFraming('先侧后方跟拍，再转到赵峰嘴部特写', '赵峰起身走向院门。')
  assert.match(result!.camera, /侧后方跟拍.*嘴部始终在画框外/u)
  assert.equal(result!.action, '赵峰起身走向院门。')
})
