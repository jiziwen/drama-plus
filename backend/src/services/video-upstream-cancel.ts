import type { AIConfig } from './ai.js'
import { getVideoAdapter } from './adapters/registry.js'

/** DashScope's cancel endpoint changes only an upstream PENDING task.
 * Ark's combined DELETE can erase a task that finishes between lookup and deletion.
 */
export async function cancelUpstreamVideo(config: AIConfig, taskId: string): Promise<boolean> {
  if (config.provider.toLowerCase() !== 'aliyun' || !/^[\w-]{1,160}$/u.test(taskId)) return false

  try {
    const { url, headers } = getVideoAdapter('aliyun').buildPollRequest(config, taskId)
    const endpoint = new URL(url)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return false
    const options = { headers, redirect: 'error' as const, signal: AbortSignal.timeout(8_000) }
    const lookup = await fetch(endpoint, { ...options, cache: 'no-store' })
    if (!lookup.ok) return false
    const current = await lookup.json()
    if (current?.code || current?.output?.code || current?.output?.task_id !== taskId) return false
    if (current.output.task_status === 'CANCELED') return true
    if (current.output.task_status !== 'PENDING') return false

    endpoint.pathname += '/cancel'
    const cancel = await fetch(endpoint, { ...options, method: 'POST' })
    if (!cancel.ok) return false
    // The successful API response contains a request ID without an error code.
    const result = await cancel.json()
    return typeof result?.request_id === 'string' && !!result.request_id && !result.code && !result.output?.code
  } catch {
    return false
  }
}
