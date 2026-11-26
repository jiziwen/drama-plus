import { z } from 'zod'
import { ScriptVideoAIError } from './script-video-types.js'
import { isScriptVideoTimingQuestion } from './script-video-speech-planning.js'
import { SCRIPT_VIDEO_TEXT_TIMEOUT_MS } from './script-video-text-timeout.js'

type ResolvedModel = Awaited<ReturnType<typeof import('../agents/index.js').resolveScriptVideoTextModel>>
type ResolveModel = (model?: string, configId?: number) => Promise<{
  model: Pick<ResolvedModel['model'], 'doGenerate'>
  maxOutputTokens?: number
}>

const submitDraftDescriptions = {
  episode: '一次交付本次要求的完整内容。时间表调整时先写 timingPlan，然后写本次需要的 production 和 cards。',
  repair: '一次提交本轮定点修复。用 patches 填写指定片段的变更，制作规格有误时同时提交 production。',
  continuity_review: '一次提交整集衔接复核，填写 passed、continuityReview 和 issues。',
}

export type ScriptVideoWholeModelRequest = {
  instructions: string
  message: string
  signal?: AbortSignal
  schema: z.ZodType
  mode?: keyof typeof submitDraftDescriptions
  model?: string
  configId?: number
  stylePrefix?: string
  onTimingPlan?: (timingPlan: unknown) => void | Promise<void>
  onProduction?: (production: unknown) => void | Promise<void>
  onCard?: (card: unknown, index: number) => void | Promise<void>
}

const resolveWholeModel: ResolveModel = async (model, configId) => {
  const { resolveScriptVideoTextModel } = await import('../agents/index.js')
  return resolveScriptVideoTextModel(model, configId, false)
}

function parseJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// A truncated draft can still contain complete objects. Save only closed
// objects that JSON.parse accepts, in their original position.
class DraftCheckpoints {
  private depth = 0
  private quoted = false
  private escaped = false
  private rootKey = ''
  private inCards = false
  private pending?: { type: 'timingPlan' | 'production' | 'card'; depth: number; text: string }
  private cardIndex = 0

  constructor(private callbacks: Pick<ScriptVideoWholeModelRequest, 'onTimingPlan' | 'onProduction' | 'onCard' | 'signal'>) {}

  async write(delta: string) {
    if (!this.callbacks.onTimingPlan && !this.callbacks.onCard && !this.callbacks.onProduction) return
    for (const char of delta) {
      if (this.pending) this.pending.text += char
      if (this.quoted) {
        if (this.escaped) this.escaped = false
        else if (char === '\\') this.escaped = true
        else if (char === '"') this.quoted = false
        else if (this.depth === 1 && this.rootKey.length < 16) this.rootKey += char
        continue
      }
      if (char === '"') {
        this.quoted = true
        if (this.depth === 1) this.rootKey = ''
      } else if (char === '[' || char === '{') {
        if (this.depth === 1) {
          this.inCards = this.rootKey === 'cards' && char === '['
          if (this.inCards) this.cardIndex = 0
        }
        const top = this.depth === 1 && (this.rootKey === 'production' || this.rootKey === 'timingPlan') ? this.rootKey : undefined
        const isCard = this.depth === 2 && this.inCards
        this.depth++
        if (char === '{' && (isCard || top)) {
          this.pending = { type: top || 'card', depth: this.depth, text: char }
        }
      } else if (char === '}' || char === ']') {
        if (this.pending?.depth === this.depth) {
          this.callbacks.signal?.throwIfAborted()
          const { type, text } = this.pending
          this.pending = undefined
          const value = parseJson(text)
          if (type === 'timingPlan' && value !== undefined) await this.callbacks.onTimingPlan?.(value)
          if (type === 'production' && value !== undefined) await this.callbacks.onProduction?.(value)
          if (type === 'card' && value !== undefined) await this.callbacks.onCard?.(value, this.cardIndex)
        }
        this.depth--
        if (this.depth < 2) this.inCards = false
      } else if (char === ',' && this.depth === 2 && this.inCards) this.cardIndex++
    }
  }
}

const clarification = z.object({ question: z.string().trim().min(1).max(1200) })

// Zod types all supported JSON Schema drafts as one union.
type ModelTools = NonNullable<Parameters<ResolvedModel['model']['doGenerate']>[0]['tools']>
type InputSchema = Extract<ModelTools[number], { type: 'function' }>['inputSchema']
const inputSchema = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as InputSchema

/** The provider SDK makes one non-streaming HTTP request. Tools here describe the
 * shape of that single response; they never execute or start an agent step. */
export async function runScriptVideoWholeModel(
  request: ScriptVideoWholeModelRequest,
  resolveModel: ResolveModel = resolveWholeModel,
): Promise<unknown> {
  request.signal?.throwIfAborted()
  let resolved
  try {
    resolved = await resolveModel(request.model, request.configId)
  } catch {
    request.signal?.throwIfAborted()
    throw new ScriptVideoAIError('TEXT_MODEL_UNAVAILABLE', '所选文字模型配置不可用，请核对模型与服务配置。', [], 400)
  }
  const deadline = AbortSignal.timeout(SCRIPT_VIDEO_TEXT_TIMEOUT_MS)
  const controller = new AbortController()
  const signal = AbortSignal.any([deadline, controller.signal, ...(request.signal ? [request.signal] : [])])
  try {
    signal.throwIfAborted()
    const result = await resolved.model.doGenerate({
      prompt: [
        { role: 'system', content: request.instructions },
        { role: 'user', content: [{ type: 'text', text: request.message }] },
        ...(request.stylePrefix ? [{
          role: 'user' as const, content: [{ type: 'text' as const, text: request.stylePrefix }],
        }] : []),
      ],
      maxOutputTokens: resolved.maxOutputTokens,
      abortSignal: signal,
      tools: [
        {
          type: 'function', name: 'submit_draft', strict: false,
          description: submitDraftDescriptions[request.mode ?? 'episode'],
          inputSchema: inputSchema(request.schema),
        },
        {
          type: 'function', name: 'request_clarification', strict: false,
          description: '仅用于影响理解且原文无法解决的剧情事实或身份缺失。角色造型、对白时长、动作裁剪、跨段与增时均由编排完成。',
          inputSchema: inputSchema(clarification),
        },
      ],
      toolChoice: { type: 'auto' },
    })
    signal.throwIfAborted()
    const finish = result.finishReason.unified
    const text: string[] = []
    let draftArgs: string | undefined
    let question = ''
    for (const part of result.content) {
      if (part.type === 'text') text.push(part.text)
      if (part.type !== 'tool-call') continue
      if (part.toolName === 'submit_draft') draftArgs ??= part.input
      if (part.toolName === 'request_clarification') {
        const parsed = clarification.safeParse(parseJson(part.input))
        if (parsed.success) question = parsed.data.question
      }
    }
    const answer = draftArgs ?? text.join('').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi, '')
    if (finish === 'length') {
      await new DraftCheckpoints(request).write(answer)
      const { total: outputTokens, reasoning: reasoningTokens } = result.usage.outputTokens
      const details = ['文字模型服务因长度限制停止了本次输出。']
      if (resolved.maxOutputTokens) details.push(`本次请求的输出上限为 ${resolved.maxOutputTokens} 个 token。`)
      if (outputTokens !== undefined) details.push(`供应商报告已使用 ${outputTokens} 个输出 token。`)
      if (reasoningTokens !== undefined) details.push(`其中推理使用了 ${reasoningTokens} 个 token。`)
      throw new ScriptVideoAIError('OUTPUT_TRUNCATED', details.join(''))
    }
    if (finish === 'content-filter')
      throw new ScriptVideoAIError('MODEL_CONTENT_FILTER', '文字模型服务中断了本次输出，请检查剧本或模型设置。')
    if (finish !== 'stop' && finish !== 'tool-calls')
      throw new ScriptVideoAIError('MODEL_STREAM_INTERRUPTED', '文字模型连接在交付完成前中断。', [], 502)
    if (question)
      throw new ScriptVideoAIError('USER_INPUT_REQUIRED', question, [{ code: 'USER_INPUT_REQUIRED', message: question }])
    const parsed = parseJson(answer)
    // Some compatible endpoints ignore tools and answer the timing question as prose.
    if (parsed === undefined && request.onTimingPlan && isScriptVideoTimingQuestion(answer))
      throw new ScriptVideoAIError('USER_INPUT_REQUIRED', answer.slice(0, 1200))
    if (isObject(parsed)) {
      if (isObject(parsed.timingPlan)) await request.onTimingPlan?.(parsed.timingPlan)
      signal.throwIfAborted()
      if (isObject(parsed.production)) await request.onProduction?.(parsed.production)
      if (request.onCard && Array.isArray(parsed.cards)) {
        for (const [index, card] of parsed.cards.entries()) {
          signal.throwIfAborted()
          if (isObject(card)) await request.onCard(card, index)
        }
      }
    } else if (parsed === undefined) {
      await new DraftCheckpoints(request).write(answer)
    }
    signal.throwIfAborted()
    return parsed ?? null
  } catch (error) {
    controller.abort()
    request.signal?.throwIfAborted()
    throw deadline.aborted ? deadline.reason : error
  }
}
