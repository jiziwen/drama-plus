/** Agent 中文 prompt 管理路由。 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { skillsManagerWorkspace } from '../agents/skills.js'
import { validAgentTypes, DEFAULT_PROMPTS } from '../agents/index.js'
import { loadAgentPromptFile, serializePromptFile, promptFilePath } from '../agents/prompts.js'

const app = new Hono()
const fsm = () => skillsManagerWorkspace.filesystem!

const checkType = (type: string) => validAgentTypes.includes(type)
const unsupportedLang = (lang?: string) => Boolean(lang && lang !== 'zh')

// GET /prompts — 列出全部 Agent 的 prompt 状态（基础版口径；name/model 只属于基础版）
app.get('/', async (c) => {
  const list = await Promise.all(validAgentTypes.map(async (type) => {
    const file = await loadAgentPromptFile(type)
    return {
      agent_type: type,
      name: file?.name || DEFAULT_PROMPTS[type].name,
      model: file?.model || '',
      is_default: !file,
    }
  }))
  return success(c, list)
})

// GET /prompts/:type — 中文内容
app.get('/:type', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, '未知的 Agent 类型')
  if (unsupportedLang(c.req.query('lang'))) return badRequest(c, '仅支持中文')
  const file = await loadAgentPromptFile(type)
  return success(c, {
    agent_type: type, lang: 'zh',
    name: file?.name || DEFAULT_PROMPTS[type].name,
    model: file?.model || '',
    system_prompt: file?.instructions || DEFAULT_PROMPTS[type].instructions,
    is_default: !file,
  })
})

app.put('/:type', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, '未知的 Agent 类型')
  const body = await c.req.json()
  if (unsupportedLang(c.req.query('lang')) || unsupportedLang(body.lang)) return badRequest(c, '仅支持中文')
  const instructions = String(body.system_prompt ?? '').trim()
  if (!instructions) return badRequest(c, 'system_prompt 必填')
  const name = String(body.name || DEFAULT_PROMPTS[type].name)
  const model = String(body.model ?? '').trim()
  await fsm().writeFile(promptFilePath(type), serializePromptFile({ name, model, instructions }), { recursive: true })
  return success(c, { agent_type: type, lang: 'zh', name, model, is_default: false })
})

app.post('/:type/reset', async (c) => {
  const type = c.req.param('type')
  if (!checkType(type)) return badRequest(c, '未知的 Agent 类型')
  if (unsupportedLang(c.req.query('lang'))) return badRequest(c, '仅支持中文')
  const path = promptFilePath(type)
  if (await fsm().exists(path)) await fsm().deleteFile(path)
  return success(c, { agent_type: type, lang: 'zh', is_default: true })
})

export default app
