import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('a 100-episode project loads its directory and one body without transferring other bodies', { timeout: 30_000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-load-'))
  process.env.SQLITE_PATH = path.join(directory, 'test.sqlite3')
  process.env.HUOBAO_DATA_DIR = directory
  process.env.MYSQL_AUTO_IMPORT = 'false'
  const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
  const { createScriptVideoRoutes } = await import('../src/routes/script-video.js')
  const store = new ScriptVideoStore(path.join(directory, 'projects'))
  try {
    const project = await store.create('百集加载基准')
    await store.mutate(project.id, record => {
      const template = record.project.episodes[0]
      record.project.episodes = Array.from({ length: 100 }, (_, index) => ({
        ...structuredClone(template), id: `episode-${index + 1}`, number: index + 1, title: `第${index + 1}集`,
        script: `第${index + 1}集独立剧本。` + '城门开启，人物穿过庭院，远处传来脚步声。'.repeat(330),
        confirmedScript: '确认后的剧本。'.repeat(200), confirmed: true,
        cards: Array.from({ length: 5 }, (_, card) => ({
          id: `card-${index + 1}-${card + 1}`, title: `片段${card + 1}`, duration: 30, summary: '镜头概述',
          manuallyAdded: true, assetIds: [], version: 1, status: 'draft',
          prompt: `只有第${index + 1}集片段${card + 1}包含此内容。` + '镜头缓慢推进，角色走过灯影交错的长廊。'.repeat(220),
          shots: [],
        })),
      }))
      return { result: null, documentChanged: true }
    })
    const app = createScriptVideoRoutes(store)
    const base = `http://localhost/projects/${project.id}`
    const results: Record<string, { bytes: number; milliseconds: number }> = {}
    async function read(name: string, url: string) {
      const start = performance.now()
      const response = await app.request(url)
      assert.equal(response.status, 200)
      const body = await response.text()
      results[name] = { bytes: Buffer.byteLength(body), milliseconds: Number((performance.now() - start).toFixed(2)) }
      return JSON.parse(body).data
    }
    const full = await read('legacyWholeProject', base)
    const list = await read('directory', 'http://localhost/projects?view=summary')
    const summary = await read('projectSummary', `${base}?view=summary`)
    const body = await read('singleEpisode', `${base}/episodes/episode-56`)
    assert.equal(full.episodes.length, 100)
    assert.equal(list.length, 1)
    assert.equal(list[0].episodes, undefined)
    assert.equal(summary.episodes.length, 100)
    assert.equal(summary.episodes[0].script, undefined)
    assert.equal(summary.episodes[0].cards, undefined)
    assert.equal(body.episode.id, 'episode-56')
    assert.equal(body.episodes, undefined)
    assert.ok(results.legacyWholeProject!.bytes > 8_000_000)
    assert.ok(results.directory!.bytes < 2_000)
    assert.ok(results.projectSummary!.bytes < 80_000)
    assert.ok(results.singleEpisode!.bytes < 200_000)
    for (const name of ['directory', 'projectSummary', 'singleEpisode']) assert.ok(results[name]!.milliseconds < 2_000, `${name} exceeded 2s`)
    const legacyDirectory = path.join(directory, 'legacy-projects')
    await fs.mkdir(legacyDirectory)
    const legacyPath = path.join(legacyDirectory, `${project.id}.json`)
    const original = JSON.stringify({ project: full, jobs: [] })
    await fs.writeFile(legacyPath, original)
    const coldStart = performance.now()
    const migrated = new ScriptVideoStore(legacyDirectory)
    assert.equal((await migrated.summary(project.id)).episodes.length, 100)
    const coldMigrationMs = Number((performance.now() - coldStart).toFixed(2))
    assert.equal(await fs.readFile(legacyPath, 'utf8'), original, 'migration preserves the source snapshot')
    assert.ok(coldMigrationMs < 2_000, 'cold legacy migration exceeded 2s on this local fixture')
    results.coldLegacyMigration = { bytes: Buffer.byteLength(original), milliseconds: coldMigrationMs }
    t.diagnostic(JSON.stringify(results))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
