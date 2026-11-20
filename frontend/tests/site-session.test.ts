import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultSitePage, loginToSite, logoutFromSite, readSiteAccount, safeSiteNext, siteLoginPath, SiteLoginError } from '../app/utils/siteSession'

test('site login accepts only a relative same-origin page to return to', () => {
  const next = '/script-to-video?interface=classic#episode'
  assert.equal(safeSiteNext(next), next)
  assert.equal(safeSiteNext('/settings?tab=ai&interface=cinematic'), '/settings?tab=ai&interface=cinematic')
  assert.equal(siteLoginPath(), '/site-login')
  assert.equal(new URL(siteLoginPath(next), 'https://test.example').searchParams.get('next'), next)
  for (const input of [
    undefined, ['//outside.example'], 'https://outside.example', '//outside.example', '/\\outside.example',
    '/%5coutside.example', '/%2Foutside.example', '/\t/outside.example', '/site-login', '/a/../site-login', '/%73ite-login',
    '/api/v1/site-session/me', '/%00', '/%',
  ]) assert.equal(safeSiteNext(input), defaultSitePage)
})

test('site session uses exact same-origin endpoints, sends credentials only in the login header and hides unverified identity', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const requests: { path: string; options?: RequestInit }[] = []
  let loggedIn = false
  globalThis.fetch = async (input, options) => {
    const path = String(input)
    requests.push({ path, options })
    assert.equal(options?.credentials, 'same-origin')
    assert.equal(options?.redirect, 'error')
    assert.equal(options?.body, undefined)
    assert.equal(options?.cache, 'no-store')
    const authorization = new Headers(options?.headers).get('authorization')
    if (path.endsWith('/login')) {
      assert.equal(options?.method, 'POST')
      if (authorization !== `Basic ${Buffer.from('drama-owner:口令', 'utf8').toString('base64')}`) {
        return Response.json({ code: 401 }, { status: 401 })
      }
      loggedIn = true
    } else {
      assert.equal(authorization, null)
      if (path.endsWith('/logout')) {
        assert.equal(options?.method, 'POST')
        loggedIn = false
        return new Response(null, { status: 204 })
      }
      assert.equal(options?.method, undefined)
    }
    return loggedIn
      ? Response.json({ code: 200, data: { username: 'drama-owner', administrator: true } })
      : Response.json({ code: 401 }, { status: 401 })
  }

  assert.equal(await readSiteAccount(), null)
  await assert.rejects(loginToSite('drama-owner', 'incorrect'), (error: unknown) => error instanceof SiteLoginError && error.status === 401)
  const owner = { username: 'drama-owner', administrator: true }
  assert.deepEqual(await loginToSite('drama-owner', '口令'), owner)
  assert.deepEqual(await readSiteAccount(), owner)
  await logoutFromSite()
  assert.equal(await readSiteAccount(), null)
  assert.deepEqual(requests.map(({ path }) => path), ['me', 'login', 'login', 'me', 'logout', 'me']
    .map(name => '/api/v1/site-session/' + name))
})
