import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { Hono } from 'hono'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-signed-media-'))
const storage = path.join(root, 'static')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = storage
process.env.PUBLIC_MEDIA_SIGNED_URLS = 'true'
const { createSignedReferenceMediaUrl, signedReferenceMediaRoutes } = await import('../src/services/signed-reference-media.js')
const app = new Hono().route('/api/v1/reference-media', signedReferenceMediaRoutes)
const base = 'https://media.example.test'
const mp3 = '/static/uploads/参考 音频.mp3'
const localAudio = path.join(storage, 'uploads', path.basename(mp3))
await fs.mkdir(path.dirname(localAudio), { recursive: true })
await fs.mkdir(path.join(storage, 'seedance-refs'))
await fs.writeFile(localAudio, '0123456789')
await fs.writeFile(path.join(storage, 'seedance-refs', 'frame.png'), 'seedance-preview')
after(async () => fs.rm(root, { recursive: true, force: true }))

test('signed static audio and prepared images support GET, HEAD and byte ranges', async () => {
  const url = createSignedReferenceMediaUrl(base, mp3)
  assert.match(url, /^https:\/\/media\.example\.test\/api\/v1\/reference-media\/uploads\//u)
  const full = await app.request(url)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('Content-Type'), 'audio/mpeg')
  assert.equal(full.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(await full.text(), '0123456789')

  const head = await app.request(url, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('Content-Length'), '10')
  assert.equal(await head.text(), '')
  for (const [range, expectedBody, expectedHeader] of [
    ['bytes=0-0', '0', 'bytes 0-0/10'], ['bytes=3-8', '345678', 'bytes 3-8/10'],
    ['bytes=-2', '89', 'bytes 8-9/10'], ['bytes=7-', '789', 'bytes 7-9/10'],
  ]) {
    const response = await app.request(url, { headers: { Range: range } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('Content-Range'), expectedHeader)
    assert.equal(await response.text(), expectedBody)
  }
  const invalidRange = await app.request(url, { headers: { Range: 'bytes=100-101' } })
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('Content-Range'), 'bytes */10')

  const image = await app.request(createSignedReferenceMediaUrl(base, '/static/seedance-refs/frame.png'))
  assert.equal(image.headers.get('Content-Type'), 'image/png')
  assert.equal(await image.text(), 'seedance-preview')
  for (const [name, mime] of [['voice.wav', 'audio/wav'], ['clip.mov', 'video/quicktime']]) {
    await fs.writeFile(path.join(storage, 'uploads', name), 'sample media')
    const media = await app.request(createSignedReferenceMediaUrl(base, '/static/uploads/' + name), { method: 'HEAD' })
    assert.equal(media.status, 200)
    assert.equal(media.headers.get('Content-Type'), mime)
  }
  const key = await fs.stat(path.join(root, '.reference-media-signing-key'))
  assert.equal(key.size, 32)
  if (process.platform !== 'win32') assert.equal(key.mode & 0o777, 0o600)
})

test('signed URL authorization is scoped to its path and expiration', async t => {
  const url = new URL(createSignedReferenceMediaUrl(base, mp3))
  const missing = new URL(url)
  missing.search = ''
  const wrongFile = new URL(url)
  wrongFile.pathname = '/api/v1/reference-media/seedance-refs/frame.png'
  const wrongSignature = new URL(url)
  wrongSignature.searchParams.set('signature', '0'.repeat(64))
  const wrongExpiry = new URL(url)
  wrongExpiry.searchParams.set('expires', String(Number(url.searchParams.get('expires')) - 1))
  for (const invalid of [missing, wrongFile, wrongSignature, wrongExpiry]) {
    assert.equal((await app.request(invalid)).status, 404)
  }

  t.mock.method(Date, 'now', () => Number(url.searchParams.get('expires')) * 1000)
  assert.equal((await app.request(url)).status, 404)
})

test('signed media does not expose missing files, directories, dot-files, or files outside the static root', async () => {
  await fs.writeFile(path.join(root, 'private.txt'), 'private')
  await fs.writeFile(path.join(storage, 'uploads', 'other.txt'), 'temporary')
  const link = path.join(storage, 'uploads', 'other.txt')
  const signed = createSignedReferenceMediaUrl(base, '/static/uploads/other.txt')
  await fs.rm(link)
  await fs.symlink(path.join(root, 'private.txt'), link)
  assert.equal((await app.request(signed)).status, 404)
  assert.throws(() => createSignedReferenceMediaUrl(base, '/static/uploads/other.txt'))
  assert.throws(() => createSignedReferenceMediaUrl(base, '/static/uploads/../..'))
  assert.throws(() => createSignedReferenceMediaUrl(base, '/static/uploads'))
  assert.throws(() => createSignedReferenceMediaUrl(base, '/static/uploads/.hidden.png'))
  assert.throws(() => createSignedReferenceMediaUrl(base, '/static/uploads/absent.mp3'))

  process.env.PUBLIC_MEDIA_SIGNED_URLS = 'false'
  const valid = createSignedReferenceMediaUrl(base, mp3)
  assert.equal((await app.request(valid)).status, 404)
})
