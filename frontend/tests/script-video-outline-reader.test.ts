import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scriptVideoTimecode, splitScriptVideoOutlineSummary } from '../app/utils/scriptVideoPreview'

test('单行大纲按原有栏目分块，台词中同名标签保留在台词内', () => {
  const summary = '←承上第01段：柜门刚打开。事件链：两人走进去。关键原台词：她说：“场景：这里是故乡。”；场景待选：旧宅或库房。→衔接至第03段：脚步声靠近。'
  assert.deepEqual(splitScriptVideoOutlineSummary(summary), [
    { label: '承上第01段', text: '柜门刚打开。' },
    { label: '事件链', text: '两人走进去。' },
    { label: '关键原台词', text: '她说：“场景：这里是故乡。”；' },
    { label: '场景待选', text: '旧宅或库房。' },
    { label: '衔接至第03段', text: '脚步声靠近。' },
  ])
})

test('多行大纲保留自定义正文和手动绑定说明', () => {
  assert.deepEqual(splitScriptVideoOutlineSummary('自由补充：雨还在下。\n场景：石桥。\n远处亮起一盏灯。\n人物待选（未绑定）：守夜人。\n【已确认人物造型】@守夜人_斗笠'), [
    { label: '', text: '自由补充：雨还在下。' },
    { label: '场景', text: '石桥。\n远处亮起一盏灯。' },
    { label: '人物待选（未绑定）', text: '守夜人。' },
    { label: '已确认人物造型', text: '@守夜人_斗笠' },
  ])
  assert.deepEqual(splitScriptVideoOutlineSummary('自由写作。\n下一行。'), [{ label: '', text: '自由写作。\n下一行。' }])
  assert.deepEqual(splitScriptVideoOutlineSummary('收束：守卫关门。\n时长说明：两人的原词需要完整说完。'), [
    { label: '收束', text: '守卫关门。' },
    { label: '时长说明', text: '两人的原词需要完整说完。' },
  ])
  assert.deepEqual(splitScriptVideoOutlineSummary('  \n'), [])
})

test('时码保留短尾段小数且在整分钟正确进位', () => {
  assert.equal(scriptVideoTimecode(30), '00:30')
  assert.equal(scriptVideoTimecode(60), '01:00')
  assert.equal(scriptVideoTimecode(63.2), '01:03.2')
  assert.equal(scriptVideoTimecode(59.999), '01:00')
})
