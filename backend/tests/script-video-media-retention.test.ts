import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import Database from 'better-sqlite3'
import { initSqliteSchema } from '../src/db/sqlite-schema.js'
import { ScriptVideoMediaRetention, scheduleRetiredUploadCleanup } from '../src/services/script-video-media-retention.js'

function workspace(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-video-retention-'))
  const uploads = path.join(root, 'uploads')
  fs.mkdirSync(uploads)
  const filename = path.join(root, 'workspace.sqlite3')
  const catalog = new Database(filename)
  const tasks = new Database(':memory:')
  initSqliteSchema(tasks)
  catalog.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, assets TEXT)')
  const media = new ScriptVideoMediaRetention(catalog, {storageRoot: root, taskDb: tasks})
  const file = (name = randomUUID() + '.png') => {
    fs.writeFileSync(path.join(uploads, name), 'media')
    return { name, image: '/static/uploads/' + name, exists: () => fs.existsSync(path.join(uploads, name)) }
  }
  const save = (id: string, previous: {image: string}[], next: {image: string}[]) => {
    catalog.transaction(() => {
      catalog.prepare('INSERT OR REPLACE INTO projects VALUES (?,?)').run(id, JSON.stringify(next))
      media.replaceProjectAssets(id, previous, next)
    })()
  }
  t.after(() => {
    media.dispose()
    if (catalog.open) catalog.close()
    tasks.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, uploads, filename, catalog, tasks, media, file, save }
}

test('replacing an upload keeps other projects, gallery references, and unmanaged files intact', async t => {
  const { media, file, save, tasks } = workspace(t)
  const original = file(), thumb = file(original.name.replace('.png','_thumb.webp')), latest = file()
  const imported = file('existing-name.png')
  save('one', [], [original, imported])
  save('two', [], [original])
  save('one', [original, imported], [latest])
  await media.cleanup()
  assert.ok(original.exists())
  tasks.prepare("INSERT INTO assets (url,created_at,updated_at) VALUES (?,'today','today')").run(original.image)
  save('two', [original], [])
  await media.cleanup()
  assert.ok(original.exists())
  tasks.exec('DELETE FROM assets')
  await media.cleanup()
  assert.equal(original.exists(), false)
  assert.equal(thumb.exists(), false)
  assert.ok(latest.exists())
  assert.ok(imported.exists())
})

test('queued reservations hand off to all consuming tasks and clean up on an upstream terminal event', async t => {
  const { media, file, save, tasks, catalog } = workspace(t)
  const original = file(), latest = file()
  save('one', [], [original])
  media.holdJob('first', [original])
  save('one', [original], [latest])
  await media.cleanup()
  assert.ok(original.exists())
  const insert = tasks.prepare(`INSERT INTO sys_task(type,status,params,created_at,updated_at) VALUES ('video','processing',?,'today','today')`)
  insert.run(JSON.stringify({referenceImageUrls: [original.image]}))
  insert.run(JSON.stringify({sourceUploadUrls: [original.image]}))
  media.releaseJob('first')
  media.startCleanup()
  await nextTurn()
  assert.ok(original.exists())
  tasks.exec("UPDATE sys_task SET status='completed' WHERE id=1")
  tasks.exec("UPDATE sys_task SET status='failed', error_code='submission_unknown' WHERE id=2")
  scheduleRetiredUploadCleanup()
  await nextTurn()
  assert.ok(original.exists())
  tasks.exec("UPDATE sys_task SET status='canceled',error_code=NULL WHERE id=2")
  scheduleRetiredUploadCleanup()
  await nextTurn()
  assert.equal(original.exists(), false)
  assert.equal(catalog.prepare('SELECT count(*) FROM retired_uploads').pluck().get(), 0)
  assert.ok(latest.exists())
})

test('restart drains the persisted retirement queue after the final reservation and keeps audio in use', async t => {
  const { media, file, save, tasks, root, filename, catalog } = workspace(t)
  const image = file(), audio = file(randomUUID()+'.wav')
  const old = { ...image, voiceAudio: { url: audio.image } }
  save('one', [], [old])
  save('one', [old], [])
  media.holdJob('still-preparing', [image])
  tasks.prepare("INSERT INTO sys_task(type,status,params,created_at,updated_at) VALUES ('video','processing',?,'today','today')")
    .run(JSON.stringify({referenceAudioUrls:[audio.image]}))
  media.dispose()
  catalog.close()
  const reopened = new Database(filename)
  const restarted = new ScriptVideoMediaRetention(reopened, { storageRoot:root, taskDb:tasks })
  try {
    restarted.startCleanup()
    await nextTurn()
    assert.ok(image.exists() && audio.exists())
    restarted.releaseJob('still-preparing')
    tasks.exec("UPDATE sys_task SET status='completed'")
    restarted.scheduleCleanup()
    await nextTurn()
    assert.equal(image.exists() || audio.exists(), false)
  } finally {
    restarted.dispose()
    reopened.close()
  }
})

test('directories or symlinks cannot redirect a retired filename outside uploads', async t => {
  const { root, uploads, media, file, save } = workspace(t)
  const image = file()
  save('one', [image], [])
  fs.renameSync(uploads, path.join(root,'elsewhere'))
  fs.symlinkSync(path.join(root,'elsewhere'), uploads)
  await assert.rejects(media.cleanup(), /上传目录/u)
  assert.ok(image.exists())
})
