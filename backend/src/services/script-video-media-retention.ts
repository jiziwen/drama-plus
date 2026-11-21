import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { STORAGE_ROOT } from '../utils/paths.js'

type AssetMedia = { image?: string; voiceAudio?: { url?: string } }
type Options = { storageRoot?: string; taskDb?: Database.Database }

// saveUploadedFile() assigns v4 UUIDs. Only retire files previously registered
// as project assets. Imported filenames and generated videos are never candidates.
const upload = /^\/?static\/uploads\/([\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.(?:png|jpe?g|webp|gif|avif|bmp|tiff?|heic|svg|mp3|wav|m4a|aac))$/iu
const stores = new Set<WeakRef<ScriptVideoMediaRetention>>()
function uploadNames(media: readonly (string | AssetMedia)[]) {
  const names = new Set<string>()
  for (const asset of media) {
    const urls = typeof asset === 'string' ? [asset] : [asset.image, asset.voiceAudio?.url]
    for (const url of urls) {
      const name = typeof url === 'string' && upload.exec(url)?.[1]
      if (name) names.add(name)
    }
  }
  return names
}

// These tables can reuse an upload created in the script-video workspace.
// Include soft-deleted entries because their referenced assets can be restored.
const libraryReferences = [
  'SELECT thumbnail, metadata FROM dramas',
  'SELECT thumbnail, video_url FROM episodes',
  ...['characters', 'scenes', 'props'].map(table => 'SELECT image_url, local_path, reference_images FROM ' + table),
  'SELECT composed_image, first_frame_image, last_frame_image, reference_images, video_url, subtitle_url, composed_video_url FROM storyboards',
  'SELECT url, thumbnail_url, local_path FROM assets',
  'SELECT scenes, merged_url FROM video_merges',
]

// A timeout or an unacknowledged cancellation is not evidence that a provider
// has finished fetching its inputs. Legacy polling timeouts had no error code.
const taskReferences = `SELECT params FROM sys_task
  WHERE status IN ('queued','running','processing') OR
    (status IN ('failed','canceled') AND result_url IS NULL AND (
      error_code IN ('submission_unknown','poll_timeout','polling_timeout','recovery_failed')
      OR (task_id IS NOT NULL AND error_code IS NULL AND error_msg LIKE 'Timeout:%')
    ))`

function referencedUploads(db: Database.Database, candidates: Set<string>) {
  const keep = new Set<string>()
  // Match basenames in local URLs, signed media URLs, and JSON reference lists.
  const namesInText = /[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}(?:_thumb)?\.[a-z0-9]+/giu
  for (const query of [taskReferences, ...libraryReferences]) {
    for (const values of db.prepare(query).raw().iterate() as Iterable<unknown[]>) {
      for (const value of values) {
        if (typeof value !== 'string') continue
        for (const name of value.match(namesInText) || []) if (candidates.has(name)) keep.add(name)
      }
    }
  }
  return keep
}

function thumbnail(name: string) {
  if (!/\.(?:mp3|wav|m4a|aac)$/iu.test(name)) return name.replace(/\.[^.]+$/u, '_thumb.webp')
}

export function scheduleRetiredUploadCleanup() {
  for (const reference of stores) {
    const store = reference.deref()
    if (store) store.scheduleCleanup(true)
    else stores.delete(reference)
  }
}

export class ScriptVideoMediaRetention {
  private reference = new WeakRef(this)
  private scheduled?: NodeJS.Immediate
  private retry?: NodeJS.Timeout
  private disposed = false
  private ready = false
  private changed = false

  constructor(private catalog: Database.Database, private options: Options = {}) {
    catalog.exec(`
      CREATE TABLE IF NOT EXISTS retired_uploads (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS preparing_uploads (
        job_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (job_id, name)
      );
    `)
  }

  // Only enable deletion after every legacy project has been successfully indexed.
  startCleanup() {
    this.ready = true
    stores.add(this.reference)
    this.scheduleCleanup(true)
  }

  // Call inside the same transaction that writes the project or job.
  replaceProjectAssets(_projectId: string, previous: readonly AssetMedia[], next: readonly AssetMedia[]) {
    const current = uploadNames(next)
    const retire = this.catalog.prepare('INSERT OR IGNORE INTO retired_uploads VALUES (?)')
    for (const name of uploadNames(previous)) {
      if (current.has(name)) continue
      retire.run(name)
      this.changed = true
    }
  }

  holdJob(jobId: string, media: readonly (string | AssetMedia)[]) {
    const hold = this.catalog.prepare('INSERT OR IGNORE INTO preparing_uploads VALUES (?, ?)')
    for (const name of uploadNames(media)) hold.run(jobId, name)
  }

  releaseJob(jobId: string) {
    if (this.catalog.prepare('DELETE FROM preparing_uploads WHERE job_id=?').run(jobId).changes) this.changed = true
  }

  scheduleCleanup(taskChanged = false) {
    if (!this.ready || this.disposed || this.scheduled || !this.catalog.open || !(taskChanged || this.changed)) return
    this.scheduled = setImmediate(() => {
      this.scheduled = undefined
      this.changed = false
      void this.cleanup().then(() => {
        // Other workspaces may remove their last reference without a generation
        // event. Only poll while this catalog has retired files left to process.
        if (!this.disposed && this.catalog.open && this.catalog.prepare('SELECT 1 FROM retired_uploads LIMIT 1').get()) this.retryLater()
      }).catch(error => {
        this.changed = true
        console.warn('[script-video] 素材清理将重试:', error.message)
        this.retryLater()
      })
    })
    this.scheduled.unref()
  }

  private retryLater() {
    if (this.retry || this.disposed) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      this.scheduleCleanup(true)
    }, 60_000)
    this.retry.unref()
  }

  async cleanup() {
    const catalog = this.catalog
    if (this.disposed || !catalog.open || !catalog.prepare('SELECT 1 FROM retired_uploads LIMIT 1').get()) return
    const taskDb = this.options.taskDb ?? (await import('../db/index.js')).db.$client
    if (this.disposed || !catalog.open) return
    // Isolated stores used for importing/validating a snapshot do not own the
    // application's upload directory. Tests with dedicated media pass both roots.
    if (!this.options.storageRoot && path.dirname(path.resolve(catalog.name)) !==
      path.resolve(path.dirname(taskDb.name), 'script-video/projects')) {
      this.dispose()
      return
    }
    // Synchronous critical section across both SQLite stores. A new reference
    // or persisted task cannot interleave between checking a path and unlinking.
    const collect = catalog.transaction(() => {
      const names = catalog.prepare<[], string>('SELECT name FROM retired_uploads').pluck().all()
      const candidates = new Set(names)
      for (const name of names) {
        const thumb = thumbnail(name)
        if (thumb) candidates.add(thumb)
      }
      const keep = referencedUploads(taskDb, candidates)
      for (const row of catalog.prepare<[], { assets: string }>('SELECT assets FROM projects').iterate()) {
        for (const name of uploadNames(JSON.parse(row.assets))) keep.add(name)
      }
      for (const name of catalog.prepare<[], string>('SELECT DISTINCT name FROM preparing_uploads').pluck().iterate()) keep.add(name)

      const root = this.options.storageRoot ?? STORAGE_ROOT
      const uploads = path.join(root, 'uploads')
      const directory = fs.lstatSync(uploads, { throwIfNoEntry: false })
      if (directory && !directory.isDirectory()) throw new Error('上传目录不是独立的普通目录')
      const forget = catalog.prepare('DELETE FROM retired_uploads WHERE name=?')
      for (const name of names) {
        const thumb = thumbnail(name)
        if (keep.has(name) || (thumb && keep.has(thumb))) continue
        if (!upload.test('/static/uploads/' + name)) throw new Error('素材清理记录的文件名无效')
        for (const file of [name, thumb]) {
          if (!file) continue
          const target = path.join(uploads, file)
          const stat = fs.lstatSync(target, { throwIfNoEntry: false })
          if (!stat) continue
          if (!stat.isFile()) throw new Error('上传文件不是普通文件')
          fs.unlinkSync(target)
        }
        forget.run(name)
      }
    })
    taskDb.transaction(() => collect.immediate()).immediate()
  }

  dispose() {
    this.disposed = true
    if (this.scheduled) clearImmediate(this.scheduled)
    if (this.retry) clearTimeout(this.retry)
    stores.delete(this.reference)
  }
}
