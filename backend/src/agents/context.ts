/**
 * Agent 请求上下文 — 通过 Mastra RequestContext 按请求注入
 * 路由层 build → generate({ requestContext }) → 工具 execute 内读取
 */
import { RequestContext } from '@mastra/core/request-context'
import type { ContentLanguage } from '../services/app-settings.js'

interface ScriptRevision {
  source: string
  revisedContent?: string
}

export interface AgentRequestContextValues {
  episodeId: number
  dramaId: number
  modelOverride?: string
  textConfigId?: number
  scriptRevision?: ScriptRevision
  /** AI 内容语言固定为中文。 */
  language?: ContentLanguage
}

export function buildAgentRequestContext(values: AgentRequestContextValues): RequestContext<AgentRequestContextValues> {
  const rc = new RequestContext<AgentRequestContextValues>()
  rc.set('episodeId', values.episodeId)
  rc.set('dramaId', values.dramaId)
  if (values.modelOverride) rc.set('modelOverride', values.modelOverride)
  if (values.textConfigId) rc.set('textConfigId', values.textConfigId)
  if (values.scriptRevision) rc.set('scriptRevision', values.scriptRevision)
  rc.set('language', 'zh')
  return rc
}

export function getEpisodeId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('episodeId' as never)
  return typeof v === 'number' ? v : null
}

export function getDramaId(requestContext: RequestContext | undefined): number | null {
  const v = requestContext?.get('dramaId' as never)
  return typeof v === 'number' ? v : null
}

export function getScriptRevision(requestContext: RequestContext | undefined): ScriptRevision | undefined {
  return requestContext?.get('scriptRevision' as never)
}
