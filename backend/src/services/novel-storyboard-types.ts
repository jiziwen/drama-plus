import type { ProjectModelKind, ProjectModelSelection } from './project-model-options.js'

export type NovelPace = 'fast' | 'normal'

export interface NovelShot {
  seconds: number
  camera: string
  action: string
  sound: string
}

export interface NovelSegment {
  scene: string
  cast: string[]
  incoming: string
  outgoing: string
  direction: string
  shots: NovelShot[]
  combat: boolean
}

export interface NovelStoryboard {
  version: number
  pace: NovelPace
  summary: string
  visualStyle: string
  voices: { name: string; appearance: string; voice: string }[]
  screens: string
  segments: NovelSegment[]
  review: string
}

export interface NovelChapterSummary {
  number: number
  title: string
  version: number
  segmentCount: number
}

export interface NovelChapter extends NovelChapterSummary {
  source: string
  storyboard?: NovelStoryboard
}

export type NovelAssetKind = 'character' | 'scene' | 'prop' | 'creature' | 'other'

export interface NovelAsset {
  id: string
  kind: NovelAssetKind
  name: string
  description: string
  prompt: string
  appearances: { chapter: number; segments: number[] }[]
  taskId?: number
  imageStatus?: 'running' | 'ready' | 'failed'
  image?: string
  imageError?: string
}

export interface NovelJob {
  id: string
  action: 'generate' | 'chapter' | 'assets' | 'image'
  status: 'running' | 'completed' | 'failed' | 'stopped'
  phase: string
  chapter?: number
  error?: string
}

export interface NovelProjectSummary {
  id: string
  title: string
  fileName: string
  updatedAt: string
}

export interface NovelProject extends NovelProjectSummary {
  revision: number
  pace: NovelPace
  models?: Partial<Record<ProjectModelKind, ProjectModelSelection>>
  adaptationNotes?: string
  chapters: NovelChapterSummary[]
  assets: NovelAsset[]
  assetsCurrent: boolean
  job?: NovelJob
}

export type NovelCommand =
  | { action: 'pace'; pace: NovelPace }
  | { action: 'selectModel'; kind: ProjectModelKind; selection: ProjectModelSelection | null }
  | { action: 'generate' }
  | { action: 'assets' }
  | { action: 'stop'; jobId: string }
  | { action: 'chapter'; chapter: number; notes?: string }
  | { action: 'image'; assetId: string; prompt: string }
