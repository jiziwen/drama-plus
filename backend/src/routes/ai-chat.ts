import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { CHAT_ATTACHMENT_TOTAL_BYTES } from '../services/ai-chat-attachment-limits.js'
import { readChatAttachments, type ChatAttachmentInput } from '../services/ai-chat-attachments.js'
import {
  compressChatContext,
  computeChatBudgets,
  createChatRunner,
  createChatSession,
  deleteChatSession,
  getChatSession,
  getDefaultChatModelInfo,
  listChatModels,
  listChatSessions,
  runChatTurn,
  saveChatSession,
  type ChatRunner,
} from '../services/ai-chat-service.js'
import type { ChatModelSelection } from '../services/ai-chat-types.js'
import { projectModelSelection } from '../services/project-model-options.js'
import { safeTaskError } from '../services/video-download.js'
import { badRequest, created, notFound, success } from '../utils/response.js'

const createSessionSchema = z.object({
  title: z.string().trim().max(120).optional(),
  model: projectModelSelection.nullable().optional(),
})

const updateSessionSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  model: projectModelSelection.nullable().optional(),
})

const messageRequestSchema = z.object({
  content: z.string().max(500_000).optional(),
  regenerate: z.boolean().optional(),
  model: projectModelSelection.nullable().optional(),
})

export type AiChatRouteDeps = {
  createRunner?: (selection?: ChatModelSelection | null) => Promise<ChatRunner>
}

function validateModelSelection(selection: ChatModelSelection | null | undefined) {
  if (!selection) return
  const { models } = listChatModels()
  const found = models.some(m => m.configId === selection.configId && m.model === selection.model)
  if (!found) {
    throw new Error('所选文字模型不可用，请重新选择或切换为默认模型。')
  }
}

export function createAiChatRoutes(deps: AiChatRouteDeps = {}) {
  const app = new Hono()
  const makeRunner = deps.createRunner ?? createChatRunner
  const busySessions = new Set<string>()
  const busy = (c: Parameters<typeof badRequest>[0]) => c.json({ code: 409, message: '这条对话正在处理，请稍后再试。' }, 409)

  // GET /ai-chat/models
  app.get('/models', async (c) => {
    const { models } = listChatModels()
    const defaultModel = await getDefaultChatModelInfo()
    return success(c, { models, defaultModel })
  })

  // GET /ai-chat/sessions
  app.get('/sessions', (c) => {
    return success(c, listChatSessions())
  })

  // POST /ai-chat/sessions
  app.post('/sessions', async (c) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return badRequest(c, '会话参数无效')
    try {
      validateModelSelection(parsed.data.model)
    } catch (error) {
      return badRequest(c, safeTaskError(error))
    }
    const session = createChatSession(parsed.data)
    return created(c, session)
  })

  // GET /ai-chat/sessions/:id
  app.get('/sessions/:id', (c) => {
    const session = getChatSession(c.req.param('id'))
    if (!session) return notFound(c, '对话不存在')
    return success(c, session)
  })

  // PATCH /ai-chat/sessions/:id
  app.patch('/sessions/:id', async (c) => {
    const parsed = updateSessionSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return badRequest(c, '更新参数无效')
    const id = c.req.param('id')
    if (busySessions.has(id)) return busy(c)
    const session = getChatSession(id)
    if (!session) return notFound(c, '对话不存在')

    if ('model' in parsed.data) {
      try {
        validateModelSelection(parsed.data.model)
      } catch (error) {
        return badRequest(c, safeTaskError(error))
      }
      session.model = parsed.data.model ?? null
    }
    if (parsed.data.title !== undefined) {
      session.title = parsed.data.title
    }
    return success(c, saveChatSession(session))
  })

  // DELETE /ai-chat/sessions/:id
  app.delete('/sessions/:id', (c) => {
    const id = c.req.param('id')
    if (busySessions.has(id)) return busy(c)
    if (!deleteChatSession(id)) return notFound(c, '对话不存在')
    return success(c, { id })
  })

  // POST /ai-chat/sessions/:id/compress — 手动触发上下文压缩
  app.post('/sessions/:id/compress', async (c) => {
    const id = c.req.param('id')
    if (busySessions.has(id)) return busy(c)
    const session = getChatSession(id)
    if (!session) return notFound(c, '对话不存在')
    if (session.messages.length <= 1 || session.compressedUntil >= session.messages.length - 1) {
      return badRequest(c, '当前没有需要压缩的历史对话。')
    }
    busySessions.add(id)
    try {
      const runner = await makeRunner(session.model)
      const budgets = computeChatBudgets(runner.limits)
      const result = await compressChatContext({
        session,
        runner,
        budget: budgets.proactiveInputBudget,
        maxOutputTokens: budgets.maxOutputTokens,
        signal: c.req.raw.signal,
        aggressive: false,
      })
      const saved = saveChatSession(result.session)
      return success(c, { session: saved, compression: result.compression })
    } catch (error) {
      return badRequest(c, safeTaskError(error))
    } finally {
      busySessions.delete(id)
    }
  })

  // POST /ai-chat/sessions/:id/messages — 流式对话（SSE）
  app.post('/sessions/:id/messages', bodyLimit({
    maxSize: CHAT_ATTACHMENT_TOTAL_BYTES + 4 * 1024 * 1024,
    onError: c => c.json({ code: 413, message: '消息过大，附件合计最多 20 MB。' }, 413),
  }), async (c) => {
    const id = c.req.param('id')
    if (busySessions.has(id)) return busy(c)
    const multipart = /^multipart\/form-data\s*(?:;|$)/iu.test(c.req.header('Content-Type') ?? '')
    let payload: unknown
    let files: File[] = []
    if (multipart) {
      const form = await c.req.formData().catch(() => null)
      const fields = form?.getAll('files') ?? []
      if (!form || !fields.every((field): field is File => typeof field !== 'string')) return badRequest(c, '无法读取消息附件。')
      files = fields
      const message = form.get('message')
      if (typeof message === 'string') {
        try { payload = JSON.parse(message) } catch { /* validated below */ }
      }
    } else {
      payload = await c.req.json().catch(() => null)
    }

    const parsed = messageRequestSchema.safeParse(payload)
    if (!parsed.success) return badRequest(c, '消息参数无效')

    const { content, regenerate, model } = parsed.data
    if (regenerate && files.length) return badRequest(c, '重新生成时会使用原消息的附件。')
    if (!regenerate && !content?.trim() && !files.length) {
      return badRequest(c, '请输入消息内容或添加文件。')
    }

    if (busySessions.has(id)) return busy(c)
    const session = getChatSession(id)
    if (!session) return notFound(c, '对话不存在')
    if (model !== undefined) {
      try {
        validateModelSelection(model)
      } catch (error) {
        return badRequest(c, safeTaskError(error))
      }
      session.model = model
    }

    busySessions.add(id)
    let attachments: ChatAttachmentInput[]
    try {
      attachments = await readChatAttachments(files, c.req.raw.signal)
    } catch (error) {
      busySessions.delete(id)
      return badRequest(c, safeTaskError(error))
    }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    c.req.raw.signal.addEventListener('abort', onAbort, { once: true })
    if (c.req.raw.signal.aborted) onAbort()

    return streamSSE(c, async (stream) => {
      stream.onAbort(onAbort)
      let writeChain = Promise.resolve()
      const enqueue = (event: string, data: unknown) => {
        writeChain = writeChain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => {})
      }
      try {
        controller.signal.throwIfAborted()
        const runner = await makeRunner(session.model)
        controller.signal.throwIfAborted()
        await runChatTurn({
          session,
          userContent: content,
          userAttachments: attachments,
          regenerate,
          runner,
          signal: controller.signal,
          emit(item) {
            enqueue(item.event, item.data)
          },
        })
      } catch (error) {
        if (!controller.signal.aborted) {
          enqueue('error', { message: safeTaskError(error) })
        }
      } finally {
        busySessions.delete(id)
        await writeChain
        c.req.raw.signal.removeEventListener('abort', onAbort)
      }
    })
  })

  return app
}

export default createAiChatRoutes()
