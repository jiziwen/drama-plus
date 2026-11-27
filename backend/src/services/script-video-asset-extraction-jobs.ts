import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { extractScriptVideoAssets, ScriptVideoAssetExtractionCheckpoint } from './script-video-asset-extraction.js'

export type AssetExtractionJobInput = Pick<Parameters<typeof extractScriptVideoAssets>[0],
  'sources' | 'existingAssets' | 'style' | 'configId' | 'model'>

type ExtractionStage = { title: string; episodeNumber?: number }
export type AssetExtractionProgress = { completed: number; total: number; stage?: ExtractionStage }
export type AssetExtractionJob = AssetExtractionProgress & {
  id: string
  status: 'running' | 'completed' | 'failed'
  added?: number
  reused?: number
  error?: string
  resumable?: boolean
}

type ClaimKey = { projectId: string; jobId: string; owner: string }
export type AssetExtractionClaim = ClaimKey & {
  input: AssetExtractionJobInput
  checkpoint?: ScriptVideoAssetExtractionCheckpoint
}

type JobResult = { job: AssetExtractionJob; run?: AssetExtractionClaim }
type ModelOptions = Pick<AssetExtractionJobInput, 'configId' | 'model'>
type JobRow = {
  id: string
  status: AssetExtractionJob['status']
  completed: number
  total: number
  stage: string | null
  added: number | null
  reused: number | null
  error: string | null
  lease_until: number | null
}

const jobChanged = () => new ScriptVideoAssetExtractionJobError('资产提取任务已更新，请刷新后重试。', 409, 'ASSET_EXTRACTION_JOB_CHANGED')

export class ScriptVideoAssetExtractionJobError extends Error {
  constructor(message: string, public status: number, public code: string) { super(message) }
}

function visibleJob(row: JobRow): AssetExtractionJob {
  const { id, status, completed, total, stage, added, reused, error } = row
  return {
    id, status, completed, total,
    ...(stage && { stage: JSON.parse(stage) as ExtractionStage }),
    ...(added !== null && { added }),
    ...(reused !== null && { reused }),
    ...(error && { error }),
    ...(status === 'failed' && { resumable: true }),
  }
}

export class ScriptVideoAssetExtractionJobs {
  private readonly now: () => number
  private readonly leaseMs: number

  constructor(private readonly db: Database.Database, options: { now?: () => number; leaseMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? 90_000
    db.exec(`
      CREATE TABLE IF NOT EXISTS asset_extraction_jobs (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        status TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        stage TEXT,
        added INTEGER,
        reused INTEGER,
        error TEXT,
        owner TEXT,
        lease_until INTEGER
      );
      CREATE TABLE IF NOT EXISTS asset_extraction_payloads (
        project_id TEXT NOT NULL REFERENCES asset_extraction_jobs(project_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('input', 'checkpoint')),
        document TEXT NOT NULL,
        PRIMARY KEY(project_id, kind)
      );
    `)
  }

  private current(projectId: string, now: number): JobRow | undefined {
    const read = this.db.prepare<[string], JobRow>('SELECT * FROM asset_extraction_jobs WHERE project_id=?')
    const row = read.get(projectId)
    if (!row || row.status !== 'running' || row.lease_until === null || row.lease_until > now) return row
    this.db.prepare(`UPDATE asset_extraction_jobs SET status='failed', error=?, owner=NULL, lease_until=NULL
      WHERE project_id=? AND id=? AND status='running' AND lease_until<=?`)
      .run('提取中断，已保存完成的分段。请继续提取。', projectId, row.id, now)
    return read.get(projectId)
  }

  private setPayload(projectId: string, kind: 'input' | 'checkpoint', value: unknown) {
    this.db.prepare(`INSERT INTO asset_extraction_payloads(project_id,kind,document) VALUES(?,?,?)
      ON CONFLICT(project_id,kind) DO UPDATE SET document=excluded.document`)
      .run(projectId, kind, JSON.stringify(value))
  }

  get(projectId: string): AssetExtractionJob | undefined {
    const row = this.current(projectId, this.now())
    return row && visibleJob(row)
  }

  start(projectId: string, input: AssetExtractionJobInput, restartJobId?: string): JobResult {
    return this.db.transaction((): JobResult => {
      const now = this.now()
      const row = this.current(projectId, now)
      if (row?.status === 'running') return { job: visibleJob(row) }
      if (restartJobId !== undefined && restartJobId !== row?.id) throw jobChanged()
      if (row?.status === 'failed' && restartJobId !== row.id)
        throw new ScriptVideoAssetExtractionJobError('上次提取仍可继续，请继续或确认重新开始。', 409, 'ASSET_EXTRACTION_RESUME_REQUIRED')
      if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))
        throw new ScriptVideoAssetExtractionJobError('项目不存在。', 404, 'NOT_FOUND')
      const jobId = randomUUID(), owner = randomUUID()
      this.db.prepare(`INSERT INTO asset_extraction_jobs(project_id,id,status,owner,lease_until) VALUES(?,?,'running',?,?)
        ON CONFLICT(project_id) DO UPDATE SET id=excluded.id,status='running',completed=0,total=0,stage=NULL,
          added=NULL,reused=NULL,error=NULL,owner=excluded.owner,lease_until=excluded.lease_until`)
        .run(projectId, jobId, owner, now + this.leaseMs)
      this.db.prepare('DELETE FROM asset_extraction_payloads WHERE project_id=?').run(projectId)
      this.setPayload(projectId, 'input', input)
      return { job: { id: jobId, status: 'running', completed: 0, total: 0 }, run: { projectId, jobId, owner, input } }
    }).immediate()
  }

  resume(projectId: string, jobId: string, options?: ModelOptions): JobResult {
    return this.db.transaction((): JobResult => {
      const now = this.now()
      const row = this.current(projectId, now)
      if (row?.id !== jobId) throw jobChanged()
      if (row.status !== 'failed') return { job: visibleJob(row) }
      const read = this.db.prepare<[string, string], { document: string }>(
        'SELECT document FROM asset_extraction_payloads WHERE project_id=? AND kind=?')
      const saved = read.get(projectId, 'input')
      if (!saved) throw jobChanged()
      let input = JSON.parse(saved.document) as AssetExtractionJobInput
      const state = read.get(projectId, 'checkpoint')
      const checkpoint = state ? JSON.parse(state.document) as ScriptVideoAssetExtractionCheckpoint : undefined
      const configId = options?.configId ?? input.configId
      const model = options?.model ?? (configId === input.configId ? input.model : undefined)
      if (configId !== input.configId || model !== input.model) {
        input = { ...input, configId, model }
        this.setPayload(projectId, 'input', input)
      }
      const owner = randomUUID()
      this.db.prepare("UPDATE asset_extraction_jobs SET status='running', error=NULL, owner=?, lease_until=? WHERE project_id=?")
        .run(owner, now + this.leaseMs, projectId)
      return { job: visibleJob({ ...row, status: 'running', error: null }), run: { projectId, jobId, owner, input, checkpoint } }
    }).immediate()
  }

  checkpoint(claim: ClaimKey, checkpoint: ScriptVideoAssetExtractionCheckpoint | undefined, progress: AssetExtractionProgress): boolean {
    return this.db.transaction(() => {
      const now = this.now()
      const result = this.db.prepare(`UPDATE asset_extraction_jobs SET completed=?, total=?, stage=?, lease_until=?
        WHERE project_id=? AND id=? AND owner=? AND status='running' AND lease_until>?`)
        .run(progress.completed, progress.total, progress.stage ? JSON.stringify(progress.stage) : null, now + this.leaseMs,
          claim.projectId, claim.jobId, claim.owner, now)
      if (!result.changes) return false
      if (checkpoint) this.setPayload(claim.projectId, 'checkpoint', checkpoint)
      return true
    }).immediate()
  }

  renew(claim: ClaimKey): boolean {
    const now = this.now()
    return this.db.prepare(`UPDATE asset_extraction_jobs SET lease_until=?
      WHERE project_id=? AND id=? AND owner=? AND status='running' AND lease_until>?`)
      .run(now + this.leaseMs, claim.projectId, claim.jobId, claim.owner, now).changes > 0
  }

  fail(claim: ClaimKey, error: string): boolean {
    return this.db.prepare(`UPDATE asset_extraction_jobs SET status='failed', error=?, owner=NULL, lease_until=NULL
      WHERE project_id=? AND id=? AND owner=? AND status='running' AND lease_until>?`)
      .run(error, claim.projectId, claim.jobId, claim.owner, this.now()).changes > 0
  }

  complete(claim: ClaimKey, counts: { added: number; reused: number }): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE asset_extraction_jobs SET status='completed', completed=total, stage=NULL,
        added=?, reused=?, owner=NULL, lease_until=NULL
        WHERE project_id=? AND id=? AND owner=? AND status='running' AND lease_until>?`)
        .run(counts.added, counts.reused, claim.projectId, claim.jobId, claim.owner, this.now())
      if (!result.changes) return false
      this.db.prepare('DELETE FROM asset_extraction_payloads WHERE project_id=?').run(claim.projectId)
      return true
    }).immediate()
  }

  owns(claim: ClaimKey): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM asset_extraction_jobs
      WHERE project_id=? AND id=? AND owner=? AND status='running' AND lease_until>?`)
      .get(claim.projectId, claim.jobId, claim.owner, this.now()))
  }
}
