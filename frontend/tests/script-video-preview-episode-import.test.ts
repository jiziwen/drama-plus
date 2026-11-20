import assert from 'node:assert/strict'
import test from 'node:test'
import { importEpisodeFile, readEpisodeFile, sortImportedEpisodes } from '../app/utils/scriptVideoPreviewEpisodes'

test('每个文件只建一集，文件名集号优先，前言、回顾和原文换行全部保留', () => {
  const script = '\uFEFF人物小传\r\n\r\n第一集 回顾\r\n门外传来脚步。\r\n第2集 正文\r\n门开了。\r\n'
  const filenames = ['短剧_第十二集_回家.TXT', '短剧-EP12-回家.txt', 'Episode 012 回家.txt', '012.txt']
  for (const filename of filenames) {
    assert.deepEqual(importEpisodeFile(script, filename), {
      title: filename.slice(0, -4), number: 12, script,
    })
  }
})

test('没有文件集号时取第一个独立集标题，普通文件名里的数字不作集号', () => {
  const script = '备忘\n场景04：林间\n他记得第99集的事。\n【第十一集】\n院门打开。\nEpisode 12'
  assert.deepEqual(importEpisodeFile(script, '校对版2026.txt'), { title: '校对版2026', number: 11, script })
  assert.deepEqual(importEpisodeFile('第3集的旧信被退回。', '林间.txt'), { title: '林间', script: '第3集的旧信被退回。' })
  assert.equal(importEpisodeFile('\uFEFF  \r\n', 'EP01.txt'), undefined)
})

test('批量导入保留同号的全部文件；数值排序稳定，不改动输入', () => {
  const names = ['EP11', '草稿10', 'EP3-第二版', '03', '草稿2']
  const episodes = names.map(name => importEpisodeFile('正文', name + '.txt')!)
  assert.deepEqual(sortImportedEpisodes(episodes).map(e => e.title), ['EP3-第二版', '03', 'EP11', '草稿2', '草稿10'])
  assert.deepEqual(episodes.map(e => e.title), names)
})

test('正确读取 UTF-8、带 BOM 的 UTF-8/UTF-16 和未标记的 GB18030 中文', async () => {
  const text = '第2集 夜雨'
  const utf8 = new TextEncoder().encode(text)
  const utf16 = Buffer.from(text, 'utf16le')
  const gb18030 = Buffer.from('b5da32bcaf20d2b9d3ea', 'hex')
  for (const payload of [utf8, Buffer.concat([Buffer.from('efbbbf','hex'), utf8]),
    Buffer.concat([Buffer.from('fffe','hex'), utf16]), Buffer.concat([Buffer.from('feff','hex'), Buffer.from(utf16).swap16()]), gb18030]) {
    const file = new File([payload], '雨夜.txt')
    assert.deepEqual(await readEpisodeFile(file), { title: '雨夜', number: 2, script: text })
  }
})

test('损坏的文本或文件读取失败向上报错，可由批量导入界面按文件处理', async () => {
  await assert.rejects(readEpisodeFile(new File([Uint8Array.of(0xff)], '损坏文本.txt')), TypeError)
  const unreadable = new Blob()
  const failure = new Error('I/O error')
  Object.defineProperty(unreadable, 'arrayBuffer', { value: async () => { throw failure } })
  await assert.rejects(readEpisodeFile(unreadable), failure)
})
