/** Default to the director interface and remember an explicit switch on this device. */
export default defineNuxtRouteMiddleware((to, from) => {
  const internalWorkspace = to.path === '/' || to.path === '/assets' || to.path === '/settings' || /^\/drama\/[^/]+(?:\/episode\/[^/]+)?\/?$/.test(to.path)
  if (!internalWorkspace) return
  const validMode = (value: unknown) => value === 'cinematic' || value === 'classic'
  const key = 'xiaoli:interface-mode'
  let stored: string | null = null
  try { stored = localStorage.getItem(key) } catch { /* URLs still work when storage is unavailable. */ }
  const explicit = validMode(to.query.interface) ? to.query.interface : validMode(to.query.preview) ? to.query.preview : null
  const previous = validMode(from.query.interface) ? from.query.interface : validMode(from.query.preview) ? from.query.preview : null
  const mode = explicit || previous || (validMode(stored) ? stored : 'cinematic')
  if (explicit) {
    try { localStorage.setItem(key, String(explicit)) } catch { /* Keep the selected mode in the URL. */ }
  }
  if (to.query.interface === mode && to.query.preview == null) return
  const { preview: _legacy, ...query } = to.query
  return navigateTo({ path: to.path, query: { ...query, interface: mode }, hash: to.hash }, { replace: true })
})
