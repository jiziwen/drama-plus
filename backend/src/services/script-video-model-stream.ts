import { ScriptVideoAIError } from './script-video-types.js'

type Model = Awaited<ReturnType<typeof import('../agents/index.js').resolveScriptVideoTextModel>>['model']
type CallOptions = Parameters<Model['doStream']>[0]
type ModelReply = Pick<Awaited<ReturnType<Model['doGenerate']>>, 'finishReason' | 'usage' | 'content'>
type ToolCall = Extract<ModelReply['content'][number], { type: 'tool-call' }>

export function interruptedScriptVideoModelStream(cause?: unknown) {
  const error = new ScriptVideoAIError('MODEL_STREAM_INTERRUPTED', '文字模型连接在交付完成前中断。', [], 502)
  if (cause !== undefined) error.cause = cause
  return error
}

export async function receiveScriptVideoModelStream(model: Pick<Model, 'doStream'>, options: CallOptions): Promise<ModelReply> {
  const { stream } = await model.doStream(options)
  const reader = stream.getReader()
  const text: string[] = []
  const tools = new Map<string, ToolCall>()
  let receivedReasoning = false
  let finish: Pick<ModelReply, 'finishReason' | 'usage'> | undefined
  try {
    for (;;) {
      const { done, value: part } = await reader.read()
      if (done) break
      switch (part.type) {
        case 'reasoning-delta':
          receivedReasoning ||= Boolean(part.delta)
          break
        case 'text-delta':
          if (part.delta) text.push(part.delta)
          break
        case 'tool-input-start':
          tools.set(part.id, { type: 'tool-call', toolCallId: part.id, toolName: part.toolName, input: '' })
          break
        case 'tool-input-delta': {
          // A length-limited stream may never emit the assembled tool-call.
          const tool = tools.get(part.id)
          if (tool) tool.input += part.delta
          break
        }
        case 'tool-call':
          tools.set(part.toolCallId, part)
          break
        case 'error': {
          const error = part.error
          if (error instanceof Error) throw error
          const message = error && typeof error === 'object' && 'message' in error ? error.message : error
          throw new Error(typeof message === 'string' && message.trim() ? message : '文字模型服务返回了流式错误。', { cause: error })
        }
        case 'finish':
          finish = { finishReason: part.finishReason, usage: part.usage }
          break
      }
    }
  } catch (error) {
    options.abortSignal?.throwIfAborted()
    // Once the provider starts generating, even an in-stream 429 is not a pre-send rejection.
    if (receivedReasoning || text.length || tools.size) throw interruptedScriptVideoModelStream(error)
    throw error
  } finally {
    reader.releaseLock()
  }
  // Some SDKs emit a synthetic 'other' finish on clean EOF without a vendor finish reason.
  if (!finish || finish.finishReason.unified === 'other' || finish.finishReason.unified === 'error') {
    throw interruptedScriptVideoModelStream()
  }
  return { ...finish, content: [{ type: 'text', text: text.join('') }, ...tools.values()] }
}
