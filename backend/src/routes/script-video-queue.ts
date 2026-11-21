import type { Hono } from 'hono'
import { scriptVideoSession, ScriptVideoStore, ScriptVideoStoreError } from '../services/script-video-store.js'
import { ScriptVideoQueue } from '../services/script-video-queue.js'

export function registerScriptVideoQueueRoutes(app: Hono, store: ScriptVideoStore, queue: ScriptVideoQueue) {
  function failure(c: any, error: unknown) {
    const e = error instanceof ScriptVideoStoreError ? error : new ScriptVideoStoreError('生成队列暂时无法更新', 500, 'QUEUE_FAILED')
    return c.json({ code: e.status, message: e.message, errorCode: e.code }, e.status)
  }
  app.post('/projects/:id/episodes/:episodeId/video-queue', async c => {
    try {
      const projectId = c.req.param('id'), episodeId = c.req.param('episodeId')
      const session = scriptVideoSession(c.req.header('X-Script-Video-Session'))
      const { requestId, cardIds } = await c.req.json()
      const data = await store.mutateEpisode(projectId, episodeId, record => {
        const episode = record.project.episodes.find(item => item.id === episodeId)
        if (!episode) throw new ScriptVideoStoreError('分集不存在', 404, 'NOT_FOUND')
        if (!Array.isArray(cardIds) || cardIds.some(id => !episode.cards.some((card: any) => card.id === id)))
          throw new ScriptVideoStoreError('排队的分镜不存在', 404, 'NOT_FOUND')
        for (const cardId of cardIds) {
          if (record.jobs.some(job => job.episodeId === episodeId && job.cardId === cardId && job.action === 'video' &&
              (job.status === 'queued' || job.status === 'running')))
            throw new ScriptVideoStoreError('此分镜已有视频任务正在提交或处理中', 409, 'VIDEO_ACTIVE')
        }
        return { result: queue.reserve(projectId, episodeId, session, requestId, cardIds), recordChanged: false }
      })
      return c.json({ code: 200, data })
    } catch (error) { return failure(c, error) }
  })
  app.delete('/projects/:id/episodes/:episodeId/video-queue', async c => {
    try {
      const { requestId } = await c.req.json()
      queue.release(c.req.param('id'), c.req.param('episodeId'), scriptVideoSession(c.req.header('X-Script-Video-Session')), requestId)
      return c.json({ code: 200, data: { requestId } })
    } catch (error) { return failure(c, error) }
  })
}
