import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-image-dedup-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { db, schema } = await import('../src/db/index.ts')
const { withAssetImageRequest, withImageTaskSubmission } = await import('../src/services/image-submission.ts')
const ts = new Date().toISOString()

for (const field of ['characterId', 'sceneId', 'propId'] as const) {
  test(`${field}: simultaneous batch/single requests enqueue once; running task survives new requests`, async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const target = { [field]: 100 }
    const create = () => withAssetImageRequest(target, async () => {
      calls++
      await gate
      return withImageTaskSubmission(target, async () => db.insert(schema.sysTask).values({ type: 'image', ...target, status: 'processing', createdAt: ts, updatedAt: ts }).returning().get().id)
    })
    const attempts = Array.from({ length: 12 }, create)
    release()
    const ids = await Promise.all(attempts)
    assert.equal(new Set(ids).size, 1)
    assert.equal(calls, 1)
    assert.equal(await create(), ids[0])
    assert.equal(calls, 1)
    assert.equal(await withImageTaskSubmission(target, async () => { throw new Error('must reuse running task') }), ids[0])
    for (const status of ['completed', 'failed']) {
      db.update(schema.sysTask).set({ status }).where(eq(schema.sysTask.id, ids[0])).run()
      assert.equal(await withAssetImageRequest(target, async () => 999), 999)
    }
  })
}

test('failure releases submission lock and different assets are independent', async () => {
  await assert.rejects(withAssetImageRequest({ sceneId: 900 }, async () => { throw new Error('preparation failed') }), /preparation failed/)
  assert.equal(await withAssetImageRequest({ sceneId: 900 }, async () => 900), 900)
  assert.deepEqual(await Promise.all([
    withAssetImageRequest({ characterId: 901 }, async () => 1),
    withAssetImageRequest({ sceneId: 901 }, async () => 2),
    withAssetImageRequest({ sceneId: 902 }, async () => 3),
  ]), [1, 2, 3])
})
