import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import {
  completeLibTVWebAuthorization, getLibTVWebAssistant, withLibTVAccount,
  disconnectLibTVAccount, getLibTVAccount, LibTVCliError, LibTVPhoneAuthorizationError, sendLibTVPhoneCode, startLibTVAuthorization,
  verifyLibTVPhoneCode, type LibTVAccount,
} from '../services/libtv-cli.js'
import {
  createVideoCliAccount, getActiveVideoCliAccountId, listVideoCliAccounts, removeVideoCliAccount,
  renameVideoCliAccount, resolveVideoCliAccountId, setActiveVideoCliAccount, VideoCliAccountError,
} from '../services/video-cli-accounts.js'
import { hasLoopbackAccess } from '../utils/private-access.js'
import { badRequest, success } from '../utils/response.js'
import { trustedSiteLoginScope } from './site-session.js'
import { whileVideoCliAccountRemoving } from '../services/video-cli-tasks.js'

const app = new Hono<{ Variables: { libtvLocal: boolean; libtvLoginScope: string | undefined } }>()
const siteLoginRequired = '请先登录 HTTPS 私有站点后使用 LibTV。'
const sendCode = z.strictObject({ phone: z.string().trim().regex(/^1[3-9]\d{9}$/u) })
const verifyCode = z.strictObject({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/u) })

// This callback is also mounted before local site-session middleware. Its expiring, single-use
// state maps only to a CLI loopback address created by this process; it accepts no target URL.
export const libtvCallbackRoutes = new Hono()
libtvCallbackRoutes.use('/auth/callback', bodyLimit({ maxSize: 32768 }))
libtvCallbackRoutes.post('/auth/callback', async c => {
  if (!/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/iu.test(c.req.header('Content-Type') ?? '')) {
    return c.json({ code: 400, message: 'LibTV 授权回调格式无效。' }, 400)
  }
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  const input = await c.req.parseBody()
  const result = await completeLibTVWebAuthorization(typeof input.state === 'string' ? input.state : '', typeof input.token === 'string' ? input.token : '')
  const nonce = randomUUID()
  c.header('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`)
  // Replace the token-bearing address immediately, including unsuccessful/expired callbacks.
  return c.html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>LibTV 授权</title><script nonce="${nonce}">history.replaceState(null,'',location.pathname);${result.ok ? 'window.close();' : ''}</script><p>${result.message}</p><a href="/">返回应用</a></html>`, result.ok ? 200 : 400)
})
app.route('/', libtvCallbackRoutes)

function publicAccount(account: LibTVAccount, local: boolean, hostedUser: boolean) {
  const { available, authenticated, status, canvas_ready, canvas_preparing, canvas_name, username, message, expires_at, verification_url, assistant_download_url, login_method } = account
  return { available, authenticated, status, canvas_ready, canvas_preparing, canvas_name, username, can_authorize: (local || hostedUser) && available,
    can_authorize_phone: hostedUser && available && !authenticated && status !== 'pending',
    can_prepare_canvas: (local || hostedUser) && authenticated && !canvas_ready,
    message,
    ...((local || hostedUser) && { expires_at }),
    ...((local || hostedUser) && { verification_url, assistant_download_url, login_method }) }
}

app.onError((error, c) => {
  if (error instanceof LibTVPhoneAuthorizationError) return c.json({ code: error.status, message: error.message }, error.status)
  if (error instanceof VideoCliAccountError) return c.json({ code: error.status, message: error.message }, error.status)
  if (error instanceof LibTVCliError) {
    const status = error.reason === 'account_busy' ? 409 : 502
    return c.json({ code: status, message: error.message }, status)
  }
  throw error
})

function phoneFailure(c: Context, error: unknown) {
  if (error instanceof LibTVPhoneAuthorizationError) return c.json({ code: error.status, message: error.message }, error.status)
  return c.json({ code: 503, message: '暂时无法使用 LibTV 手机号授权，请稍后重试。' }, 503)
}

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  const local = hasLoopbackAccess(c)
  const scope = local ? undefined : trustedSiteLoginScope(c)
  if (!local && !scope) return c.json({ code: 403, message: siteLoginRequired }, 403)
  c.set('libtvLocal', local)
  c.set('libtvLoginScope', scope)
  await next()
})

const accountName = z.strictObject({ name: z.string().trim().min(1).max(80) })
const newAccount = z.strictObject({ name: accountName.shape.name.optional() })
app.get('/accounts', c => success(c, { accounts: listVideoCliAccounts('libtv'), activeAccountId: getActiveVideoCliAccountId('libtv') }))
app.post('/accounts', bodyLimit({ maxSize: 1024 }), async c => {
  const raw = await c.req.text()
  let input: unknown = {}
  if (raw.trim()) {
    try { input = JSON.parse(raw) } catch { return badRequest(c, '账号请求格式无效。') }
  }
  const parsed = newAccount.safeParse(input)
  if (!parsed.success) return badRequest(c, '请输入 1–80 个字的账号名称。')
  return success(c, createVideoCliAccount('libtv', parsed.data.name))
})
app.put('/accounts/:id', bodyLimit({ maxSize: 1024 }), async c => {
  const parsed = accountName.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, '请输入 1–80 个字的账号名称。')
  return success(c, renameVideoCliAccount('libtv', c.req.param('id'), parsed.data.name))
})
app.post('/accounts/:id/activate', c => {
  setActiveVideoCliAccount('libtv', c.req.param('id'))
  return success(c, { activeAccountId: c.req.param('id') })
})
app.delete('/accounts/:id', async c => {
  const id = resolveVideoCliAccountId('libtv', c.req.param('id'))
  await whileVideoCliAccountRemoving('libtv', id, async () => {
    await withLibTVAccount(id, () => disconnectLibTVAccount({ removeIfUnauthenticated: true }))
    removeVideoCliAccount('libtv', id)
  })
  return success(c, { accounts: listVideoCliAccounts('libtv'), activeAccountId: getActiveVideoCliAccountId('libtv') })
})

app.use('*', async (c, next) => {
  const id = resolveVideoCliAccountId('libtv', c.req.query('accountId') ?? c.req.query('account_id'))
  return withLibTVAccount(id, next)
})

app.get('/auth/assistant', c => {
  const script = getLibTVWebAssistant(c.req.query('state') ?? '', c.get('libtvLoginScope') ?? 'local')
  c.header('Content-Disposition', 'attachment; filename="libtv-authorization.cmd"')
  c.header('Content-Type', 'application/octet-stream')
  c.header('X-Content-Type-Options', 'nosniff')
  return c.body(script)
})

app.get('/account', async c => {
  const local = c.get('libtvLocal')
  const scope = c.get('libtvLoginScope')
  return success(c, publicAccount(await getLibTVAccount(true, scope ?? 'local'), local, !!scope))
})
app.get('/auth/status', async c => success(c, publicAccount(await getLibTVAccount(false, c.get('libtvLoginScope') ?? 'local'), c.get('libtvLocal'), !!c.get('libtvLoginScope'))))
app.post('/auth/start', async c => {
  if (c.get('libtvLocal')) return success(c, publicAccount(await startLibTVAuthorization(), true, false))
  const account = await startLibTVAuthorization({ scope: c.get('libtvLoginScope'),
    helperOrigin: process.env.JIMENG_PRIVATE_ORIGIN })
  return success(c, publicAccount(account, false, true))
})
app.post('/auth/disconnect', async c => {
  const fetchSite = c.req.header('Sec-Fetch-Site')
  if (fetchSite && fetchSite !== 'same-origin') return c.json({ code: 403, message: '请在站内断开 LibTV 账号' }, 403)
  try {
    await disconnectLibTVAccount()
    return success(c, publicAccount(await getLibTVAccount(), c.get('libtvLocal'), !!c.get('libtvLoginScope')))
  } catch (error) {
    if (!(error instanceof LibTVCliError)) throw error
    const status = error.reason === 'account_busy' ? 409 : 502
    return c.json({ code: status, message: error.message }, status)
  }
})

app.use('/auth/phone/*', async (c, next) => {
  if (!c.get('libtvLoginScope')) return c.json({ code: 403, message: '请在 HTTPS 私有站点使用手机号授权 LibTV。' }, 403)
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(c.req.header('Content-Type') || '')) {
    return badRequest(c, '请使用 JSON 提交 LibTV 手机号授权。')
  }
  await next()
})
app.use('/auth/phone/*', bodyLimit({
  maxSize: 512,
  onError: c => c.json({ code: 413, message: 'LibTV 手机号授权内容过长。' }, 413),
}))

app.post('/auth/phone/send', async c => {
  const parsed = sendCode.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, '请输入 11 位中国大陆手机号。')
  try {
    return success(c, await sendLibTVPhoneCode(c.get('libtvLoginScope')!, parsed.data.phone))
  } catch (error) {
    return phoneFailure(c, error)
  }
})

app.post('/auth/phone/verify', async c => {
  const parsed = verifyCode.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return badRequest(c, '请输入 6 位短信验证码。')
  try {
    const account = await verifyLibTVPhoneCode(c.get('libtvLoginScope')!, parsed.data.challenge_id, parsed.data.code)
    return success(c, publicAccount(account, false, true))
  } catch (error) {
    return phoneFailure(c, error)
  }
})

export default app
