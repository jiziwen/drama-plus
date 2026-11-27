import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ScriptVideoDatabase } from '../src/services/script-video-database.js'
import { ScriptVideoAssetExtractionJobError, ScriptVideoAssetExtractionJobs } from '../src/services/script-video-asset-extraction-jobs.js'
import type { ScriptVideoAssetExtractionCheckpoint } from '../src/services/script-video-asset-extraction.js'

const input = { sources: [{ title: '第一集', script: '月光洒过屋檐。' }], existingAssets: [], configId: 1, model: 'original' }
const checkpoint: ScriptVideoAssetExtractionCheckpoint = { version: 1, inputFingerprint: 'original', done: 1, pending: [], known: [] }

function fixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), 'script-video-asset-extraction-jobs-'))
  const first = new ScriptVideoDatabase(dir)
  const second = new ScriptVideoDatabase(dir)
  t.after(() => {
    first.db.close()
    second.db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  first.db.prepare(`INSERT INTO projects(id,title,revision,version,shared,assets,episode_order)
    VALUES('project','剧本',1,1,'{}','[]','[]')`).run()
  let now = 0
  const options = { now: () => now, leaseMs: 90 }
  const jobs = new ScriptVideoAssetExtractionJobs(first.db, options)
  const reopened = new ScriptVideoAssetExtractionJobs(second.db, options)
  return { db: second.db, jobs, reopened, advance: (ms: number) => { now += ms } }
}

const code = (expected: string) => (error: unknown) =>
  error instanceof ScriptVideoAssetExtractionJobError && error.code === expected

test('another connection sees checkpoints and resumes an expired lease with the original script', t => {
  const { jobs, reopened, advance } = fixture(t)
  const started = jobs.start('project', input)
  assert.ok(started.run)
  assert.deepEqual(reopened.start('project', input), { job: started.job })
  assert.equal(jobs.checkpoint(started.run, checkpoint, { completed: 1, total: 1 }), true)
  const stage = { title: '第一集', episodeNumber: 1 }
  assert.equal(jobs.checkpoint(started.run, undefined, { completed: 1, total: 1, stage }), true)
  advance(80)
  assert.equal(jobs.renew(started.run), true)
  advance(10)
  assert.equal(reopened.get('project')?.status, 'running')
  advance(80)
  const expired = reopened.get('project')
  assert.equal(expired?.status, 'failed')
  assert.equal(expired?.completed, 1)
  assert.deepEqual(expired?.stage, stage)
  assert.equal(expired?.resumable, true)
  assert.throws(() => reopened.start('project', input), code('ASSET_EXTRACTION_RESUME_REQUIRED'))
  const resumed = reopened.resume('project', started.job.id, { configId: 2 })
  assert.ok(resumed.run)
  assert.deepEqual(resumed.run.input.sources, input.sources)
  assert.equal(resumed.run.input.configId, 2)
  assert.equal(resumed.run.input.model, undefined)
  assert.deepEqual(resumed.run.checkpoint, checkpoint)
  assert.notEqual(resumed.run.owner, started.run.owner)
  assert.equal(jobs.owns(started.run), false)
  assert.equal(jobs.renew(started.run), false)
  assert.equal(jobs.fail(started.run, '旧请求不能覆盖'), false)
  assert.equal(jobs.complete(started.run, { added: 5, reused: 5 }), false)
  assert.deepEqual(jobs.resume('project', started.job.id), { job: resumed.job })
})

test('completion and retained input participate in the caller transaction', t => {
  const { db, jobs, reopened } = fixture(t)
  const { job, run } = jobs.start('project', input)
  assert.ok(run)
  assert.equal(jobs.checkpoint(run, checkpoint, { completed: 1, total: 1 }), true)
  const counts = { added: 1, reused: 0 }
  const save = db.transaction(() => {
    assert.equal(reopened.complete(run, counts), true)
    throw new Error('项目写入失败')
  })
  assert.throws(() => save.immediate(), /项目写入失败/)
  assert.equal(jobs.owns(run), true)
  assert.equal(jobs.fail(run, '文字模型暂不可用'), true)
  const resumed = reopened.resume('project', job.id, { model: 'replacement' })
  assert.ok(resumed.run)
  assert.deepEqual(resumed.run.checkpoint, checkpoint)
  assert.equal(resumed.run.input.configId, 1)
  assert.equal(resumed.run.input.model, 'replacement')
  assert.equal(reopened.complete(resumed.run, counts), true)
  assert.deepEqual(jobs.get('project'), { id: job.id, status: 'completed', completed: 1, total: 1, ...counts })
  assert.equal((db.prepare('SELECT * FROM asset_extraction_payloads').all()).length, 0)
})

test('confirmed restart is the only replacement of unfinished input and deletion fences a running claim', t => {
  const { db, jobs, reopened } = fixture(t)
  const first = jobs.start('project', input)
  assert.ok(first.run)
  assert.equal(jobs.checkpoint(first.run, checkpoint, { completed: 1, total: 1 }), true)
  assert.equal(jobs.fail(first.run, '暂时失败'), true)
  assert.throws(() => reopened.start('project', input, 'stale'), code('ASSET_EXTRACTION_JOB_CHANGED'))
  const second = reopened.start('project', input, first.job.id)
  assert.ok(second.run)
  assert.notEqual(second.job.id, first.job.id)
  assert.equal(second.run.checkpoint, undefined)
  assert.throws(() => jobs.resume('project', first.job.id), code('ASSET_EXTRACTION_JOB_CHANGED'))
  db.prepare("DELETE FROM projects WHERE id='project'").run()
  assert.equal(jobs.get('project'), undefined)
  assert.equal(jobs.owns(second.run), false)
  assert.equal(jobs.checkpoint(second.run, checkpoint, { completed: 1, total: 1 }), false)
  assert.equal(jobs.complete(second.run, { added: 1, reused: 0 }), false)
  assert.equal((db.prepare('SELECT * FROM asset_extraction_payloads').all()).length, 0)
})
