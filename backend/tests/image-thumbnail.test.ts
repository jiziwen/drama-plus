import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import sharp from 'sharp'

test('legacy images get a cached thumbnail on demand while their original stays intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'drama-thumbnails-'))
  const storage = join(root, 'static')
  process.env.HUOBAO_DATA_DIR = root
  process.env.STORAGE_PATH = storage
  process.env.SQLITE_PATH = join(root, 'test.sqlite3')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { db } = await import('../src/db/index.js')
  const { default: routes } = await import('../src/routes/storage.js')
  t.after(async () => {
    db.$client.close()
    await rm(root, { recursive: true, force: true })
  })
  const source = join(storage, 'uploads', '旧素材图.jpg')
  await mkdir(join(storage, 'uploads'), { recursive: true })
  await sharp({ create: { width: 600, height: 1200, channels: 3, background: 'blue' } }).jpeg().toFile(source)
  const original = await readFile(source)
  const request = (asset: string, headers?: HeadersInit) =>
    routes.request('/thumbnail?path=' + encodeURIComponent(asset), { headers })

  const [first, concurrent] = await Promise.all([
    request('static/uploads/旧素材图.jpg'),
    request('/static/uploads/旧素材图.jpg'),
  ])
  assert.equal(first.status, 200)
  assert.equal(concurrent.status, 200)
  assert.equal(first.headers.get('content-type'), 'image/webp')
  const bytes = Buffer.from(await first.arrayBuffer())
  assert.ok(bytes.length < original.length)
  const image = await sharp(bytes).metadata()
  assert.deepEqual([image.width, image.height], [200, 400])
  assert.deepEqual(await readFile(source), original)
  assert.deepEqual(await readFile(join(storage, 'uploads', '旧素材图_thumb.webp')), bytes)
  assert.deepEqual(Buffer.from(await concurrent.arrayBuffer()), bytes)
  const etag = first.headers.get('etag')
  assert.ok(etag)
  assert.equal((await request('static/uploads/旧素材图.jpg', { 'If-None-Match': etag })).status, 304)

  assert.equal((await request('static/../test.sqlite3')).status, 404)
  assert.equal((await request('https://example.invalid/static/my.jpg')).status, 404)
  assert.equal((await request('/static/uploads/missing.jpg')).status, 404)
  if (process.platform !== 'win32') {
    await symlink(join(root, 'test.sqlite3'), join(storage, 'uploads', 'outside.jpg'))
    assert.equal((await request('/static/uploads/outside.jpg')).status, 404)
  }
})
