/**
 * 应用设置路由 — 全局配置的读写入口
 */
import { Hono } from 'hono'
import { getContentLanguage, setContentLanguage, getToursSeen, setToursSeen, getVideoPromptMode, setVideoPromptMode, CONTENT_LANGUAGES, type ContentLanguage } from '../services/app-settings.js'
import { isVideoPromptMode } from '../services/video-prompt-mode.js'
import { success, badRequest } from '../utils/response.js'
import feedback from './feedback.js'
import releaseNotes from './release-notes.js'

const app = new Hono()
app.route('/feedback', feedback)
app.route('/release-notes', releaseNotes)

app.get('/video-prompt-mode', c => {
  c.header('Cache-Control', 'no-store')
  return success(c, { mode: getVideoPromptMode() })
})

app.put('/video-prompt-mode', async c => {
  const body = await c.req.json().catch(() => null)
  if (!isVideoPromptMode(body?.mode)) return badRequest(c, '请选择有效的视频提示词排版模式')
  return success(c, { mode: setVideoPromptMode(body.mode) })
})

// GET /content-language — 当前 AI 内容语言
app.get('/content-language', async (c) => {
  return success(c, { language: await getContentLanguage() })
})

// PUT /content-language — 兼容旧客户端，仅接受中文（body: { language: 'zh' }）
app.put('/content-language', async (c) => {
  const body = await c.req.json().catch(() => null)
  const language = body?.language
  if (!(CONTENT_LANGUAGES as readonly string[]).includes(language)) {
    return badRequest(c, `language 必须是 ${CONTENT_LANGUAGES.join(' / ')} 之一`)
  }
  const saved = await setContentLanguage(language as ContentLanguage)
  return success(c, { language: saved })
})

// GET /tours-seen — 已看过的引导漫游 id 列表
app.get('/tours-seen', async (c) => {
  return success(c, { seen: await getToursSeen() })
})

// PUT /tours-seen — 写入已看过的引导漫游 id 列表（body: { seen: string[] }）
app.put('/tours-seen', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!Array.isArray(body?.seen) || !body.seen.every((v: unknown) => typeof v === 'string')) {
    return badRequest(c, 'seen 必须是字符串数组')
  }
  return success(c, { seen: await setToursSeen(body.seen) })
})

export default app
