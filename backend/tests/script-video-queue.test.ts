import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ScriptVideoQueue } from '../src/services/script-video-queue.js'

test('queued cards are shared, atomically exclusive per card, and survive a process restart', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'script-video-queue-'))
  let now = 1_000
  let queue = new ScriptVideoQueue(dir, () => now)
  try {
    queue.reserve('project', 'episode', 'tab-a', 'batch-a', ['one', 'two'])
    assert.deepEqual(queue.list('project', 'episode').map(row => row.cardId), ['one', 'two'])
    assert.throws(() => queue.reserve('project', 'episode', 'tab-b', 'batch-b', ['three', 'two']), /另一个页面/)
    assert.equal(queue.list('project', 'episode').some(row => row.cardId === 'three'), false)
    assert.doesNotThrow(() => queue.assertCanSubmit('project', 'episode', 'one', 'tab-a', 'batch-a'))
    assert.throws(() => queue.assertCanSubmit('project', 'episode', 'one', 'tab-b', 'batch-b'))
    queue.submitted('project', 'episode', 'one', 'tab-a', 'batch-a')
    assert.deepEqual(queue.list('project', 'episode').map(row => row.cardId), ['two'])
    queue.close()
    queue = new ScriptVideoQueue(dir, () => now)
    assert.equal(queue.list('project', 'episode')[0]!.requestId, 'batch-a')
    now += 120_001
    queue.reserve('project', 'episode', 'tab-b', 'batch-b', ['two'])
    queue.release('project', 'episode', 'tab-a', 'batch-a')
    assert.equal(queue.list('project', 'episode')[0]!.requestId, 'batch-b')
    queue.release('project', 'episode', 'tab-b', 'batch-b')
    assert.deepEqual(queue.list('project', 'episode'), [])
  } finally { queue.close(); rmSync(dir, { recursive: true, force: true }) }
})
