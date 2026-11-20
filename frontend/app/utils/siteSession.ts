export interface SiteAccount {
  username: string
  administrator: boolean
}

export const defaultSitePage = '/script-to-video?interface=cinematic'
const sessionPath = '/api/v1/site-session'
const validationOrigin = 'https://site.invalid'

export function safeSiteNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
      /[\\\u0000-\u001f\u007f]/u.test(value)) return defaultSitePage
  try {
    const url = new URL(value, validationOrigin)
    const pathname = decodeURIComponent(url.pathname)
    if (url.origin !== validationOrigin || pathname.startsWith('//') ||
        /[\\\u0000-\u001f\u007f]/u.test(pathname) || /^\/(?:site-login|api)(?:\/|$)/u.test(pathname)) {
      return defaultSitePage
    }
    return url.pathname + url.search + url.hash
  } catch { return defaultSitePage }
}

export function siteLoginPath(next?: unknown) {
  return typeof next === 'string'
    ? '/site-login?' + new URLSearchParams({ next: safeSiteNext(next) }).toString()
    : '/site-login'
}

export class SiteLoginError extends Error {
  constructor(readonly status: number) { super('Site login failed') }
}

async function siteSessionRequest(path: string, options: RequestInit = {}) {
  return fetch(sessionPath + path, { ...options, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
}

async function responseAccount(response: Response): Promise<SiteAccount | null> {
  const { data } = await response.json()
  if (!data || typeof data.username !== 'string' || !data.username || typeof data.administrator !== 'boolean') return null
  return { username: data.username, administrator: data.administrator }
}

export async function readSiteAccount(): Promise<SiteAccount | null> {
  try {
    const response = await siteSessionRequest('/me')
    return response.ok ? await responseAccount(response) : null
  } catch { return null }
}

export async function requiresLocalSiteLogin(): Promise<boolean> {
  try {
    const response = await siteSessionRequest('/me')
    return response.status === 401 && response.headers.get('X-Drama-Local-Site-Login') === 'required'
  } catch { return false }
}

export async function loginToSite(username: string, password: string): Promise<SiteAccount> {
  if (!username || username.includes(':') || !password) throw new SiteLoginError(401)
  const bytes = new TextEncoder().encode(username + ':' + password)
  const basic = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
  const response = await siteSessionRequest('/login', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic },
  })
  if (!response.ok) throw new SiteLoginError(response.status)
  const account = await responseAccount(response)
  if (!account) throw new SiteLoginError(502)
  return account
}

export async function logoutFromSite() {
  const response = await siteSessionRequest('/logout', { method: 'POST' })
  if (!response.ok) throw new SiteLoginError(response.status)
}
