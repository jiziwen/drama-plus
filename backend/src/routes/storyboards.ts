import { Hono } from 'hono'
import { and, asc, desc, eq, isNull, isNotNull } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, created, now, badRequest } from '../utils/response.js'
import { toSnakeCase } from '../utils/transform.js'
import { mediaSelectionPatch } from '../services/media-selection.js'
import { videoPosterResponse } from '../services/video-poster-response.js'
import { logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'
import { isGenerationTaskActive } from '../services/generation.js'

const app = new Hono()

app.get('/:id/poster', async c => {
  const id = Number(c.req.param('id'))
  const [shot] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!shot || shot.deletedAt) return videoPosterResponse(c, [])
  const history = await db.select().from(schema.sysTask).where(and(eq(schema.sysTask.storyboardId, id), eq(schema.sysTask.type, 'video'))).orderBy(desc(schema.sysTask.id))
  const canonical = (s?: string | null) => s?.replace(/^\/(static\/)/, '$1')
  const current = shot.videoUrl ? history.find(task => [task.localPath, task.resultUrl].some(url => canonical(url) === canonical(shot.videoUrl))) : history.find(task => task.status === 'completed')
  return videoPosterResponse(c, [shot.videoUrl, current?.localPath, current?.resultUrl])
})

async function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  await db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))


  const uniqueIds = [...new Set((characterIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    await db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    })
  }
}

async function getStoryboardCharacterIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
  return links.map(link => link.characterId)
}

async function syncStoryboardProps(storyboardId: number, propIds: number[]) {
  await db.delete(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))

  const uniqueIds = [...new Set((propIds || []).filter(Boolean))]
  if (!uniqueIds.length) return

  for (const propId of uniqueIds) {
    await db.insert(schema.storyboardProps).values({
      storyboardId,
      propId,
    })
  }
}

async function getStoryboardPropIds(storyboardId: number) {
  const links = await db.select().from(schema.storyboardProps)
    .where(eq(schema.storyboardProps.storyboardId, storyboardId))
  return links.map(link => link.propId)
}

async function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[] | undefined) {
  const sceneLinks = await db.select().from(schema.episodeScenes)
    .where(eq(schema.episodeScenes.episodeId, episodeId))
  const episodeSceneIds = new Set(sceneLinks.map(link => link.sceneId))
  const characterLinks = await db.select().from(schema.episodeCharacters)
    .where(eq(schema.episodeCharacters.episodeId, episodeId))
  const episodeCharacterIds = new Set(characterLinks.map(link => link.characterId))
  const propLinks = await db.select().from(schema.episodeProps)
    .where(eq(schema.episodeProps.episodeId, episodeId))
  const episodePropIds = new Set(propLinks.map(link => link.propId))

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error('scene_id 必须来自当前集已关联场景')
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error('character_ids 必须来自当前集已关联角色')
  }

  const invalidPropIds = (propIds || []).filter(id => !episodePropIds.has(id))
  if (invalidPropIds.length) {
    throw new Error('prop_ids 必须来自当前集已关联道具')
  }
}

// POST /storyboards
app.post('/', async (c) => {
  const body = await c.req.json()
  const episodeId = Number(body.episode_id)
  if (!Number.isSafeInteger(episodeId) || episodeId < 1) return badRequest(c, 'episode_id 必须是有效的集 ID')
  if ('duration' in body && !Number.isSafeInteger(body.duration)) return badRequest(c, '分镜时长必须是整数')
  const position = body.insert_position
  if (position != null && (!Number.isSafeInteger(position) || position < 1)) {
    return badRequest(c, '插入位置必须是正整数')
  }
  const episode = db.select({ id: schema.episodes.id }).from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
  if (!episode) return badRequest(c, '集不存在')
  const ts = now()
  logTaskStart('StoryboardAPI', 'create', {
    episodeId,
    insertPosition: position,
    sceneId: body.scene_id,
    characterIds: body.character_ids,
  })
  logTaskPayload('StoryboardAPI', 'create body', body)
  await validateStoryboardBindings(episodeId, body.scene_id, body.character_ids, body.prop_ids)
  let result: typeof schema.storyboards.$inferSelect
  try {
    result = db.transaction(tx => {
      const existing = tx.select({ id: schema.storyboards.id }).from(schema.storyboards)
        .where(and(eq(schema.storyboards.episodeId, episodeId), isNull(schema.storyboards.deletedAt)))
        .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id)).all()
      const insertPosition = position ?? existing.length + 1
      if (insertPosition > existing.length + 1) throw new RangeError(`插入位置不能超过 ${existing.length + 1}`)

      // 按现有列表顺序重新编号，兼容删除后空号和旧数据中的重复编号；不改变分镜 ID。
      existing.forEach((shot, index) => {
        const number = index + 1 + (index >= insertPosition - 1 ? 1 : 0)
        tx.update(schema.storyboards).set({ storyboardNumber: number }).where(eq(schema.storyboards.id, shot.id)).run()
      })
      const inserted = tx.insert(schema.storyboards).values({
        episodeId, storyboardNumber: insertPosition,
        title: body.title, description: body.description, sceneId: body.scene_id,
        duration: body.duration ?? 10, createdAt: ts, updatedAt: ts,
      }).returning().get()
      for (const characterId of new Set<number>((body.character_ids || []).filter(Boolean))) {
        tx.insert(schema.storyboardCharacters).values({ storyboardId: inserted.id, characterId }).run()
      }
      for (const propId of new Set<number>((body.prop_ids || []).filter(Boolean))) {
        tx.insert(schema.storyboardProps).values({ storyboardId: inserted.id, propId }).run()
      }
      return inserted
    })
  } catch (e) {
    if (e instanceof RangeError) return badRequest(c, e.message)
    throw e
  }
  logTaskSuccess('StoryboardAPI', 'create', {
    storyboardId: result.id,
    episodeId: result.episodeId,
    shotNumber: result.storyboardNumber,
  })
  return created(c, {
    ...toSnakeCase(result),
    character_ids: await getStoryboardCharacterIds(result.id),
    prop_ids: await getStoryboardPropIds(result.id),
  })
})

// PUT /storyboards/:id
app.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id))
  if (!storyboard || storyboard.deletedAt) return badRequest(c, '镜头不存在')
  if ('duration' in body && !Number.isSafeInteger(body.duration)) return badRequest(c, '分镜时长必须是整数')
  logTaskStart('StoryboardAPI', 'update', {
    storyboardId: id,
    episodeId: storyboard.episodeId,
    fields: Object.keys(body),
  })
  logTaskPayload('StoryboardAPI', 'update body', body)

  const fieldMap: Record<string, string> = {
    title: 'title', description: 'description', shot_type: 'shotType',
    angle: 'angle', movement: 'movement', duration: 'duration',
    video_prompt: 'videoPrompt',
    image_prompt: 'imagePrompt', scene_id: 'sceneId', location: 'location',
    time: 'time', atmosphere: 'atmosphere', result: 'result',
    bgm_prompt: 'bgmPrompt', sound_effect: 'soundEffect',
    video_url: 'videoUrl',
  }

  const updates: Record<string, any> = { updatedAt: now() }
  try { Object.assign(updates, await mediaSelectionPatch(body, storyboard, 'video')) } catch (e: any) { return badRequest(c, e.message) }
  for (const [snakeKey, camelKey] of Object.entries(fieldMap)) {
    if (snakeKey in body) updates[camelKey] = body[snakeKey]
  }

  await validateStoryboardBindings(
    storyboard.episodeId,
    'scene_id' in body ? body.scene_id : storyboard.sceneId,
    'character_ids' in body ? body.character_ids : await getStoryboardCharacterIds(id),
    'prop_ids' in body ? body.prop_ids : await getStoryboardPropIds(id),
  )

  await db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, id))
  if ('character_ids' in body) await syncStoryboardCharacters(id, body.character_ids || [])
  if ('prop_ids' in body) await syncStoryboardProps(id, body.prop_ids || [])
  logTaskSuccess('StoryboardAPI', 'update', {
    storyboardId: id,
    updatedFields: Object.keys(updates),
    characterIds: body.character_ids,
    propIds: body.prop_ids,
  })
  return success(c)
})

// 查看指定集回收站中的分镜。
app.get('/trash', c => {
  const episodeId = Number(c.req.query('episode_id'))
  if (!Number.isSafeInteger(episodeId) || episodeId < 1) return badRequest(c, 'episode_id 必须是有效的集 ID')
  const rows = db.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, episodeId), isNotNull(schema.storyboards.deletedAt)))
    .orderBy(desc(schema.storyboards.deletedAt), desc(schema.storyboards.id)).all()
  return success(c, rows.map(toSnakeCase))
})

// 恢复到删除时的位置，位置超过现有列表长度时追加。
app.post('/:id/restore', c => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id < 1) return badRequest(c, '回收站中不存在此分镜')
  const result = db.transaction(tx => {
    const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
    if (!shot || !shot.deletedAt) return null
    const rows = tx.select().from(schema.storyboards).where(and(eq(schema.storyboards.episodeId, shot.episodeId), isNull(schema.storyboards.deletedAt)))
      .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id)).all()
    const position = Math.min(Math.max(1, shot.storyboardNumber), rows.length + 1)
    rows.forEach((row, index) => tx.update(schema.storyboards).set({ storyboardNumber: index + 1 + (index >= position - 1 ? 1 : 0) }).where(eq(schema.storyboards.id, row.id)).run())
    return tx.update(schema.storyboards).set({ storyboardNumber: position, deletedAt: null, updatedAt: now() }).where(eq(schema.storyboards.id, id)).returning().get()
  })
  return result ? success(c, toSnakeCase(result)) : badRequest(c, '回收站中不存在此分镜')
})

// 删除时保留所有记录和文件，供回收站恢复。
app.delete('/:id', c => {
  const id = Number(c.req.param('id'))
  if (!Number.isSafeInteger(id) || id < 1) return badRequest(c, '镜头不存在')
  const outcome = db.transaction(tx => {
    const shot = tx.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).get()
    if (!shot || shot.deletedAt) return 'missing'
    const tasks = tx.select().from(schema.sysTask).where(eq(schema.sysTask.storyboardId, id)).all()
    if (tasks.some(task => task.status === 'processing' || isGenerationTaskActive(task.id))) return 'active'
    tx.update(schema.storyboards).set({ deletedAt: now(), updatedAt: now() }).where(eq(schema.storyboards.id, id)).run()
    const remaining = tx.select({ id: schema.storyboards.id }).from(schema.storyboards)
      .where(and(eq(schema.storyboards.episodeId, shot.episodeId), isNull(schema.storyboards.deletedAt)))
      .orderBy(asc(schema.storyboards.storyboardNumber), asc(schema.storyboards.id)).all()
    remaining.forEach((row, index) => tx.update(schema.storyboards).set({ storyboardNumber: index + 1 }).where(eq(schema.storyboards.id, row.id)).run())
    return 'deleted'
  })
  if (outcome === 'missing') return badRequest(c, '镜头不存在')
  if (outcome === 'active') return badRequest(c, '该分镜有运行中的任务，请等待完成后再删除')
  return success(c)
})

export default app
