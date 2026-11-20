import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import {
  disconnectLibTVAccount, getLibTVAccount, LibTVCliError, LibTVPhoneAuthorizationError, sendLibTVPhoneCode, startLibTVAuthorization,
  startLibTVCanvasPreparation, verifyLibTVPhoneCode, type LibTVAccount,
} from '../services/libtv-cli.js'
import { hasLoopbackAccess } from '../utils/private-access.js'
import { badRequest, success } from '../utils/response.js'
import { trustedSiteLoginScope } from './site-session.js'

const app = new Hono<{ Variables: { libtvLocal: boolean; libtvLoginScope: string | undefined } }>()
const siteLoginRequired = '请先登录 HTTPS 私有站点后使用 LibTV。'
const sendCode = z.strictObject({ phone: z.string().trim().regex(/^1[3-9]\d{9}$/u) })
const verifyCode = z.strictObject({ challenge_id: z.uuid(), code: z.string().regex(/^\d{6}$/u) })

function publicAccount(account: LibTVAccount, local: boolean, hostedUser: boolean) {
  const { available, authenticated, status, canvas_ready, canvas_preparing, canvas_name, username, message, expires_at, verification_url } = account
  return { available, authenticated, status, canvas_ready, canvas_preparing, canvas_name, username, can_authorize: local && available,
    can_authorize_phone: hostedUser && available && !authenticated && status !== 'pending',
    can_prepare_canvas: (local || hostedUser) && authenticated && !canvas_ready,
    message,
    ...((local || hostedUser) && { expires_at }),
    ...(local && { verification_url }) }
}

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

app.get('/account', async c => {
  const local = c.get('libtvLocal')
  return success(c, publicAccount(await getLibTVAccount(local), local, !!c.get('libtvLoginScope')))
})
app.get('/auth/status', async c => success(c, publicAccount(await getLibTVAccount(), c.get('libtvLocal'), !!c.get('libtvLoginScope'))))
app.post('/auth/start', async c => {
  if (c.get('libtvLocal')) return success(c, publicAccount(await startLibTVAuthorization(), true, false))
  const account = await startLibTVCanvasPreparation()
  if (!account.authenticated && !account.canvas_preparing) return c.json({ code: 409, message: '请先使用手机号授权 LibTV。' }, 409)
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
