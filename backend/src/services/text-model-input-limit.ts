export function isTextModelInputLimit(error: unknown) {
  const pending = [error]
  const seen = new Set<unknown>()
  const codePattern = /^(?:context_length_exceeded|context_window_exceeded|input_token_limit_exceeded|input_too_long|prompt_too_long|request_too_large|request_entity_too_large|payload_too_large)$/iu
  const messagePattern = /maximum (?:model )?context length|context (?:length|window|limit)[^\n]{0,90}(?:exceed|too (?:large|long)|is \d)|(?:exceed|exceeds|exceeded)[^\n]{0,70}(?:context length|context window|input token limit)|(?:input|prompt)(?: text| length| tokens?| token count)? (?:is )?too (?:large|long)|(?:input|prompt)[^\n]{0,55}(?:exceeds?|more than)[^\n]{0,75}(?:token|context)|(?:payload|request entity|request body) too large|上下文[^\n]{0,20}(?:超[过出]|限制|过长)|(?:输入|请求体|提示词)[^\n]{0,12}(?:超过.{0,12}(?:限制|上限)|过长|过大)/iu
  while (pending.length && seen.size < 18) {
    const value = pending.shift()
    if (!value || seen.has(value)) continue
    seen.add(value)
    if (typeof value === 'string') {
      if (messagePattern.test(value.slice(0, 3200))) return true
      if (value.length <= 16_000) {
        try { pending.push(JSON.parse(value)) } catch { /* Plain gateway message. */ }
      }
      continue
    }
    if (typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (Number(entry.statusCode ?? entry.status) === 413 || /^413(?:\D|$)/u.test(String(entry.message ?? '')) ||
        (typeof entry.code === 'string' && codePattern.test(entry.code))) return true
    pending.push(entry.message, entry.cause, entry.lastError, entry.error, entry.data, entry.responseBody)
  }
  return false
}
