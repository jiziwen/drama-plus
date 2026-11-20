import { logoutFromSite, readSiteAccount, siteLoginPath, type SiteAccount } from '~/utils/siteSession'

export function useSiteSession() {
  const account = useState<SiteAccount | null>('verified-site-account', () => null)

  async function refresh() {
    account.value = await readSiteAccount()
  }

  async function leave(next?: unknown) {
    await logoutFromSite()
    account.value = null
    window.location.replace(siteLoginPath(next))
  }

  return { account, refresh, leave }
}
