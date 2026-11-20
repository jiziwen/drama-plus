import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'])
const privateProxyHeader = 'X-Drama-Jimeng-Private-Proxy'
const localSiteOrigins = new Set(['http://localhost:3013', 'http://127.0.0.1:3013'])
const siteUsername = /^[a-zA-Z0-9_.@-]{1,128}$/u
const bcryptHash = /^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/u
export const localSiteAdmin = 'admin'
export const localSiteMember = 'member'

const snapshotSchema = z.object({
  administrator: z.string().regex(siteUsername),
  feedbackAdministrator: z.string().regex(siteUsername).optional(),
  hashes: z.record(z.string().regex(siteUsername), z.string().regex(bcryptHash)),
}).refine(({ administrator, feedbackAdministrator, hashes }) =>
  Object.hasOwn(hashes, administrator) && (!feedbackAdministrator || Object.hasOwn(hashes, feedbackAdministrator)))

export type LocalSiteCredentials = { secret: string } & (
  { mode: 'passwords'; administrator: typeof localSiteAdmin; adminPassword: string; memberPassword: string } |
  { mode: 'snapshot' } & z.infer<typeof snapshotSchema>
)
const invalidLocalSite = { mode: 'invalid' } as const

declare module 'hono' {
  interface ContextVariableMap {
    localSiteIdentity: { username: string; administrator: boolean; canManageFeedback: boolean } | undefined
  }
}

export function localSiteCredentials(): LocalSiteCredentials | typeof invalidLocalSite | undefined {
  if (process.env.NODE_ENV === 'production' || process.env.HUOBAO_DESKTOP === '1') return
  const secret = process.env.DRAMA_LOCAL_SITE_SESSION_SECRET
  const snapshot = process.env.DRAMA_LOCAL_SITE_ACCOUNTS
  if (snapshot !== undefined) {
    if (!secret || Buffer.byteLength(secret) < 32) return invalidLocalSite
    try {
      const result = snapshotSchema.safeParse(JSON.parse(snapshot))
      if (result.success) return { mode: 'snapshot', secret, ...result.data }
    } catch { /* A malformed configured snapshot disables local login. */ }
    return invalidLocalSite
  }

  const adminPassword = process.env.DRAMA_LOCAL_SITE_ADMIN_PASSWORD
  const memberPassword = process.env.DRAMA_LOCAL_SITE_MEMBER_PASSWORD
  if (adminPassword && memberPassword && secret && Buffer.byteLength(secret) >= 32) {
    return { mode: 'passwords', administrator: localSiteAdmin, adminPassword, memberPassword, secret }
  }
}

function parseHttpUrl(value?: string): URL | undefined {
  if (!value) return
  try {
    const url = new URL(value)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return url
  } catch {}
}

function configuredProxySecret() {
  const secret = process.env.JIMENG_PRIVATE_PROXY_SECRET?.trim()
  if (secret) return secret
  const file = process.env.JIMENG_PRIVATE_PROXY_SECRET_FILE?.trim()
  if (!file) return
  try { return readFileSync(file, 'utf8').trim() } catch {}
}

function validProxySecret(provided: string, expected: string) {
  const expectedBytes = Buffer.from(expected)
  const providedBytes = Buffer.from(provided)
  return expectedBytes.length >= 32 && expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes)
}

export function hasLoopbackAccess(c: Context) {
  const remote = c.env?.incoming || c.env?.server?.incoming ? getConnInfo(c).remote.address : undefined
  const host = c.req.header('Host')?.toLowerCase()
  const requestUrl = parseHttpUrl(c.req.url)
  if (!remote || !loopback.has(remote) || !requestUrl || host !== requestUrl.host || !loopback.has(requestUrl.hostname)) return false
  const origin = c.req.header('Origin')
  const localOrigin = parseHttpUrl(origin)
  return c.req.header('Sec-Fetch-Site') !== 'cross-site' && (!origin || !!(localOrigin && origin === localOrigin.origin && loopback.has(localOrigin.hostname)))
}

export function hasLocalSiteAccess(c: Context) {
  if (!hasLoopbackAccess(c)) return false
  const fetchSite = c.req.header('Sec-Fetch-Site')
  if (fetchSite && fetchSite !== 'same-origin') return false
  const origin = c.req.header('Origin')
  return origin ? localSiteOrigins.has(origin) : c.req.method === 'GET' || c.req.method === 'HEAD'
}

function verifiedPrivateGateway(c: Context) {
  const host = c.req.header('Host')?.toLowerCase()
  const requestUrl = parseHttpUrl(c.req.url)
  const gateway = parseHttpUrl(process.env.JIMENG_PRIVATE_ORIGIN?.trim())
  if (gateway?.protocol !== 'https:' || gateway.pathname !== '/' || gateway.search || gateway.hash || host !== gateway.host || requestUrl?.host !== host) return
  const marker = c.req.header(privateProxyHeader)
  const secret = configuredProxySecret()
  if (marker && secret && validProxySecret(marker, secret)) return { origin: gateway.origin, secret }
}

export function hasPrivateGatewayAccess(c: Context) {
  const gateway = verifiedPrivateGateway(c)
  if (!gateway) return false
  // Caddy terminates TLS and preserves the public Host on the HTTP upstream connection.
  const origin = c.req.header('Origin')
  const fetchSite = c.req.header('Sec-Fetch-Site')
  if ((origin && origin !== gateway.origin) || (fetchSite && fetchSite !== 'same-origin')) return false
  const readOnly = c.req.method === 'GET' || c.req.method === 'HEAD'
  if (!readOnly && origin !== gateway.origin && fetchSite !== 'same-origin') return false

  return true
}

// Navigations checked by the proxy can originate outside the private site.
// Keep the signing key separate from the credential used in proxy headers.
export function siteSessionSigningKey(c: Context) {
  const gateway = verifiedPrivateGateway(c)
  if (gateway) return createHmac('sha256', gateway.secret).update('drama-plus/site-session/v1').digest()
}

export function trustedGatewayUser(c: Context) {
  const user = c.req.header('X-Drama-Authenticated-User')
  return user && siteUsername.test(user) && hasPrivateGatewayAccess(c) ? user : ''
}

export function trustedSiteUser(c: Context) {
  return c.get('localSiteIdentity')?.username ?? trustedGatewayUser(c)
}

function hasLocalSettingsAccess(c: Context) {
  const local = process.env.NODE_ENV !== 'production' || process.env.HUOBAO_DESKTOP === '1'
  return local && !localSiteCredentials() && hasLoopbackAccess(c)
}

export function hasFeedbackAdminAccess(c: Context) {
  const localIdentity = c.get('localSiteIdentity')
  if (localIdentity) return localIdentity.canManageFeedback
  if (hasLocalSettingsAccess(c)) return true
  const username = trustedGatewayUser(c)
  const operator = process.env.FEEDBACK_ADMIN_USER?.trim()
  return isReleaseNotesAdministrator(username) || (!!username && username === operator)
}

export function isReleaseNotesAdministrator(username: string) {
  return !!username && username === process.env.RELEASE_NOTES_ADMIN_USER?.trim()
}

export function hasReleaseNotesAdminAccess(c: Context) {
  const localIdentity = c.get('localSiteIdentity')
  if (localIdentity) return localIdentity.administrator
  return hasLocalSettingsAccess(c) || isReleaseNotesAdministrator(trustedGatewayUser(c))
}
