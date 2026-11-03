import { Hono } from 'hono'
import { db, schema } from '../db/index.js'
import { success, badRequest } from '../utils/response.js'
import { localRuntimeSupported, localRuntimeEnabled, localRuntimeStatus, configureLocalRuntime, requestComfyStartup } from '../services/local-runtime.js'

const app = new Hono()
app.get('/', async c => success(c, { supported: localRuntimeSupported, enabled: localRuntimeEnabled(), ...await localRuntimeStatus() }))
app.put('/', async c => {
  const body = await c.req.json()
  if (!localRuntimeSupported || typeof body.enabled !== 'boolean') return badRequest(c, '当前部署不支持自动启动或开关值无效')
  configureLocalRuntime(body.enabled)
  return success(c, { enabled: localRuntimeEnabled() })
})
app.post('/ensure-comfyui', async c => {
  const configs = db.select().from(schema.aiServiceConfigs).all()
  if (!configs.some(cfg => cfg.provider === 'comfyui' && cfg.isActive)) return success(c, { started: false, message: '未启用 ComfyUI 配置' })
  return success(c, await requestComfyStartup())
})
export default app
