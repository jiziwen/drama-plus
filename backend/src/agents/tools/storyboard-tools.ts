/**
 * 分镜拆解 Agent 工具
 * 模块级单例 — episodeId + dramaId 通过 RequestContext 按请求注入
 */
import { createTool } from '@mastra/core/tools'
import type { ToolExecutionContext } from '@mastra/core/tools'
import { z } from 'zod'
import { db, getInsertId, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import { getDramaId, getEpisodeId } from '../context.js'
import { assertChinesePrompt } from '../../services/prompt-language.js'

type DbWriter = Pick<typeof db, 'select' | 'insert' | 'delete' | 'update'>

function syncStoryboardCharacters(storyboardId: number, characterIds: number[], connection: DbWriter = db) {
  connection.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).run()
  for (const characterId of new Set(characterIds.filter(Boolean))) {
    connection.insert(schema.storyboardCharacters).values({ storyboardId, characterId }).run()
  }
}

function syncStoryboardProps(storyboardId: number, propIds: number[], connection: DbWriter = db) {
  connection.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, storyboardId)).run()
  for (const propId of new Set(propIds.filter(Boolean))) {
    connection.insert(schema.storyboardProps).values({ storyboardId, propId }).run()
  }
}

// Validation is read-only. Auto-linking happens only inside the successful save transaction.
function validateStoryboardBindings(dramaId: number, sceneId: number | null | undefined, characterIds: number[] | undefined, propIds?: number[]) {
  if (sceneId != null) {
    const row = db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).get()
    if (!row || row.dramaId !== dramaId || row.deletedAt) throw new Error(`scene_id ${sceneId} 不属于当前项目`)
  }
  for (const characterId of new Set(characterIds || [])) {
    const row = db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    if (!row || row.dramaId !== dramaId || row.deletedAt) throw new Error(`character_id ${characterId} 不属于当前项目`)
  }
  for (const propId of new Set(propIds || [])) {
    const row = db.select().from(schema.props).where(eq(schema.props.id, propId)).get()
    if (!row || row.dramaId !== dramaId || row.deletedAt) throw new Error(`prop_id ${propId} 不属于当前项目`)
  }
}

function linkEpisodeAssets(connection: DbWriter, episodeId: number, sceneId: number | null | undefined, characterIds: number[] = [], propIds: number[] = []) {
  const sceneIds = new Set(connection.select().from(schema.episodeScenes).where(eq(schema.episodeScenes.episodeId, episodeId)).all().map(row => row.sceneId))
  if (sceneId != null && !sceneIds.has(sceneId)) connection.insert(schema.episodeScenes).values({ episodeId, sceneId, createdAt: now() }).run()
  const characterSet = new Set(connection.select().from(schema.episodeCharacters).where(eq(schema.episodeCharacters.episodeId, episodeId)).all().map(row => row.characterId))
  for (const characterId of new Set(characterIds)) {
    if (!characterSet.has(characterId)) connection.insert(schema.episodeCharacters).values({ episodeId, characterId, createdAt: now() }).run()
  }
  const propSet = new Set(connection.select().from(schema.episodeProps).where(eq(schema.episodeProps.episodeId, episodeId)).all().map(row => row.propId))
  for (const propId of new Set(propIds)) {
    if (!propSet.has(propId)) connection.insert(schema.episodeProps).values({ episodeId, propId, createdAt: now() }).run()
  }
}

type ToolContext = ToolExecutionContext | undefined

function requireIds(context: ToolContext): { episodeId: number; dramaId: number } | { error: string } {
  const episodeId = getEpisodeId(context?.requestContext)
  const dramaId = getDramaId(context?.requestContext)
  if (!episodeId || !dramaId) return { error: 'Missing episodeId/dramaId in request context' }
  return { episodeId, dramaId }
}

const readStoryboardContext = createTool({
  id: 'read_storyboard_context',
  description: 'Read the screenplay, characters, scenes, and props for storyboard breakdown.',
  inputSchema: z.object({}),
  execute: async (_input, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const [ep] = await db.select().from(schema.episodes)
      .where(eq(schema.episodes.id, episodeId))
    if (!ep || ep.dramaId !== dramaId || ep.deletedAt) return { error: 'Episode not found' }
    const script = ep.scriptContent || ep.content
    if (!script) return { error: 'Episode has no script' }

    const charLinks = await db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId))
    const sceneLinks = await db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId))
    const propLinks = await db.select().from(schema.episodeProps)
      .where(eq(schema.episodeProps.episodeId, episodeId))

    const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
    const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))
    const linkedPropIds = new Set(propLinks.map(link => link.propId))

    const chars = await db.select().from(schema.characters)
      .where(eq(schema.characters.dramaId, dramaId))
    const scns = await db.select().from(schema.scenes)
      .where(eq(schema.scenes.dramaId, dramaId))
    const prps = await db.select().from(schema.props)
      .where(eq(schema.props.dramaId, dramaId))
    const existingStoryboards = await db.select().from(schema.storyboards)
      .where(eq(schema.storyboards.episodeId, episodeId))

    const characters = chars
      .filter(c => !c.deletedAt)
      .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
      .map(c => ({
        id: c.id,
        name: c.name,
        role: c.role || '',
        description: c.description || '',
        appearance: c.appearance || '',
        styling: c.styling || '',
        image_url: c.imageUrl || '',
        reference_images: c.referenceImages || '',
      }))

    const scenes = scns
      .filter(s => !s.deletedAt)
      .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
      .map(s => ({
        id: s.id,
        location: s.location,
        time: s.time,
        prompt: s.prompt || '',
        lighting: s.lighting || '',
        image_url: s.imageUrl || '',
        storyboard_count: s.storyboardCount || 0,
      }))

    const props = prps
      .filter(p => !p.deletedAt)
      .filter(p => !linkedPropIds.size || linkedPropIds.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.name,
        type: p.type || '',
        description: p.description || '',
        image_url: p.imageUrl || '',
      }))

    const existingStoryboardPayload = await Promise.all(existingStoryboards
      .filter(sb => !sb.deletedAt)
      .map(async (sb) => {
        const links = await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, sb.id))
        const sbPropLinks = await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, sb.id))
        return {
          id: sb.id,
          shot_number: sb.storyboardNumber,
          title: sb.title || '',
          scene_id: sb.sceneId,
          character_ids: links.map(link => link.characterId),
          prop_ids: sbPropLinks.map(link => link.propId),
          shot_type: sb.shotType || '',
          duration: sb.duration || 0,
          description: sb.description || '',
          atmosphere: sb.atmosphere || '',
          video_prompt: sb.videoPrompt || '',
        }
      }))

    const payload = {
      episode: {
        id: ep.id,
        title: ep.title,
        episode_number: ep.episodeNumber,
        description: ep.description || '',
      },
      script,
      characters,
      scenes,
      props,
      existing_storyboards: existingStoryboardPayload,
    }
    logTaskSuccess('StoryboardTool', 'read-context', {
      episodeId,
      dramaId,
      characters: characters.length,
      scenes: scenes.length,
      props: props.length,
      existingStoryboards: payload.existing_storyboards.length,
      scriptLength: script.length,
    })
    return payload
  },
})

const storyboardFields = z.object({
  shot_number: z.number(),
  title: z.string().optional(),
  shot_type: z.string().optional(),
  angle: z.string().optional(),
  movement: z.string().optional(),
  location: z.string().optional(),
  time: z.string().optional(),
  description: z.string().optional(),
  result: z.string().optional(),
  atmosphere: z.string().optional(),
  image_prompt: z.string().optional(),
  video_prompt: z.string().optional(),
  bgm_prompt: z.string().optional(),
  sound_effect: z.string().optional(),
  duration: z.number().optional(),
  scene_id: z.number().nullable().optional(),
  character_ids: z.array(z.number()).optional(),
  prop_ids: z.array(z.number()).optional(),
})

const saveStoryboards = createTool({
  id: 'save_storyboards',
  description: 'Save storyboards for this episode. Call in batches of at most 8 storyboards: the first batch sets replace_existing:true, following batches append. Rows are upserted by shot_number, so overlapping batches and retries never create duplicates.',
  inputSchema: z.object({
    replace_existing: z.boolean().optional(),
    storyboards: z.array(storyboardFields),
  }),
  execute: async ({ storyboards, replace_existing }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).get()
    if (!episode || episode.dramaId !== dramaId || episode.deletedAt) return { error: '当前集不存在或不属于当前项目。' }

    // Validate all asset links before replacing any old rows. Generation timing is left to the prompt.
    try {
      for (const sb of storyboards) {
        if (sb.video_prompt?.trim()) assertChinesePrompt(sb.video_prompt)
        if (sb.image_prompt?.trim()) assertChinesePrompt(sb.image_prompt)
        validateStoryboardBindings(dramaId, sb.scene_id, sb.character_ids, sb.prop_ids)
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : '分镜字段或资产关联无效。' }
    }
    const ts = now()
    let totalDuration = 0
    try {
      db.transaction(tx => {
        const existingRows = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all()
        if (replace_existing === true) {
          for (const row of existingRows) {
            tx.delete(schema.storyboardCharacters).where(eq(schema.storyboardCharacters.storyboardId, row.id)).run()
            tx.delete(schema.storyboardProps).where(eq(schema.storyboardProps.storyboardId, row.id)).run()
          }
          tx.delete(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).run()
        }
        const shotToId = new Map((replace_existing === true ? [] : existingRows.filter(row => !row.deletedAt)).map(row => [row.storyboardNumber, row.id]))
        for (const sb of storyboards) {
          const fields = {
            title: sb.title, shotType: sb.shot_type, angle: sb.angle, movement: sb.movement,
            location: sb.location, time: sb.time, description: sb.description, result: sb.result,
            atmosphere: sb.atmosphere, imagePrompt: sb.image_prompt, videoPrompt: sb.video_prompt,
            bgmPrompt: sb.bgm_prompt, soundEffect: sb.sound_effect, sceneId: sb.scene_id,
            duration: sb.duration || 10, updatedAt: ts,
          }
          let id = shotToId.get(sb.shot_number)
          if (id !== undefined) tx.update(schema.storyboards).set(fields).where(eq(schema.storyboards.id, id)).run()
          else {
            id = getInsertId(tx.insert(schema.storyboards).values({ ...fields, episodeId, storyboardNumber: sb.shot_number, createdAt: ts }).run())
            shotToId.set(sb.shot_number, id)
          }
          linkEpisodeAssets(tx, episodeId, sb.scene_id, sb.character_ids, sb.prop_ids)
          syncStoryboardCharacters(id, sb.character_ids || [], tx)
          syncStoryboardProps(id, sb.prop_ids || [], tx)
        }
        totalDuration = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all().filter(row => !row.deletedAt).reduce((sum, row) => sum + (row.duration || 0), 0)
        tx.update(schema.episodes).set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts }).where(eq(schema.episodes.id, episodeId)).run()
      })
    } catch (error) {
      return { error: '本批保存失败，原数据已保留：' + (error instanceof Error ? error.message : '数据库写入失败') }
    }
    logTaskSuccess('StoryboardTool', 'save-complete', { episodeId, count: storyboards.length, totalDuration })
    return { message: 'Saved ' + storyboards.length + ' storyboards', count: storyboards.length, total_duration: totalDuration }
  },
})

const updateStoryboard = createTool({
  id: 'update_storyboard',
  description: 'Update a specific storyboard shot.',
  inputSchema: z.object({
    storyboard_id: z.number(),
    title: z.string().optional(),
    shot_type: z.string().optional(),
    angle: z.string().optional(),
    movement: z.string().optional(),
    location: z.string().optional(),
    time: z.string().optional(),
    result: z.string().optional(),
    atmosphere: z.string().optional(),
    image_prompt: z.string().optional(),
    video_prompt: z.string().optional(),
    bgm_prompt: z.string().optional(),
    sound_effect: z.string().optional(),
    description: z.string().optional(),
    scene_id: z.number().nullable().optional(),
    character_ids: z.array(z.number()).optional(),
    prop_ids: z.array(z.number()).optional(),
    duration: z.number().optional(),
  }),
  execute: async ({ storyboard_id, ...fields }, context) => {
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const { episodeId, dramaId } = ids
    const fail = (error: { code: string; error: string }) => error
    try {
      if (fields.video_prompt?.trim()) assertChinesePrompt(fields.video_prompt)
      if (fields.image_prompt?.trim()) assertChinesePrompt(fields.image_prompt)
    } catch (error) {
      return fail({ code: 'INVALID_STORYBOARD_PROMPT', error: error instanceof Error ? error.message : '分镜提示词无效。' })
    }
    const [storyboard] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!storyboard || storyboard.episodeId !== episodeId || storyboard.deletedAt) return fail({ code: 'STORYBOARD_NOT_FOUND', error: '分镜不属于当前集。' })

    // 过滤模型回传的垃圾值：视频提示词 Agent 常把整行字段回传，
    // 拿不准的字符串字段写成 "null"/"undefined"，直接覆盖会毁掉已有内容
    for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
      const v = fields[key]
      if (typeof v === 'string' && (v === 'null' || v === 'undefined' || v === 'NULL' || v === 'Null')) {
        delete fields[key]
      }
    }

    logTaskProgress('StoryboardTool', 'update-begin', {
      episodeId,
      storyboardId: storyboard_id,
      fields: Object.keys(fields),
    })

    const currentCharacterIds = 'character_ids' in fields
      ? fields.character_ids
      : (await db.select().from(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)))
          .map(link => link.characterId)

    const currentPropIds = 'prop_ids' in fields
      ? fields.prop_ids
      : (await db.select().from(schema.storyboardProps)
          .where(eq(schema.storyboardProps.storyboardId, storyboard_id)))
          .map(link => link.propId)

    try {
      validateStoryboardBindings(dramaId, 'scene_id' in fields ? fields.scene_id : storyboard.sceneId, currentCharacterIds, currentPropIds)
    } catch (error) {
      return fail({ code: 'INVALID_STORYBOARD', error: error instanceof Error ? error.message : '资产关联无效。' })
    }

    const updates: Record<string, any> = { updatedAt: now() }
    if ('title' in fields) updates.title = fields.title
    if ('shot_type' in fields) updates.shotType = fields.shot_type
    if ('angle' in fields) updates.angle = fields.angle
    if ('movement' in fields) updates.movement = fields.movement
    if ('location' in fields) updates.location = fields.location
    if ('time' in fields) updates.time = fields.time
    if ('result' in fields) updates.result = fields.result
    if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
    if ('image_prompt' in fields) updates.imagePrompt = fields.image_prompt
    if ('video_prompt' in fields) updates.videoPrompt = fields.video_prompt
    if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
    if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
    if ('description' in fields) updates.description = fields.description
    if ('scene_id' in fields) updates.sceneId = fields.scene_id
    if ('duration' in fields) updates.duration = fields.duration
    try {
      db.transaction(tx => {
        tx.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
        linkEpisodeAssets(tx, episodeId, 'scene_id' in fields ? fields.scene_id : storyboard.sceneId, currentCharacterIds, currentPropIds)
        if ('character_ids' in fields) syncStoryboardCharacters(storyboard_id, fields.character_ids || [], tx)
        if ('prop_ids' in fields) syncStoryboardProps(storyboard_id, fields.prop_ids || [], tx)
        if ('duration' in fields) {
          const aggregateSeconds = tx.select().from(schema.storyboards).where(eq(schema.storyboards.episodeId, episodeId)).all().filter(row => !row.deletedAt).reduce((sum, row) => sum + (row.duration || 0), 0)
          tx.update(schema.episodes).set({ duration: Math.ceil(aggregateSeconds / 60), updatedAt: now() }).where(eq(schema.episodes.id, episodeId)).run()
        }
      })
    } catch (error) {
      return fail({ code: 'SAVE_FAILED', error: `分镜更新失败，原数据已保留：${error instanceof Error ? error.message : '数据库写入失败'}` })
    }
    logTaskSuccess('StoryboardTool', 'update-complete', {
      episodeId,
      storyboardId: storyboard_id,
      updatedFields: Object.keys(updates),
      characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      propIds: 'prop_ids' in fields ? (fields.prop_ids || []).join(',') : undefined,
    })
    return { message: `Storyboard ${storyboard_id} updated` }
  },
})

export const updateVideoPrompt = createTool({
  id: 'update_storyboard',
  description: '仅保存分镜的简体中文视频提示词，不接受或修改场景、时长、描述等其他字段。',
  inputSchema: z.object({ storyboard_id: z.number(), video_prompt: z.string() }).strict(),
  execute: async ({ storyboard_id, video_prompt }, context) => {
    const fail = (error: { code: string; error: string }) => error
    try { assertChinesePrompt(video_prompt) } catch (error) {
      return fail({ code: 'INVALID_VIDEO_PROMPT', error: error instanceof Error ? error.message : '视频提示词无效。' })
    }
    const ids = requireIds(context)
    if ('error' in ids) return ids
    const [row] = await db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id))
    if (!row || row.episodeId !== ids.episodeId || row.deletedAt) return fail({ code: 'STORYBOARD_NOT_FOUND', error: '分镜不属于当前集' })
    try {
      await db.update(schema.storyboards).set({ videoPrompt: video_prompt, updatedAt: now() }).where(eq(schema.storyboards.id, storyboard_id))
    } catch {
      return fail({ code: 'VIDEO_PROMPT_SAVE_FAILED', error: '视频提示词保存失败，请重试。' })
    }
    return { saved: true, storyboard_id, video_prompt }
  },
})

export const storyboardTools = { readStoryboardContext, saveStoryboards, updateStoryboard }
