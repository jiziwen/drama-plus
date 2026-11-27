import { canRecoverOriginalVideoTask, resumeRecoverableVideoTask } from '../services/generation.js'

type TaskRecord = Parameters<typeof resumeRecoverableVideoTask>[0]

export async function resumeLatestStoryboardVideoTasks(tasks: TaskRecord[]) {
  const latestByStoryboard = new Map<number, TaskRecord>()
  for (const task of tasks) {
    if (task.type !== 'video' || !task.storyboardId) continue
    const latest = latestByStoryboard.get(task.storyboardId)
    if (!latest || task.id > latest.id) latestByStoryboard.set(task.storyboardId, task)
  }
  const recoverable = [...latestByStoryboard.values()].filter(canRecoverOriginalVideoTask)
  if (!recoverable.length) return tasks
  const refreshed = await Promise.all(recoverable.map(task => resumeRecoverableVideoTask(task)))
  const refreshedById = new Map(refreshed.map(task => [task.id, task]))
  return tasks.map(task => refreshedById.get(task.id) ?? task)
}
