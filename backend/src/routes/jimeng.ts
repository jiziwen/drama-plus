import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { disconnectJimengAccount, getJimengAccount, getJimengVideoModels, JimengCliError, startJimengAuthorization, withJimengAccount, getCurrentJimengAccountId } from '../services/jimeng-cli.js'
import { createVideoCliAccount, getActiveVideoCliAccountId, listVideoCliAccounts, removeVideoCliAccount, renameVideoCliAccount, setActiveVideoCliAccount, VideoCliAccountError } from '../services/video-cli-accounts.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess } from '../utils/private-access.js'
import { success } from '../utils/response.js'
import { whileVideoCliAccountRemoving } from '../services/video-cli-tasks.js'

const app = new Hono()
const privateAccessRequired = '即梦积分仅可从本机访问，或通过已配置即梦访问的 HTTPS 私有网关登录后使用。'

export function requireJimengPrivateAccess(c: Context) {
  if (hasLoopbackAccess(c) || hasPrivateGatewayAccess(c)) return
  throw new Error(privateAccessRequired)
}

export function denyJimengPrivateAccess(c: Context) {
  return c.json({ code: 403, message: privateAccessRequired }, 403)
}

export async function publicJimengAccount() {
  const { available, authenticated, username, credits, membership, message, authorizationPending } = await getJimengAccount()
  return { available, authenticated, username, credits, membership, message, accountId: getCurrentJimengAccountId(), status: authorizationPending ? 'pending' : undefined }
}

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
  await next()
})

app.onError((error, c) => {
  if (error instanceof VideoCliAccountError) return c.json({ code: error.status, message: error.message }, error.status)
  if (error instanceof JimengCliError) {
    const status = error.reason === 'account_busy' ? 409 : 502
    return c.json({ code: status, message: error.message }, status)
  }
  throw error
})

app.get('/accounts', c => success(c, { accounts: listVideoCliAccounts('jimeng'), activeAccountId: getActiveVideoCliAccountId('jimeng') }))
const newAccount = z.strictObject({ name: z.string().trim().min(1).max(80).optional() })
app.post('/accounts', bodyLimit({ maxSize: 1024 }), async c => {
  const raw = await c.req.text()
  let input: unknown = {}
  if (raw.trim()) {
    try { input = JSON.parse(raw) } catch { throw new VideoCliAccountError('账号请求格式无效') }
  }
  const parsed = newAccount.safeParse(input)
  if (!parsed.success) throw new VideoCliAccountError('账号名称需为 1–80 个字符')
  return success(c, createVideoCliAccount('jimeng', parsed.data.name))
})
async function updateAccount(c: Context) {
  const id = c.req.param('id')!
  const body = await c.req.json().catch(() => ({}))
  if (body.name !== undefined) renameVideoCliAccount('jimeng', id, body.name)
  if (body.active === true) setActiveVideoCliAccount('jimeng', id)
  const account = listVideoCliAccounts('jimeng').find(entry => entry.id === id)
  if (!account) throw new VideoCliAccountError('所选视频账号不存在', 404)
  return success(c, account)
}
app.patch('/accounts/:id', updateAccount)
app.put('/accounts/:id', updateAccount)
app.post('/accounts/:id/activate', c => { setActiveVideoCliAccount('jimeng', c.req.param('id')); return success(c, { activeAccountId: c.req.param('id') }) })
app.delete('/accounts/:id', async c => {
  const id = c.req.param('id')
  await whileVideoCliAccountRemoving('jimeng', id, async () => {
    await withJimengAccount(id, () => disconnectJimengAccount({ removeIfUnauthenticated: true }))
    removeVideoCliAccount('jimeng', id)
  })
  return success(c, { accounts: listVideoCliAccounts('jimeng'), activeAccountId: getActiveVideoCliAccountId('jimeng') })
})

app.use('/account', (c, next) => withJimengAccount(c.req.query('accountId') ?? c.req.query('account_id'), next))
app.use('/auth/*', (c, next) => withJimengAccount(c.req.query('accountId') ?? c.req.query('account_id'), next))

app.get('/account', async c => {
  const account = await publicJimengAccount()
  const models = account.available ? await getJimengVideoModels().catch(error => {
    if (error instanceof JimengCliError) { account.message ||= error.message; return [] }
    throw error
  }) : []
  return success(c, { ...account, models: models.map(model => model.id) })
})
app.get('/auth/status', async c => success(c, await publicJimengAccount()))
app.post('/auth/start', async c => {
  try {
    const result = await startJimengAuthorization()
    return success(c, { available: true, authenticated: result.authenticated, verification_url: result.verificationUrl,
      user_code: result.userCode, status: result.pending ? 'pending' : undefined, message: result.message })
  } catch (error) {
    if (error instanceof JimengCliError && error.reason === 'account_busy') return c.json({ code: 409, message: error.message }, 409)
    if (error instanceof JimengCliError) return c.json({ code: 502, message: error.message }, 502)
    throw error
  }
})
app.post('/auth/disconnect', async c => {
  try {
    await disconnectJimengAccount()
    return success(c, { available: true, authenticated: false })
  } catch (error) {
    if (error instanceof JimengCliError && error.reason === 'account_busy') return c.json({ code: 409, message: error.message }, 409)
    if (error instanceof JimengCliError) return c.json({ code: 502, message: error.message }, 502)
    throw error
  }
})

export default app
