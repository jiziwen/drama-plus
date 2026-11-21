import Database from 'better-sqlite3'
import path from 'node:path'
import type { ScriptVideoJob, ScriptVideoProject } from './script-video-store.js'

export type ScriptVideoRecord = {
  project: ScriptVideoProject
  jobs: ScriptVideoJob[]
  storageVersion?: number
  episodeRevision?: number
  scope?: string
  originalEpisodes?: Map<string, string>
}
export type ProjectRow = {
  id: string
  title: string
  revision: number
  version: number
  shared: string
  assets: string
  episode_order: string
}
type EpisodeRow = { id: string; document: string; revision: number }
type JobRow = { document: string }

function episodeSummary(episode: ScriptVideoProject['episodes'][number]) {
  const cards: any[] = episode.cards || []
  const hasStoryboard = !!episode.production || cards.every(card =>
    card.manuallyAdded || (card.shots?.length && card.prompt?.trim()),
  )
  let progress: string | undefined
  if (episode.confirmed && cards.length) {
    if (!episode.outlineConfirmed || !hasStoryboard) progress = '制作中-大纲'
    else progress = cards.every(card => card.status === 'ready' && card.videoUrl?.trim()) ? '已完成' : '制作中-视频制作'
  }
  return {
    id: episode.id,
    title: episode.title,
    number: episode.number,
    stage: episode.stage,
    confirmed: !!episode.confirmed,
    outlineConfirmed: !!episode.outlineConfirmed,
    progress,
    cardCount: cards.length,
  }
}

export class ScriptVideoDatabase {
  readonly db: Database.Database
  constructor(directory: string) {
    this.db = new Database(path.join(directory, 'workspace.sqlite3'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL,
        shared TEXT NOT NULL, assets TEXT NOT NULL, episode_order TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS episodes (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL, revision INTEGER NOT NULL,
        document TEXT NOT NULL, summary TEXT NOT NULL, activity TEXT NOT NULL, PRIMARY KEY(project_id,id)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, id TEXT NOT NULL, episode_id TEXT NOT NULL,
        action TEXT NOT NULL, status TEXT NOT NULL, task_id INTEGER, document TEXT NOT NULL, PRIMARY KEY(project_id,id)
      );
      CREATE INDEX IF NOT EXISTS jobs_episode ON jobs(project_id,episode_id);
      CREATE INDEX IF NOT EXISTS jobs_active ON jobs(status,project_id);
      CREATE INDEX IF NOT EXISTS jobs_task ON jobs(project_id,task_id) WHERE task_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS client_writes (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, client_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        PRIMARY KEY(project_id,client_id)
      );
      CREATE TABLE IF NOT EXISTS imported_files (id TEXT PRIMARY KEY);
    `)
  }

  project(id: string) {
    return this.db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id=?').get(id)
  }

  directory() {
    return this.db.prepare<[], Pick<ProjectRow, 'id' | 'title' | 'revision'>>('SELECT id,title,revision FROM projects ORDER BY id').all()
  }

  shared(row: ProjectRow): ScriptVideoProject {
    return { ...JSON.parse(row.shared), assets: JSON.parse(row.assets), revision: row.revision, episodes: [] }
  }

  summary(row: ProjectRow) {
    const rows = this.db.prepare<[string], { id: string; summary: string; revision: number }>(
      'SELECT id,summary,revision FROM episodes WHERE project_id=?',
    ).all(row.id)
    const byId = new Map(rows.map(item => [item.id, { ...JSON.parse(item.summary), revision: item.revision }]))
    const project = this.shared(row)
    project.episodes = JSON.parse(row.episode_order).map((id: string) => byId.get(id))
    return project
  }

  episode(id: string, episodeId: string) {
    const row = this.db.prepare<[string, string], { document: string; revision: number; episodeRevision: number }>(`
      SELECT e.document,e.revision AS episodeRevision,p.revision FROM episodes e JOIN projects p ON p.id=e.project_id
      WHERE e.project_id=? AND e.id=?`).get(id, episodeId)
    return row && { episode: JSON.parse(row.document), episodeRevision: row.episodeRevision, revision: row.revision }
  }

  allEpisodes(row: ProjectRow) {
    const entries = this.db.prepare<[string], EpisodeRow>('SELECT id,document FROM episodes WHERE project_id=?').all(row.id)
    const byId = new Map(entries.map(entry => [entry.id, JSON.parse(entry.document)]))
    return (JSON.parse(row.episode_order) as string[]).map(id => byId.get(id))
  }

  jobs(id: string, episodeId?: string): ScriptVideoJob[] {
    const query = 'SELECT document FROM jobs WHERE project_id=?'
    const entries = episodeId
      ? this.db.prepare<[string, string], JobRow>(query + ' AND episode_id=? ORDER BY rowid').all(id, episodeId)
      : this.db.prepare<[string], JobRow>(query + ' ORDER BY rowid').all(id)
    return entries.map(entry => JSON.parse(entry.document))
  }

  restoreJobs(projectId: string, episodeId: string): ScriptVideoJob[] {
    const rows = this.db.prepare<[string, string], JobRow>(`
      WITH recent AS (
        SELECT rowid AS sequence,action,status FROM jobs WHERE project_id=? AND episode_id=? AND action<>'video'
      )
      SELECT CASE WHEN action='review' AND status='completed' THEN document
        ELSE json_remove(document,'$.result') END AS document
      FROM jobs WHERE rowid IN (
        SELECT MAX(sequence) FROM recent UNION
        SELECT MAX(sequence) FROM recent WHERE action='review' AND status='completed' UNION
        SELECT MAX(sequence) FROM recent WHERE status IN ('queued','running')
      ) ORDER BY rowid`).all(projectId, episodeId)
    return rows.map(row => JSON.parse(row.document))
  }

  activity(id: string, episodeId: string) {
    const episode = this.db.prepare<[string, string], { activity: string; revision: number; episodeRevision: number }>(`
      SELECT e.activity,e.revision AS episodeRevision,p.revision FROM episodes e JOIN projects p ON p.id=e.project_id
      WHERE e.project_id=? AND e.id=?
    `).get(id, episodeId)
    if (!episode) return
    const jobs = this.db.prepare<[string, string], { document: string }>(`
      SELECT json_remove(document,'$.checkpoint','$.resumeKey','$.lightingChecks','$.videoReferenceNames','$.result','$.ownerSession','$.requestId') AS document
      FROM jobs WHERE project_id=? AND episode_id=? AND status IN ('queued','running') ORDER BY rowid
    `).all(id, episodeId).map(row => JSON.parse(row.document) as ScriptVideoJob)
    const activeCardIds = jobs.flatMap(job => job.action === 'video' && job.cardId ? [job.cardId] : [])
    return {
      revision: episode.revision,
      episodeRevision: episode.episodeRevision,
      tasks: JSON.parse(episode.activity),
      jobs,
      activeCardIds: [...new Set(activeCardIds)],
    }
  }

  putEpisode(projectId: string, episode: ScriptVideoProject['episodes'][number]) {
    const document = JSON.stringify(episode)
    this.db.prepare(`INSERT INTO episodes(project_id,id,revision,document,summary,activity) VALUES(?,?,1,?,?,?)
      ON CONFLICT(project_id,id) DO UPDATE SET revision=episodes.revision+1,document=excluded.document,
      summary=excluded.summary,activity=excluded.activity WHERE episodes.document<>excluded.document`)
      .run(projectId, episode.id, document, JSON.stringify(episodeSummary(episode)), JSON.stringify(episode.tasks || []))
  }

  putProject(project: ScriptVideoProject, order: string[], prior?: ProjectRow) {
    const { episodes: _episodes, revision, assets, ...shared } = project
    const sharedJson = JSON.stringify(shared), assetJson = JSON.stringify(assets), orderJson = JSON.stringify(order)
    if (prior && prior.shared === sharedJson && prior.assets === assetJson && prior.episode_order === orderJson) {
      this.db.prepare('UPDATE projects SET revision=?,version=version+1 WHERE id=?').run(revision, project.id)
      return
    }
    this.db.prepare(`INSERT INTO projects(id,title,revision,version,shared,assets,episode_order) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, revision=excluded.revision, version=projects.version+1,
      shared=excluded.shared,assets=excluded.assets,episode_order=excluded.episode_order`)
      .run(project.id, project.title, revision, sharedJson, assetJson, orderJson)
  }

  putJobs(projectId: string, jobs: ScriptVideoJob[], scope?: string) {
    const expected = new Set(jobs.map(job => job.id))
    const rows = scope ? this.db.prepare<[string, string], { id: string }>('SELECT id FROM jobs WHERE project_id=? AND episode_id=?').all(projectId, scope)
      : this.db.prepare<[string], { id: string }>('SELECT id FROM jobs WHERE project_id=?').all(projectId)
    const remove = this.db.prepare('DELETE FROM jobs WHERE project_id=? AND id=?')
    for (const row of rows) if (!expected.has(row.id)) remove.run(projectId, row.id)
    const insert = this.db.prepare(`INSERT INTO jobs(project_id,id,episode_id,action,status,task_id,document) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project_id,id) DO UPDATE SET episode_id=excluded.episode_id,action=excluded.action,status=excluded.status,
      task_id=excluded.task_id,document=excluded.document WHERE jobs.document<>excluded.document`)
    for (const job of jobs) insert.run(projectId, job.id, job.episodeId, job.action, job.status, job.taskId ?? null, JSON.stringify(job))
  }
}
