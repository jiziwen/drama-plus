import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { assertVideoCliAccountRemovable, assertVideoCliNotDisconnecting, holdVideoCliSubmission, whileVideoCliAccountRemoving, whileVideoCliDisconnecting } from '../src/services/video-cli-tasks.js'

test('disconnect guards only the selected account, including persisted and legacy tasks', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-cli-task-accounts-'))
  const old = { SQLITE_PATH: process.env.SQLITE_PATH, MYSQL_AUTO_IMPORT: process.env.MYSQL_AUTO_IMPORT }
  process.env.SQLITE_PATH = path.join(folder, 'tasks.sqlite3')
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { db, schema: { sysTask } } = await import('../src/db/index.js')
  t.after(async () => { db.$client.close(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; await fs.rm(folder, { recursive: true, force: true }) })
  const release = holdVideoCliSubmission('jimeng', 'account-a')!
  await assert.rejects(whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {}, 'account-a'), /busy/)
  await whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {
    assert.throws(() => assertVideoCliNotDisconnecting('jimeng', 'account-b'), /断开/)
    assert.doesNotThrow(() => assertVideoCliNotDisconnecting('jimeng', 'account-a'))
  }, 'account-b')
  release(); release()
  await whileVideoCliAccountRemoving('jimeng', 'account-a', async () => {
    assert.throws(() => holdVideoCliSubmission('jimeng', 'account-a'), /移除/)
    assert.throws(() => assertVideoCliNotDisconnecting('jimeng', 'account-a'), /移除/)
    await assert.rejects(whileVideoCliAccountRemoving('jimeng', 'account-a', async () => {}), /移除/)
    const releaseOther = holdVideoCliSubmission('jimeng', 'account-b')!
    releaseOther()
    await whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {}, 'account-a')
    assert.throws(() => holdVideoCliSubmission('jimeng', 'account-a'), /移除/, 'logout completion must not unlock the account before its registry entry is removed')
  })
  const releaseAfterRemoval = holdVideoCliSubmission('jimeng', 'account-a')!
  releaseAfterRemoval()
  const date = new Date().toISOString()
  db.insert(sysTask).values({ type: 'video', provider: 'jimeng', status: 'processing', params: JSON.stringify({ jimeng: { profileId: 'account-a' } }), createdAt: date, updatedAt: date }).run()
  await assert.rejects(whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {}, 'account-a'), /busy/)
  await whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {}, 'account-b')
  db.delete(sysTask).run()
  db.insert(sysTask).values({ type: 'video', provider: 'jimeng', status: 'processing', createdAt: date, updatedAt: date }).run()
  await assert.rejects(whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {}), /busy/)
  await whileVideoCliDisconnecting('jimeng', new Error('busy'), async () => {}, 'account-b')
  db.delete(sysTask).run()
  for (const provider of ['jimeng', 'libtv'] as const) {
    for (const errorCode of ['submission_unknown', 'poll_timeout', 'delivery_failed', 'recovery_failed']) {
      db.insert(sysTask).values({ type: 'video', provider, status: 'failed', errorCode, taskId: 'original-task',
        params: JSON.stringify({ [provider]: { profileId: 'account-a' } }), createdAt: date, updatedAt: date }).run()
      await assert.rejects(assertVideoCliAccountRemovable(provider, 'account-a'), /恢复|原任务/)
      await assertVideoCliAccountRemovable(provider, 'account-b')
      db.delete(sysTask).run()
    }
    for (const fields of [
      { status: 'failed', errorCode: 'generation_failed', taskId: 'original-task' },
      { status: 'failed', errorCode: 'submission_unknown', taskId: null },
      { status: 'failed', errorCode: 'delivery_failed', taskId: 'original-task', localPath: 'static/videos/complete.mp4' },
      { status: 'completed', taskId: 'original-task' },
    ]) {
      db.insert(sysTask).values({ type: 'video', provider, ...fields, params: JSON.stringify({ videoCliAccountId: 'account-a' }), createdAt: date, updatedAt: date }).run()
      await assertVideoCliAccountRemovable(provider, 'account-a')
      db.delete(sysTask).run()
    }
    db.insert(sysTask).values({ type: 'video', provider, status: 'processing', params: JSON.stringify({ videoCliAccountId: 'account-a' }), createdAt: date, updatedAt: date }).run()
    await assert.rejects(assertVideoCliAccountRemovable(provider, 'account-a'), /运行|提交/)
    await assertVideoCliAccountRemovable(provider, 'account-b')
    db.delete(sysTask).run()
    db.insert(sysTask).values({ type: 'video', provider, status: 'failed', errorCode: 'submission_unknown', taskId: 'legacy-original', createdAt: date, updatedAt: date }).run()
    await assert.rejects(assertVideoCliAccountRemovable(provider, 'default'), /恢复|原任务/)
    await assertVideoCliAccountRemovable(provider, 'account-b')
    db.delete(sysTask).run()
  }
})
