export const DRAMA_REFERENCE_UPLOAD_MB = 20
export const DRAMA_REFERENCE_UPLOAD_BYTES = DRAMA_REFERENCE_UPLOAD_MB * 1024 * 1024
/** Keep manually editable text in the project document up to this size. Larger text is stored separately. */
export const DRAMA_INLINE_REFERENCE_CHARACTERS = 40_000
export const DRAMA_REFERENCE_PREVIEW_CHARACTERS = 4_000

export type DramaReferenceFile = { name: string; bytes: number; characters: number; preview: string }

export type DramaBrief = {
  reference: string
  direction: string
  chapterCount: number
  chapterWords: number
  runtimeMinutes: number
  style: 'live' | '3d'
  humor: boolean
}

export type DramaPitch = { title: string; conflict: string; premise: string; hook: string }
export type DramaOutline = {
  title: string
  world: string
  characters: string
  chapters: { title: string; plan: string }[]
}
export type DramaChapter = {
  title: string
  text: string
  summary: string
  continuity: string
  dialogueNotes: string
}
export type DramaLogicIssue = { chapter: number; problem: string; fix: string }
export type DramaOpeningMode = 'conflict' | 'narrated'
export type DramaOpening = { title: string; text: string }
export type DramaAsset = {
  id: string
  kind: 'character' | 'scene' | 'prop'
  name: string
  prompt: string
  image?: string
  taskId?: number
  imageStatus?: 'running' | 'ready' | 'failed' | 'delivery_pending'
  imageCanRetryDelivery?: boolean
  imageError?: string
}
export type DramaJobAction = 'analyze' | 'outline' | 'write' | 'logic' | 'opening' | 'pace' | 'revise' | 'assets' | 'image' | 'images' | 'deliver'
export type DramaJob = { id: string; action: DramaJobAction; phase: string; status: 'running' | 'done' | 'failed'; error?: string }
export type DramaDelivery = { projectId: string; episodeId: string }
export type { ProjectModelOption as DramaModelOption } from './project-model-options.js'
import type { ProjectModelKind as DramaModelKind, ProjectModelSelection as DramaModelSelection } from './project-model-options.js'
export type { DramaModelKind, DramaModelSelection }
export type DownmarketDrama = {
  id: string
  title: string
  revision: number
  updatedAt: string
  brief: DramaBrief
  referenceFile?: DramaReferenceFile
  models?: Partial<Record<DramaModelKind, DramaModelSelection>>
  analysis?: string
  pitches?: DramaPitch[]
  selectedPitch?: number
  outline?: DramaOutline
  outlineConfirmed: boolean
  chapters: DramaChapter[]
  logic?: { verdict: string; issues: DramaLogicIssue[] }
  opening?: { mode: DramaOpeningMode; options: DramaOpening[] }
  pacing: Record<number, { needsEdit: boolean; plan: string }>
  candidate?: { chapter: number; content: DramaChapter }
  finalized: boolean
  assets: DramaAsset[]
  assetsCurrent: boolean
  delivery?: DramaDelivery
  job?: DramaJob
}

export type DownmarketDramaListItem = Pick<DownmarketDrama, 'id' | 'title' | 'revision' | 'updatedAt'>
export type DownmarketDramaProgress = { draft: DownmarketDrama } | {
  revision: number
  job?: DramaJob
  images: Pick<DramaAsset, 'id' | 'taskId' | 'image' | 'imageStatus' | 'imageError' | 'imageCanRetryDelivery'>[]
}
export type DramaRevisionSource = 'logic' | 'opening' | 'pace'
export type DramaCommand =
  | { action: 'saveBrief'; brief: DramaBrief }
  | { action: 'clearReference' }
  | { action: 'selectModel'; kind: DramaModelKind; selection: DramaModelSelection | null }
  | { action: 'confirmOutline'; outline: DramaOutline }
  | { action: 'saveChapter'; chapter: number; content: DramaChapter }
  | { action: 'discardCandidate' | 'finalize' | 'stop' | 'analyze' | 'write' | 'logic' | 'assets' | 'images' }
  | { action: 'outline'; pitch: number; notes?: string }
  | { action: 'opening'; mode: DramaOpeningMode; reference?: string; notes?: string }
  | { action: 'pace'; chapter: number }
  | { action: 'revise'; chapter: number; source: DramaRevisionSource; notes?: string }
  | { action: 'image'; assetId: string; prompt: string; reference?: string }
  | { action: 'deliver'; allowMissingImages: boolean }
