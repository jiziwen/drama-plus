/**
 * 技能管理路由 — 全部经 Mastra Workspace API 读写
 * 文件操作 jail 在 backend/workspace/ 目录内
 */
import { Hono } from 'hono'
import { success, badRequest } from '../utils/response.js'
import { refreshSkillWorkspaces, skillsManagerWorkspace } from '../agents/skills.js'

const app = new Hono()
const fsm = () => skillsManagerWorkspace.filesystem!
const unsupportedLang = (lang?: string) => Boolean(lang && lang !== 'zh')
const skillFile = (id: string) => `skills/${id}/SKILL.md`
const SKILL_ID_SEGMENT = /^[a-z0-9-]+$/

// GET /skills — 列出中文技能
app.get('/', async (c) => {
  if (unsupportedLang(c.req.query('lang'))) return badRequest(c, '仅支持中文')
  const metas = await skillsManagerWorkspace.skills?.list() || []
  return success(c, metas.map(meta => ({ id: meta.path.replace(/^skills\//, ''), name: meta.name, description: meta.description || '' })))
})

app.get('/*', async (c) => {
  const id = c.req.path.slice('/api/v1/skills/'.length)
  if (unsupportedLang(c.req.query('lang'))) return badRequest(c, '仅支持中文')
  if (!await fsm().exists(skillFile(id))) return badRequest(c, '技能不存在')
  const content = await fsm().readFile(skillFile(id), { encoding: 'utf-8' })
  return success(c, { id, lang: 'zh', content, is_default: false })
})

app.put('/*', async (c) => {
  const id = c.req.path.slice('/api/v1/skills/'.length)
  const body = await c.req.json()
  if (unsupportedLang(c.req.query('lang')) || unsupportedLang(body.lang)) return badRequest(c, '仅支持中文')
  await fsm().writeFile(skillFile(id), body.content, { recursive: true })
  await refreshSkillWorkspaces()
  return success(c)
})

// POST /skills — Create new skill directory
app.post('/', async (c) => {
  const body = await c.req.json()
  const { id, description } = body
  if (!id) return badRequest(c, 'Skill id 必填')
  // Mastra 技能规范：frontmatter name 必须与目录名一致，且只允许小写字母/数字/连字符
  const segments = String(id).split('/')
  if (!segments.every((seg: string) => SKILL_ID_SEGMENT.test(seg))) {
    return badRequest(c, 'Skill id 每段只能包含小写字母、数字和连字符')
  }
  if (await fsm().exists(skillFile(id))) return badRequest(c, '技能已存在')

  const name = segments[segments.length - 1]
  const content = `---
name: ${name}
description: ${description || ''}
---

# ${name}

请在此处编写技能内容。
`
  await fsm().writeFile(skillFile(id), content, { recursive: true, overwrite: false })
  await refreshSkillWorkspaces()
  return success(c, { id, name, description: description || '' })
})

// DELETE /skills/:id — Delete skill directory
app.delete('/*', async (c) => {
  const id = c.req.path.slice('/api/v1/skills/'.length)
  if (!await fsm().exists(`skills/${id}`)) return badRequest(c, '技能不存在')
  await fsm().rmdir(`skills/${id}`, { recursive: true })
  await refreshSkillWorkspaces()
  return success(c)
})

export default app
