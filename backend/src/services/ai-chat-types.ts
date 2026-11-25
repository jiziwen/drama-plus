import type { ProjectModelSelection } from './project-model-options.js'
import type { TextModelLimits } from './script-video-output-limit.js'

export type ChatModelSelection = ProjectModelSelection

export type ChatModelOption = ChatModelSelection & {
  provider: string
  configName: string
  limits?: TextModelLimits
}

export type ChatMessageRole = 'user' | 'assistant'

export type ChatAttachment = { name: string; size: number }

export type ChatCompressionNotice = {
  compressedCount: number
  beforeTokens: number
  afterTokens: number
  summaryPreview?: string
}

export type ChatMessage = {
  id: string
  role: ChatMessageRole
  content: string
  attachments?: ChatAttachment[]
  reasoning?: string
  model?: string
  configName?: string
  compression?: ChatCompressionNotice
  error?: string
  createdAt: string
}

export type ChatSessionSummary = {
  id: string
  title: string
  model: ChatModelSelection | null
  compressedUntil: number
  messageCount: number
  lastInputTokens?: number
  contextWindow?: number
  createdAt: string
  updatedAt: string
}

export type ChatSession = ChatSessionSummary & {
  summary?: string
  messages: ChatMessage[]
}

export type ChatStreamEvent =
  | { event: 'session'; data: { session: ChatSession } }
  | { event: 'status'; data: { phase: 'thinking' | 'compressing' | 'answering'; message: string } }
  | { event: 'compressed'; data: { summary: string; compressedUntil: number; compression: ChatCompressionNotice; message: string } }
  | { event: 'reasoning'; data: { delta: string } }
  | { event: 'delta'; data: { delta: string } }
  | { event: 'done'; data: { message: ChatMessage; session: ChatSession } }
  | { event: 'error'; data: { message: string; partialMessage?: ChatMessage; session?: ChatSession } }
