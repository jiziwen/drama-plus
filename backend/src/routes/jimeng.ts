import { Hono, type Context } from 'hono'
import { disconnectJimengAccount, getJimengAccount, getJimengVideoModels, JimengCliError, startJimengAuthorization } from '../services/jimeng-cli.js'
import { hasLoopbackAccess, hasPrivateGatewayAccess } from '../utils/private-access.js'
import { success } from '../utils/response.js'

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
  return { available, authenticated, username, credits, membership, message, status: authorizationPending ? 'pending' : undefined }
}

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  try { requireJimengPrivateAccess(c) } catch { return denyJimengPrivateAccess(c) }
  await next()
})

app.get('/account', async c => {
  const account = await publicJimengAccount()
  const models = account.available ? await getJimengVideoModels().catch(() => []) : []
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
