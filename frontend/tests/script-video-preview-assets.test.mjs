import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { importPreviewAssets, resolvePreviewAssetNames } from '../app/utils/scriptVideoPreviewAssets.ts'

const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0 })
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
function makeZip(entries) {
  const local = [], central = []
  let offset = 0
  for (const { name, data, method = 8, badCrc = false } of entries) {
    const encoded = Buffer.from(name), raw = Buffer.from(data), compressed = method ? deflateRawSync(raw) : raw
    const crc = badCrc ? 0 : crc32(raw)
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt16LE(method, 8); l.writeUInt32LE(crc, 14); l.writeUInt32LE(compressed.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(encoded.length, 26)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(method, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(compressed.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(encoded.length, 28); c.writeUInt32LE(offset, 42)
    local.push(l, encoded, compressed); central.push(c, encoded); offset += l.length + encoded.length + compressed.length
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return new File([...local, dir, end], '素材.zip', { type: 'application/zip' })
}
function file(path, bytes = 'image') { const f = new File([bytes], path.split('/').pop()); Object.defineProperty(f, 'webkitRelativePath', { value: path }); return f }

test('directory and loose files retain Chinese paths, variants, and categories', async () => {
  const result = await importPreviewAssets([file('七天_素材/角色/顾凌天/顾凌天_黑衣.png'), file('七天_素材/背景/院落.jpg'), file('七天_素材/道具/毒酒碗.webp'), file('七天_素材/生物/妖兽.png'), file('散图.png'), file('七天_素材/角色/._忽略.png'), file('七天_素材/readme.txt')])
  assert.deepEqual(result.assets.map(a => [a.name, a.kind]), [['顾凌天_黑衣', 'character'], ['院落', 'scene'], ['毒酒碗', 'prop'], ['妖兽', 'creature'], ['散图', 'character']])
  assert.equal(result.assets[0].sourcePath, '七天_素材/角色/顾凌天/顾凌天_黑衣.png')
  assert.ok(result.assets[0].image.startsWith('blob:'))
  assert.equal(await (await fetch(result.assets[0].image)).text(), 'image')
  result.assets.forEach(asset => URL.revokeObjectURL(asset.image))
  assert.equal(result.skipped.length, 2)
  assert.deepEqual(result.errors, [])
})

test('reads real ZIP deflate and stored entries and reports unsafe or corrupt entries', async () => {
  const zip = makeZip([{ name: '七天_素材/角色/顾凌天_黑衣.png', data: 'png data' }, { name: '七天_素材/背景/院落.jpg', data: 'jpeg data', method: 0 }, { name: '__MACOSX/._院落.jpg', data: 'hidden' }, { name: '七天_素材/readme.txt', data: 'note' }, { name: '../escape.png', data: 'bad' }, { name: '七天_素材/角色/损坏.png', data: 'bad crc', badCrc: true }])
  const result = await importPreviewAssets([zip])
  assert.deepEqual(result.assets.map(a => [a.name, a.kind]), [['顾凌天_黑衣', 'character'], ['院落', 'scene']])
  assert.equal(await (await fetch(result.assets[0].image)).text(), 'png data')
  result.assets.forEach(asset => URL.revokeObjectURL(asset.image))
  assert.equal(result.skipped.length, 2)
  assert.equal(result.errors.length, 2)
  assert.match(result.errors.join('\n'), /路径无效/)
  assert.match(result.errors.join('\n'), /校验失败/)
})

test('collision names retain variant and distinguish same path and existing names', async () => {
  const { assets } = await importPreviewAssets([file('七天/角色/A/造型_一.png'), file('七天/角色/B/造型_一.png'), file('七天/角色/B/造型_一.png')])
  const named = resolvePreviewAssetNames(assets, ['造型_一'])
  assert.deepEqual(named.map(a => a.name), ['七天/角色/A/造型_一', '七天/角色/B/造型_一', '七天/角色/B/造型_一-2'])
  assert.ok(named.every(a => a.originalName === '造型_一'))
  assets.forEach(asset => URL.revokeObjectURL(asset.image))
})


test('at signs in filenames stay distinguishable from @ reference syntax', async () => {
  const { assets } = await importPreviewAssets([file('七天/角色/林@夜_造型.png')])
  assert.equal(assets[0].name, '林＠夜_造型')
  assert.equal(assets[0].originalName, '林@夜_造型')
  assert.equal(assets[0].sourcePath, '七天/角色/林@夜_造型.png')
  const qualified = resolvePreviewAssetNames([{ ...assets[0], sourcePath: '七天/角色@组/林@夜_造型.png' }], ['林＠夜_造型'])
  assert.equal(qualified[0].name, '七天/角色＠组/林＠夜_造型')
  assets.forEach(asset => URL.revokeObjectURL(asset.image))
})
