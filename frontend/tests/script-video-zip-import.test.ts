import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32, deflateRawSync } from 'node:zlib'
import { readScriptVideoZip } from '../app/utils/scriptVideoPreviewAssets.ts'
import { readEpisodeFile, sortImportedEpisodes } from '../app/utils/scriptVideoPreviewEpisodes.ts'

type Entry = { path: string; text: string; badChecksum?: boolean }

// Use raw UTF-8 bytes without setting language-encoding bit 11, as some archivers do.
function archive(entries: Entry[]): File {
  const localParts: Buffer[] = [], centralParts: Buffer[] = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path), raw = Buffer.from(entry.text)
    const data = deflateRawSync(raw)
    const sum = entry.badChecksum ? crc32(raw) ^ 1 : crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(sum >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(20, 4)
    local.copy(central, 6, 4, 30)
    central.writeUInt32LE(localOffset, 42)
    localParts.push(local, name, data)
    centralParts.push(central, name)
    localOffset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centralParts), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  return new File([new Uint8Array(Buffer.concat([...localParts, directory, end]))], '剧本.zip')
}

test('中文 ZIP 按文件名集号排序，一份 TXT 保留全部标题及剧本内容，忽略归档元数据', async () => {
  const contents = '序\r\n第一集\r\n雨停。\r\n第二集\r\n门开。\r\n'
  const result = await readScriptVideoZip(archive([
    { path: '剧本/第十集 雨夜.txt', text: contents },
    { path: '剧本/第二集 追逐.txt', text: '另一集正文' },
    { path: '__MACOSX/剧本/._第二集 追逐.txt', text: 'Mac metadata' },
    { path: '剧本/.DS_Store', text: 'metadata' },
    { path: '剧本/封面.png', text: 'other media' },
  ]))
  assert.deepEqual(result.errors, [])
  assert.equal(result.skipped.length, 3)
  assert.deepEqual(result.files.map(file => file.webkitRelativePath), [
    '剧本/第十集 雨夜.txt', '剧本/第二集 追逐.txt',
  ])
  const read = await Promise.all(result.files.map(readEpisodeFile))
  const episodes = sortImportedEpisodes(read.filter(episode => episode !== undefined))
  assert.deepEqual(episodes, [
    {title: '第二集 追逐', number: 2, script: '另一集正文'},
    {title: '第十集 雨夜', number: 10, script: contents},
  ])
})

test('未标集号的章节文件自然排序，章后缀的独立 TXT 也保留为一集', async () => {
  const result = await readScriptVideoZip(archive(['第10章', '第2章-1', '第2章'].map(name => ({path: `${name}.txt`, text: '场次正文'}))))
  const rows = await Promise.all(result.files.map(readEpisodeFile))
  assert.deepEqual(sortImportedEpisodes(rows.filter(row => row !== undefined)).map(episode => episode.title), ['第2章', '第2章-1', '第10章'])
})

test('报告路径穿越和校验损坏的条目，完整 ZIP 结构缺失时拒绝解析', async () => {
  const zip = archive([
    {path: '../第1集.txt', text: '不得导入'},
    {path: '剧本\\..\\第2集.txt', text: '不得导入'},
    {path: '剧本/第3集.txt', text: '坏校验', badChecksum: true},
    {path: '剧本/第4集.txt', text: '保留'},
  ])
  const result = await readScriptVideoZip(zip)
  assert.deepEqual(result.files.map(file => file.name), ['第4集.txt'])
  assert.equal(result.errors.filter(error => error.includes('路径无效')).length, 2)
  assert.equal(result.errors.filter(error => error.includes('校验失败')).length, 1)
  const truncated = new File([zip.slice(0, -5)], '坏.zip')
  await assert.rejects(readScriptVideoZip(truncated), /目录不存在|损坏/)
})
