import { and, eq, inArray } from 'drizzle-orm'

type VideoCliProvider = 'jimeng' | 'libtv'
const disconnecting = new Set<string>()
const preparingSubmissions = new Map<VideoCliProvider, number>()

export async function whileVideoCliDisconnecting(provider: VideoCliProvider, busy: Error, action: () => Promise<void>) {
  const { db, schema: { sysTask } } = await import('../db/index.js')
  if (preparingSubmissions.has(provider) || db.select({ id: sysTask.id }).from(sysTask).where(and(
    eq(sysTask.type, 'video'), eq(sysTask.provider, provider),
    inArray(sysTask.status, ['queued', 'pending', 'processing', 'running']),
  )).get()) throw busy
  disconnecting.add(provider)
  try {
    return await action()
  } finally {
    disconnecting.delete(provider)
  }
}

export function assertVideoCliNotDisconnecting(provider: string | null | undefined) {
  if (provider && disconnecting.has(provider)) throw new Error('视频服务正在断开账号，请刷新账号状态后重试')
}

export function holdVideoCliSubmission(provider: string | null | undefined) {
  if (provider !== 'jimeng' && provider !== 'libtv') return
  assertVideoCliNotDisconnecting(provider)
  preparingSubmissions.set(provider, (preparingSubmissions.get(provider) ?? 0) + 1)
  return () => {
    const remaining = (preparingSubmissions.get(provider) ?? 1) - 1
    if (remaining) preparingSubmissions.set(provider, remaining)
    else preparingSubmissions.delete(provider)
  }
}
