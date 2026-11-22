type Provider = 'jimeng' | 'libtv'

/** 只提取平台诊断字段，不回传进程参数、凭据或原始命令输出。 */
export function videoCliFailure(provider: Provider, info: unknown, fallback: string): string {
  const messages: string[] = []
  const identifiers: string[] = []
  const visited = new Set<object>()
  function clean(value: string): string {
    if (/Command failed:|(?:^|\n)\s*(?:at |Traceback)|--(?:prompt|device-code|token|api-key|phone|code)[=\s]/iu.test(value)) return ''
    return value
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
      .replace(/https?:\/\/[^\s"'<>]+/giu, '[链接已隐藏]')
      .replace(/\bBearer\s+\S+/giu, 'Bearer [已隐藏]')
      .replace(/((?:authorization|cookie|set-cookie)\s*["']?\s*[:=]\s*)[^\r\n]+/giu, '$1[已隐藏]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|signature|secret|password|device[_-]?code|user[_-]?code|phone|mobile|验证码)\s*["']?\s*[:=：]\s*["']?)[^\s,"'};&]+/giu, '$1[已隐藏]')
      .replace(/\bsk-[\w-]+/gu, '[已隐藏]')
      .replace(/\b1[3-9]\d{9}\b/gu, '[手机号已隐藏]')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ').trim()
  }
  function add(list: string[], value: unknown) {
    if (typeof value !== 'string') return
    const text = clean(value)
    if (text && !list.includes(text)) list.push(text)
  }
  function inspect(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || depth > 5 || visited.has(value)) return
    visited.add(value)
    const fields = value as Record<string, unknown>
    for (const key of ['failedReason', 'failed_reason', 'failureReason', 'errorMessage', 'error_message', 'message', 'msg', 'description', 'detail']) add(messages, fields[key])
    if (typeof fields.reason === 'string' && /^[a-z][a-z\d_]{0,79}$/iu.test(fields.reason)) add(identifiers, fields.reason)
    else add(messages, fields.reason)
    for (const key of ['code', 'errorCode', 'error_code']) {
      const code = fields[key]
      if (typeof code === 'number' && Number.isFinite(code) || typeof code === 'string' && /^[\w.-]{1,64}$/u.test(code)) {
        if (String(code) !== '0') add(identifiers, String(code))
      }
    }
    for (const key of ['requestId', 'request_id', 'traceId', 'trace_id']) {
      const id = fields[key]
      if (typeof id === 'string' && /^[\w.-]{1,120}$/u.test(id)) add(identifiers, `${key}=${id}`)
    }
    for (const key of ['error', 'details', 'cause', 'submissionError', 'failure', 'data', 'node', 'focus', 'result']) {
      if (typeof fields[key] === 'string') add(messages, fields[key])
      else inspect(fields[key], depth + 1)
    }
    if (Array.isArray(fields.errors)) for (const error of fields.errors.slice(0, 5)) inspect(error, depth + 1)
    if (Array.isArray(fields.diagnostics)) for (const diagnostic of fields.diagnostics.slice(0, 5)) inspect(diagnostic, depth + 1)
  }
  if (typeof info === 'string') {
    // 官方 CLI 的错误包有时输出在 stderr，只读取包内诊断字段。
    try { inspect(JSON.parse(info), 0) } catch {
      for (const line of info.trim().split(/\r?\n/u).slice(-6)) {
        try { inspect(JSON.parse(line), 0) } catch {
          if (/^(?:\[[^\]\r\n]{1,30}\]\s*)?(?:接口错误|请求失败|生成失败|错误|失败|Error\b|LibTV[^\r\n]*(?:错误|失败)|即梦[^\r\n]*(?:错误|失败))/iu.test(line.trim())) add(messages, line.trim())
        }
      }
    }
  } else inspect(info, 0)
  if (!messages.length && !identifiers.length) return clean(fallback).slice(0, 600)
  const name = provider === 'jimeng' ? '即梦' : 'LibTV'
  const detail = messages.join('；') || clean(fallback)
  const suffix = identifiers.length ? `（${identifiers.join('，')}）` : ''
  return `${name}：${detail.slice(0, Math.max(0, 600 - name.length - 1 - suffix.length))}${suffix}`.slice(0, 600)
}
