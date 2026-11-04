/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { validAgentTypes } from '../agents/index.js'
import { buildAgentRequestContext, type AgentRequestContextValues } from '../agents/context.js'
import { db, schema } from '../db/index.js'
import { mastra } from '../mastra/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskProgress, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

function agentFailureMessage(error: any) {
  let cause = error
  for (let depth = 0; cause && depth < 6; depth++, cause = cause.cause) {
    if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(cause.code) || cause.name === 'TimeoutError') {
      return '文字接口请求超时，本次生成未完成。请稍后重试或切换文字接口。'
    }
  }
  if (error?.message === 'fetch failed' || /Cannot connect to API|Connect Timeout/i.test(error?.message || '')) {
    return '文字接口连接失败，本次生成未完成。请检查接口地址与网络，或切换文字接口。'
  }
  return error?.message || 'Agent 执行失败'
}

// Mastra v1.17 的 ToolCallChunk / ToolResultChunk 结构：
// { type: 'tool-call', payload: { toolCallId, toolName, args } }
// { type: 'tool-result', payload: { toolCallId, toolName, result, isError } }
function normalizeToolName(entry: any) {
  return entry?.payload?.toolName
    || entry?.toolName
    || entry?.tool?.toolName
    || entry?.tool?.id
    || entry?.name
    || entry?.type
    || null
}

function normalizeToolResult(entry: any) {
  const result = entry?.payload?.result ?? entry?.result ?? entry?.payload?.output ?? entry?.output ?? entry?.data ?? null
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// POST /agent/:type/chat — 非流式 Agent 对话
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = mastra.getAgent(agentType)
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const startTime = performance.now()

  try {
    let scriptRevision: AgentRequestContextValues['scriptRevision']
    let savedScript: string | null = null
    let userMessage = message
    const { episodes } = schema
    const targetEpisode = and(eq(episodes.id, episode_id), eq(episodes.dramaId, drama_id), isNull(episodes.deletedAt))
    if (agentType === 'script_rewriter' && body.rewrite_instructions !== undefined) {
      if (typeof body.rewrite_instructions !== 'string' || !body.rewrite_instructions.trim()) return badRequest(c, '请填写剧本改写要求')
      if (body.script_content !== undefined && typeof body.script_content !== 'string') return badRequest(c, '剧本内容必须为文字')
      const [episode] = await db.select({ scriptContent: episodes.scriptContent }).from(episodes).where(targetEpisode)
      if (!episode) return badRequest(c, '剧集不存在或不属于此项目')
      savedScript = episode.scriptContent
      const source = body.script_content ?? savedScript
      if (!source?.trim()) return badRequest(c, '请先准备要改写的剧本')
      scriptRevision = { source }
      userMessage = `请修订当前格式化剧本，并提交修改后的完整剧本。\n\n本次改写要求：\n${body.rewrite_instructions.trim()}`
    }
    const requestContext = buildAgentRequestContext({
      episodeId: episode_id,
      dramaId: drama_id,
      modelOverride: body.model || undefined,
      textConfigId: body.config_id || undefined,
      scriptRevision,
    })
    const result = await agent.generate(
      [{ role: 'user', content: userMessage }],
      { maxSteps: 20, requestContext },
    )

    if (scriptRevision) {
      if (!scriptRevision.revisedContent || ['error', 'length', 'content-filter'].includes(result.finishReason ?? '')) {
        throw new Error('未能完成剧本改写，请重试')
      }
      const previousScript = savedScript === null ? isNull(episodes.scriptContent) : eq(episodes.scriptContent, savedScript)
      const updated = db.update(episodes).set({ scriptContent: scriptRevision.revisedContent, updatedAt: now() })
        .where(and(targetEpisode, previousScript)).run()
      if (!updated.changes) throw new Error('改写期间剧本已更新，请刷新后重试')
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    // 收集所有 tool calls 和 results
    const toolCalls = result.toolCalls || []
    const toolResults = result.toolResults || []
    const normalizedToolCalls = toolCalls.map((tc: any) => ({
      toolName: normalizeToolName(tc),
      args: tc?.payload?.args ?? tc?.args ?? tc?.input ?? null,
    }))
    const normalizedToolResults = toolResults.map((tr: any) => ({
      toolName: normalizeToolName(tr),
      result: normalizeToolResult(tr),
    }))

    logTaskProgress('Agent', 'tool-summary', {
      agentType,
      toolCalls: normalizedToolCalls.map((tc: any) => tc.toolName),
      toolResults: normalizedToolResults.map((tr: any) => tr.toolName),
    })
    logTaskPayload('Agent', `${agentType} tool-results`, normalizedToolResults)

    return success(c, {
      type: 'done',
      text: result.text || '',
      ...(scriptRevision ? { script_content: scriptRevision.revisedContent } : {}),
      toolCalls: normalizedToolCalls,
      toolResults: normalizedToolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, agentFailureMessage(err))
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
