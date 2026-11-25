import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ScriptVideoStore } from '../src/services/script-video-store.js'
import { ScriptVideoAIError } from '../src/services/script-video-ai.js'

test('batched retry endpoints retain accepted cards and reset only an explicitly retried exhausted segment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'script-video-segment-retry-'))
  const beforeDb = process.env.SQLITE_PATH, beforeData = process.env.HUOBAO_DATA_DIR
  process.env.SQLITE_PATH = path.join(directory, 'fixture.sqlite3')
  process.env.HUOBAO_DATA_DIR = directory
  const store = new ScriptVideoStore(path.join(directory, 'projects'))
  let closeDatabase: (() => void) | undefined
  let closeDefaultStore: (() => Promise<void>) | undefined
  try {
    const { createScriptVideoRoutes, scriptVideoStore } = await import('../src/routes/script-video.js')
    const { db, schema } = await import('../src/db/index.js')
    closeDatabase = () => db.$client.close()
    closeDefaultStore = () => scriptVideoStore.close()
    const now = new Date().toISOString()
    const [config] = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai',
      name: 'Segment scope fixture', baseUrl: 'https://www.aicost.me/v1', apiKey: 'fixture', model: '["fixture-model"]',
      createdAt: now, updatedAt: now }).returning().all()
    const session = randomUUID()
    const headers = { 'content-type': 'application/json', 'X-Script-Video-Session': session }
    const production = { coreRhythm: '连续动作', characters: [] }
    for (const mode of ['retryCurrentSegment', 'restartAfterRepairs', 'ordinary-interruption'] as const) {
      let project = await store.create(mode)
      const episode = project.episodes[0]
      episode.script = episode.confirmedScript = '阿明推门进入院中。'
      episode.confirmed = episode.outlineConfirmed = true
      episode.cards = ['one', 'two', 'three', 'four'].map(id => ({ id, title: id, summary: id,
        duration: 30, shots: [], assetIds: [], prompt: '', version: 1, status: 'draft' }))
      project = await store.update(project.id, project, project.revision)
      const drafts = episode.cards.map((card: any) => ({ ...card, shots: [{ duration: 30 }], prompt: '已生成 ' + card.id }))
      let calls = 0
      const interrupted = mode === 'ordinary-interruption'
      const storyboardMode = mode === 'restartAfterRepairs' ? 'original' : undefined
      const app = createScriptVideoRoutes(store, {
        assertScriptVideoFormal: () => 0,
        generateScriptVideoCards: async (input, _runner, options) => {
          calls++
          assert.equal(input.storyboardMode, storyboardMode ?? 'cultivation')
          assert.equal(options?.batchSize, 1)
          if (calls === 1) {
            await options!.onProgress!({ phase: 'repairing', batchSize: 1, completed: 3, total: 4,
              repairAttempts: interrupted ? 5 : 3, ...(interrupted && { segmentRepairAttempts: 2 }), currentCardId: 'four' }, {
              cards: drafts.slice(0, 3), production, repairAttempts: interrupted ? 5 : 3,
              ...(interrupted && { repairCardId: 'four', segmentRepairAttempts: 2 }),
              candidate: { production, cards: drafts },
            })
            throw new ScriptVideoAIError(interrupted ? 'MODEL_TIMEOUT' : 'STORYBOARD_REPAIRS_EXHAUSTED', '第4段尚待修复')
          }
          assert.equal(options!.checkpoint?.cards.length, 3)
          assert.deepEqual(options!.checkpoint?.candidate?.cards, drafts)
          assert.deepEqual(options!.checkpoint?.cards, drafts.slice(0, 3))
          assert.equal(options!.checkpoint?.repairAttempts, interrupted ? 5 : 3)
          assert.equal(options!.checkpoint?.segmentRepairAttempts, interrupted ? 2 : 0)
          return { cards: drafts, production, attempts: 1, skillReads: [] }
        },
      })
      const root = `http://localhost/projects/${project.id}/episodes/${episode.id}`
      const post = (suffix: string, body: unknown) => app.request(root + suffix, { method: 'POST', headers,
        body: JSON.stringify(body) })
      assert.equal((await post('/lock', {})).status, 200)
      const common = { configId: config.id, model: 'fixture-model', storyboardMode }
      assert.equal((await post('/storyboard', { ...common, storyboardMode: 'unknown' })).status, 400)
      const first = await post('/storyboard', common)
      assert.equal(first.status, 201)
      const firstJob = ((await first.json()) as any).data
      assert.equal(firstJob.storyboardMode, storyboardMode ?? 'cultivation')
      const firstId = firstJob.id
      const waitForJob = async (id: string) => {
        for (let count = 0; count < 100; count++) {
          const current = await store.getJob(project.id, id)
          if (current.status === 'completed' || current.status === 'failed') return current
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        assert.fail('offline job did not finish')
      }
      assert.equal((await waitForJob(firstId)).status, 'failed')
      if (!interrupted) {
        const noReset = await post('/storyboard', { ...common, resumeFromJobId: firstId })
        assert.equal(noReset.status, 409, 'exhausted budgets require explicit continuation')
      } else {
        const invalidReset = await post('/storyboard', { ...common, resumeFromJobId: firstId, retryCurrentSegment: true })
        assert.equal(invalidReset.status, 409, 'ordinary interruptions cannot silently receive a new budget')
      }
      const stale = await post('/storyboard', { ...common, model: 'changed', resumeFromJobId: firstId,
        ...(!interrupted && { retryCurrentSegment: true }) })
      assert.equal(stale.status, 409)
      const otherMode = await post('/storyboard', { ...common, storyboardMode: storyboardMode ? 'cultivation' : 'original',
        resumeFromJobId: firstId, ...(!interrupted && { retryCurrentSegment: true }) })
      assert.equal(otherMode.status, 409)
      assert.equal(calls, 1)
      const continued = await post('/storyboard', { ...common, resumeFromJobId: firstId,
        ...(mode === 'retryCurrentSegment' && { retryCurrentSegment: true }),
        ...(mode === 'restartAfterRepairs' && { restartAfterRepairs: true }) })
      assert.equal(continued.status, 201)
      const nextId = ((await continued.json()) as any).data.id
      assert.equal((await waitForJob(nextId)).status, 'completed')
      assert.equal(calls, 2)
      assert.equal((await store.get(project.id)).episodes[0].cards[0].prompt, drafts[0].prompt)
    }
  } finally {
    await store.close()
    await closeDefaultStore?.()
    closeDatabase?.()
    if (beforeDb === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = beforeDb
    if (beforeData === undefined) delete process.env.HUOBAO_DATA_DIR; else process.env.HUOBAO_DATA_DIR = beforeData
    await rm(directory, { recursive: true, force: true })
  }
})
