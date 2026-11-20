import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { compare } from 'bcryptjs'
import { and, eq, gt, lte } from 'drizzle-orm'
import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { db } from '../db/index.js'
import { siteSessions } from '../db/schema.js'
import {
  hasLocalSiteAccess, hasPrivateGatewayAccess, isReleaseNotesAdministrator, localSiteCredentials,
  localSiteMember, siteSessionSigningKey, trustedGatewayUser, type LocalSiteCredentials,
} from '../utils/private-access.js'
import { success } from '../utils/response.js'

const app = new Hono()
const cookieName = '__Host-drama-plus-session'
const localCookieName = '__Host-drama-plus-local-session'
const lifetimeSeconds = 7 * 24 * 60 * 60
const cookieOptions = { path: '/', httpOnly: true, secure: true, sameSite: 'Lax' } as const
const identityHeader = 'X-Drama-Authenticated-User'

function signature(id: string, key: Buffer) {
  return createHmac('sha256', key).update(id).digest('base64url')
}

function sessionHash(id: string) {
  return createHash('sha256').update(id).digest('hex')
}

function signedCookieHash(c: Context, key: Buffer, name = cookieName) {
  const value = getCookie(c, name)
  const match = value && /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u.exec(value)
  if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(signature(match[1], key)))) return
  return sessionHash(match[1])
}

function currentSession(c: Context, key: Buffer, name = cookieName) {
  const idHash = signedCookieHash(c, key, name)
  if (!idHash) return
  return db.select({ username: siteSessions.username, hash: siteSessions.sessionHash }).from(siteSessions)
    .where(and(eq(siteSessions.sessionHash, idHash), gt(siteSessions.expiresAt, Date.now()))).get()
}

function account(username: string, local?: LocalSiteCredentials) {
  return { username, administrator: local ? username === local.administrator : isReleaseNotesAdministrator(username) }
}

function localSigningKey(credentials: LocalSiteCredentials) {
  const accounts = credentials.mode === 'snapshot'
    ? [credentials.administrator, credentials.feedbackAdministrator, Object.entries(credentials.hashes).sort()]
    : [credentials.adminPassword, credentials.memberPassword]
  return createHmac('sha256', credentials.secret).update('drama-plus/local-site-session/v1')
    .update(JSON.stringify(accounts)).digest()
}

async function localLoginUser(c: Context, credentials: LocalSiteCredentials) {
  const basic = /^Basic ([A-Za-z0-9+/]+={0,2})$/iu.exec(c.req.header('Authorization') ?? '')?.[1]
  if (!basic || basic.length > 1024) return
  const decoded = Buffer.from(basic, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  if (credentials.mode === 'snapshot') {
    if (Object.hasOwn(credentials.hashes, username) && await compare(password, credentials.hashes[username])) return username
    return
  }
  const expected = username === credentials.administrator ? credentials.adminPassword
    : username === localSiteMember ? credentials.memberPassword : undefined
  if (expected && timingSafeEqual(createHash('sha256').update(password).digest(), createHash('sha256').update(expected).digest())) return username
}

export const requireLocalSiteSession: MiddlewareHandler = async (c, next) => {
  const credentials = localSiteCredentials()
  if (!credentials) return next()
  if (!hasLocalSiteAccess(c)) return unauthorized(c)
  if (credentials.mode === 'invalid') return invalidLocalConfiguration(c)
  const session = currentSession(c, localSigningKey(credentials), localCookieName)
  if (!session) return unauthorized(c)
  const identity = account(session.username, credentials)
  c.set('localSiteIdentity', {
    ...identity,
    canManageFeedback: identity.administrator ||
      (credentials.mode === 'snapshot' && session.username === credentials.feedbackAdministrator),
  })
  return next()
}

export function trustedSiteLoginScope(c: Context) {
  const username = trustedGatewayUser(c)
  if (!username) return
  // The legacy private gateway still authenticates its own Basic login if no site session is present.
  if (getCookie(c, cookieName) === undefined) return 'gateway:' + username
  const key = siteSessionSigningKey(c)
  const session = key && currentSession(c, key)
  if (session?.username === username) return 'browser:' + session.hash
}

function unauthorized(c: Context) {
  return c.json({ code: 401, message: '请登录站点。' }, 401)
}

function forbidden(c: Context) {
  return c.json({ code: 403, message: '请通过 HTTPS 私有站点操作登录状态。' }, 403)
}

function invalidLocalConfiguration(c: Context) {
  return c.json({ code: 503, message: '本地账号配置无效。' }, 503)
}

function forwardedPage(c: Context) {
  const method = c.req.header('X-Forwarded-Method')
  if (method !== 'GET' && method !== 'HEAD') return
  const destination = c.req.header('Sec-Fetch-Dest')
  if (destination && destination !== 'document' && destination !== 'iframe') return
  const raw = c.req.header('X-Forwarded-Uri')
  if (!raw || raw.length > 2_048 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\p{Cc}]/u.test(raw)) return

  try {
    const path = new URL(raw, 'https://private.invalid')
    const decodedPath = decodeURIComponent(path.pathname)
    if (path.origin !== 'https://private.invalid' || path.hash || decodedPath.startsWith('//') ||
        /[\\\p{Cc}]/u.test(decodedPath)) return
    if (/^\/(?:api|_nuxt|static|site-login)(?:\/|$)/iu.test(decodedPath) ||
        /\.(?:ico|svg|png|jpg|jpeg|webp|css|js|woff2?)$/iu.test(decodedPath)) return
    return path.pathname + path.search
  } catch { /* An invalid forwarded URI never becomes a redirect target. */ }
}

app.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

app.post('/login', async c => {
  const local = localSiteCredentials()
  const allowed = local ? hasLocalSiteAccess(c) : hasPrivateGatewayAccess(c)
  if (!allowed) return forbidden(c)
  if (local?.mode === 'invalid') return invalidLocalConfiguration(c)
  const key = local ? localSigningKey(local) : siteSessionSigningKey(c)
  if (!key) return forbidden(c)
  const username = local ? await localLoginUser(c, local) : trustedGatewayUser(c)
  if (!username) return unauthorized(c)

  const name = local ? localCookieName : cookieName
  const previous = signedCookieHash(c, key, name)
  const id = randomBytes(32).toString('base64url')
  const now = Date.now()
  db.transaction(tx => {
    tx.delete(siteSessions).where(lte(siteSessions.expiresAt, now)).run()
    if (previous) tx.delete(siteSessions).where(eq(siteSessions.sessionHash, previous)).run()
    tx.insert(siteSessions).values({
      sessionHash: sessionHash(id), username, expiresAt: now + lifetimeSeconds * 1_000,
    }).run()
  }, { behavior: 'immediate' })
  setCookie(c, name, id + '.' + signature(id, key), { ...cookieOptions, maxAge: lifetimeSeconds })
  return success(c, account(username, local))
})

app.get('/check', c => {
  const key = siteSessionSigningKey(c)
  if (!key) return unauthorized(c)
  const active = currentSession(c, key)
  if (active) {
    c.header(identityHeader, active.username)
    return c.body(null, 204)
  }
  const page = forwardedPage(c)
  if (page) return c.redirect('/site-login?' + new URLSearchParams({ next: page }))
  return unauthorized(c)
})

app.get('/me', c => {
  const local = localSiteCredentials()
  if (local) {
    if (!hasLocalSiteAccess(c)) return unauthorized(c)
    if (local.mode === 'invalid') return invalidLocalConfiguration(c)
    const active = currentSession(c, localSigningKey(local), localCookieName)
    if (active) return success(c, account(active.username, local))
    c.header('X-Drama-Local-Site-Login', 'required')
    return unauthorized(c)
  }
  const key = siteSessionSigningKey(c)
  if (!key || !hasPrivateGatewayAccess(c)) return unauthorized(c)
  const active = currentSession(c, key)
  return active ? success(c, account(active.username)) : unauthorized(c)
})

app.post('/logout', c => {
  const local = localSiteCredentials()
  const allowed = local ? hasLocalSiteAccess(c) : hasPrivateGatewayAccess(c)
  if (!allowed) return forbidden(c)
  if (local?.mode === 'invalid') return invalidLocalConfiguration(c)
  const key = local ? localSigningKey(local) : siteSessionSigningKey(c)
  if (!key) return forbidden(c)

  const name = local ? localCookieName : cookieName
  const idHash = signedCookieHash(c, key, name)
  if (idHash) db.delete(siteSessions).where(eq(siteSessions.sessionHash, idHash)).run()
  deleteCookie(c, name, cookieOptions)
  return c.body(null, 204)
})

export default app
