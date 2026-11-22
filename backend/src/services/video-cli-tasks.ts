import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'

type VideoCliProvider = 'jimeng' | 'libtv'
const disconnecting = new Set<string>()
const removing = new Set<string>()
const preparingSubmissions = new Map<string, number>()
function accountKey(provider: string, accountId = 'default') { return `${provider}:${accountId}` }
function taskAccount(params: string | null, provider: VideoCliProvider): string {
  try {
    const input = JSON.parse(params || '{}')
    return input.videoCliAccountId ?? input[provider]?.profileId ?? 'default'
  } catch { return 'default' }
}

/** Removing a saved login must not strand an original, potentially billable task. */
export async function assertVideoCliAccountRemovable(provider: VideoCliProvider, accountId: string) {
  const { VideoCliAccountError } = await import('./video-cli-accounts.js')
  const name = provider === 'jimeng' ? '即梦' : 'LibTV'
  const key = accountKey(provider, accountId)
  if (preparingSubmissions.has(key) || disconnecting.has(key)) {
    throw new VideoCliAccountError(`${name} 此账号正在提交任务或断开连接，请稍后再移除`, 409)
  }
  const { db, schema: { sysTask } } = await import('../db/index.js')
  const tasks = db.select({ params: sysTask.params, status: sysTask.status }).from(sysTask).where(and(
    eq(sysTask.type, 'video'), eq(sysTask.provider, provider), or(
      inArray(sysTask.status, ['queued', 'pending', 'processing', 'running']),
      and(eq(sysTask.status, 'failed'),
        inArray(sysTask.errorCode, ['submission_unknown', 'poll_timeout', 'delivery_failed', 'recovery_failed']),
        isNotNull(sysTask.taskId), ne(sysTask.taskId, ''), or(isNull(sysTask.localPath), eq(sysTask.localPath, ''))),
    ),
  )).all().filter(task => taskAccount(task.params, provider) === accountId)
  if (!tasks.length) return
  if (tasks.some(task => task.status !== 'failed')) {
    throw new VideoCliAccountError(`${name} 此账号还有任务正在提交或运行，请等任务结束后再移除`, 409)
  }
  throw new VideoCliAccountError(`${name} 此账号还有待恢复的原视频任务，请先恢复并保存成片后再移除账号`, 409)
}

/** Hold the account lock through logout and registry removal, without a submit/recovery gap. */
export async function whileVideoCliAccountRemoving<T>(provider: VideoCliProvider, accountId: string, action: () => Promise<T>): Promise<T> {
  const key = accountKey(provider, accountId)
  if (removing.has(key)) {
    const { VideoCliAccountError } = await import('./video-cli-accounts.js')
    throw new VideoCliAccountError('此账号正在移除，请稍后刷新账号列表', 409)
  }
  removing.add(key)
  try {
    await assertVideoCliAccountRemovable(provider, accountId)
    const { db, schema: { aiServiceConfigs } } = await import('../db/index.js')
    if (db.select({ id: aiServiceConfigs.id }).from(aiServiceConfigs).where(and(
      eq(aiServiceConfigs.provider, provider), eq(aiServiceConfigs.videoCliAccountId, accountId),
    )).get()) {
      const { VideoCliAccountError } = await import('./video-cli-accounts.js')
      throw new VideoCliAccountError('此账号仍关联视频服务配置，请先删除对应配置', 409)
    }
    return await action()
  } finally { removing.delete(key) }
}

export async function whileVideoCliDisconnecting(provider: VideoCliProvider, busy: Error, action: () => Promise<void>, accountId = 'default') {
  const key = accountKey(provider, accountId)
  if (disconnecting.has(key)) throw busy
  disconnecting.add(key)
  try {
    const { db, schema: { sysTask } } = await import('../db/index.js')
    if (preparingSubmissions.has(key) || db.select({ params: sysTask.params }).from(sysTask).where(and(
      eq(sysTask.type, 'video'), eq(sysTask.provider, provider),
      inArray(sysTask.status, ['queued', 'pending', 'processing', 'running']),
    )).all().some(task => taskAccount(task.params, provider) === accountId)) throw busy
    return await action()
  } finally {
    disconnecting.delete(key)
  }
}

export function assertVideoCliNotDisconnecting(provider: string | null | undefined, accountId = 'default') {
  if (provider && (disconnecting.has(accountKey(provider, accountId)) || removing.has(accountKey(provider, accountId)))) throw new Error('视频服务正在断开或移除所选账号，请刷新账号状态后重试')
}

export function holdVideoCliSubmission(provider: string | null | undefined, accountId = 'default') {
  if (provider !== 'jimeng' && provider !== 'libtv') return
  assertVideoCliNotDisconnecting(provider, accountId)
  const key = accountKey(provider, accountId)
  preparingSubmissions.set(key, (preparingSubmissions.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (preparingSubmissions.get(key) ?? 1) - 1
    if (remaining) preparingSubmissions.set(key, remaining)
    else preparingSubmissions.delete(key)
  }
}
