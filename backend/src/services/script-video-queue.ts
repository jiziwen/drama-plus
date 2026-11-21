import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { ScriptVideoStoreError } from './script-video-store.js'

const TTL_MS = 120_000
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
type Reservation = { projectId: string; episodeId: string; cardId: string; session: string; requestId: string; expiresAt: number }

/** Only batches waiting in the browser use this short, renewable reservation.
 * Once submitted, the persistent generation job provides duplicate protection. */
export class ScriptVideoQueue {
  private db: Database.Database
  constructor(directory: string, private clock = Date.now) {
    mkdirSync(directory, { recursive: true })
    this.db = new Database(path.join(directory, 'video-queue.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`CREATE TABLE IF NOT EXISTS video_queue (
      projectId TEXT NOT NULL, episodeId TEXT NOT NULL, cardId TEXT NOT NULL,
      session TEXT NOT NULL, requestId TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      PRIMARY KEY(projectId, episodeId, cardId)
    )`)
  }
  close() { this.db.close() }
  private prune() { this.db.prepare('DELETE FROM video_queue WHERE expiresAt <= ?').run(this.clock()) }
  reserve(projectId: string, episodeId: string, session: string | null, requestId: string, cardIds: string[]) {
    if (!session || !validId(projectId) || !validId(episodeId) || !validId(requestId) ||
        !Array.isArray(cardIds) || !cardIds.length || cardIds.length > 500 || !cardIds.every(validId) || new Set(cardIds).size !== cardIds.length)
      throw new ScriptVideoStoreError('批量生成队列参数无效')
    return this.db.transaction(() => {
      this.prune()
      const expiresAt = this.clock() + TTL_MS
      for (const cardId of cardIds) this.assertCanSubmit(projectId, episodeId, cardId, session, requestId)
      // A heartbeat also removes work this batch has already submitted/skipped.
      const pending = new Set(cardIds)
      for (const row of this.list(projectId, episodeId)) {
        if (row.session === session && row.requestId === requestId && !pending.has(row.cardId))
          this.db.prepare('DELETE FROM video_queue WHERE projectId=? AND episodeId=? AND cardId=?').run(projectId, episodeId, row.cardId)
      }
      const save = this.db.prepare(`INSERT INTO video_queue VALUES (?,?,?,?,?,?)
        ON CONFLICT(projectId,episodeId,cardId) DO UPDATE SET expiresAt=excluded.expiresAt`)
      for (const cardId of cardIds) save.run(projectId, episodeId, cardId, session, requestId, expiresAt)
      return { requestId, cardIds, expiresAt }
    })()
  }
  list(projectId: string, episodeId: string): Reservation[] {
    this.prune()
    return this.db.prepare('SELECT * FROM video_queue WHERE projectId=? AND episodeId=? ORDER BY cardId').all(projectId, episodeId) as Reservation[]
  }
  assertCanSubmit(projectId: string, episodeId: string, cardId: string, session: string | null, requestId?: string) {
    const row = this.db.prepare('SELECT * FROM video_queue WHERE projectId=? AND episodeId=? AND cardId=? AND expiresAt>?')
      .get(projectId, episodeId, cardId, this.clock()) as Reservation | undefined
    if (row && (row.session !== session || row.requestId !== requestId))
      throw new ScriptVideoStoreError('此分镜已在另一个页面排队生成', 409, 'VIDEO_ACTIVE')
  }
  release(projectId: string, episodeId: string, session: string | null, requestId: string) {
    if (!session || !validId(requestId)) throw new ScriptVideoStoreError('批量生成队列参数无效')
    this.db.prepare('DELETE FROM video_queue WHERE projectId=? AND episodeId=? AND session=? AND requestId=?')
      .run(projectId, episodeId, session, requestId)
  }
  submitted(projectId: string, episodeId: string, cardId: string, session: string | null, requestId?: string) {
    if (!session || !requestId) return
    this.db.prepare('DELETE FROM video_queue WHERE projectId=? AND episodeId=? AND cardId=? AND session=? AND requestId=?')
      .run(projectId, episodeId, cardId, session, requestId)
  }
}
