import 'dotenv/config'
import { config as loadEnv } from 'dotenv'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import path from 'path'
import { fileURLToPath } from 'url'

import dramas from './routes/dramas.js'
import episodes from './routes/episodes.js'
import storyboards from './routes/storyboards.js'
import scenes from './routes/scenes.js'
import characters from './routes/characters.js'
import tasks from './routes/tasks.js'
import upload from './routes/upload.js'
import assetGallery from './routes/asset-gallery.js'
import aiConfigs, { aiProviders } from './routes/aiConfigs.js'
import stylePresets from './routes/stylePresets.js'
import prompts from './routes/prompts.js'
import agent from './routes/agent.js'
import merge from './routes/merge.js'
import skills from './routes/skills.js'
import props from './routes/props.js'
import settings from './routes/settings.js'
import storage from './routes/storage.js'
import apiCallLogs from './routes/apiCallLogs.js'
import localRuntime from './routes/localRuntime.js'
import scriptVideo, { scriptVideoStore } from './routes/script-video.js'
import { createDownmarketDramaRoutes } from './routes/downmarket-drama.js'
import { createNovelStoryboardRoutes } from './routes/novel-storyboard.js'
import aiChat from './routes/ai-chat.js'
import jimeng from './routes/jimeng.js'
import libtv, { libtvCallbackRoutes } from './routes/libtv.js'
import siteSession, { requireLocalSiteSession } from './routes/site-session.js'
import { requestLogger, errorHandler } from './middleware/logger.js'
import { resumeInterruptedTasks } from './services/generation.js'
import { SIGNED_REFERENCE_MEDIA_PATH, signedReferenceMediaRoutes } from './services/signed-reference-media.js'
import { DATA_ROOT } from './utils/paths.js'
import { localSiteCredentials } from './utils/private-access.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

if (process.env.NODE_ENV !== 'production' && process.env.HUOBAO_DESKTOP !== '1') {
  loadEnv({ path: path.join(__dirname, '..', '.env.local'), quiet: true })
}
const localSiteLogin = !!localSiteCredentials()

const app = new Hono()

// Middleware
app.use('*', cors({
  origin: ['http://localhost:3013', 'http://localhost:5679'],
  credentials: true,
}))
app.use('*', requestLogger)
app.use('*', errorHandler)

// Health check（version 供部署巡检/更新检查核对当前运行版本）
app.get('/api/v1/health', (c) => c.json({
  status: 'ok',
  version: process.env.HUOBAO_VERSION || undefined,
  timestamp: new Date().toISOString(),
}))

// API routes
const api = new Hono()
api.route('/site-session', siteSession)
api.route(SIGNED_REFERENCE_MEDIA_PATH, signedReferenceMediaRoutes)
api.route('/libtv', libtvCallbackRoutes)
api.use('*', requireLocalSiteSession)
api.route('/dramas', dramas)
api.route('/asset-gallery', assetGallery)
api.route('/episodes', episodes)
api.route('/storyboards', storyboards)
api.route('/scenes', scenes)
api.route('/characters', characters)
api.route('/tasks', tasks)
api.route('/upload', upload)
api.route('/ai-configs', aiConfigs)
api.route('/ai-providers', aiProviders)
api.route('/style-presets', stylePresets)
api.route('/prompts', prompts)
api.route('/agent', agent)
api.route('/merge', merge)
api.route('/skills', skills)
api.route('/props', props)
api.route('/storage', storage)
api.route('/settings', settings)
api.route('/api-call-logs', apiCallLogs)
api.route('/local-runtime', localRuntime)
api.route('/script-video', scriptVideo)
api.route('/downmarket-drama', createDownmarketDramaRoutes(scriptVideoStore))
api.route('/novel-storyboard', createNovelStoryboardRoutes())
api.route('/ai-chat', aiChat)
api.route('/jimeng', jimeng)
api.route('/libtv', libtv)

app.route('/api/v1', api)

// Serve static files (storage)
// 生成的图片/视频按 uuid 命名、内容不变，标记为 immutable 让浏览器长缓存
app.use('/static/*', requireLocalSiteSession, async (c, next) => {
  await next()
  if (c.res.ok) c.header('Cache-Control', localSiteLogin ? 'private, no-store' : 'public, max-age=31536000, immutable')
})
app.use('/static/*', serveStatic({ root: DATA_ROOT }))
// 缺失的素材应返回 404，避免把前端页面当图片缓存。
app.get('/static/*', c => c.text('素材不存在', 404, { 'Cache-Control': 'no-store' }))

// Serve frontend (production build) — 桌面版由主进程注入 FRONTEND_DIST（resources/frontend）
const distPath = process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist')
app.use('*', serveStatic({ root: distPath }))
app.get('*', serveStatic({ root: distPath, path: 'index.html' }))

const port = Number(process.env.PORT || 5679)
console.log(`🚀 Huobao Drama TS server on http://localhost:${port}`)

await resumeInterruptedTasks()

serve({ fetch: app.fetch, port, ...(localSiteLogin ? { hostname: '127.0.0.1' } : {}) })
