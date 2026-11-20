import { requiresLocalSiteLogin, siteLoginPath } from '~/utils/siteSession'

export default defineNuxtRouteMiddleware(async to => {
  if (!import.meta.dev || import.meta.server || to.path === '/site-login') return
  if (await requiresLocalSiteLogin()) return navigateTo(siteLoginPath(to.fullPath), { replace: true })
})
