/** Both layouts operate on the same project pages, settings and API. */
export function useStudioInterface() {
  const route = useRoute()
  const isCinematic = computed(() => route.query.interface === 'cinematic')
  function interfaceLink(path: string) {
    const url = new URL(path, 'http://studio.local')
    url.searchParams.delete('preview')
    url.searchParams.set('interface', 'cinematic')
    return `${url.pathname}${url.search}${url.hash}`
  }
  function interfaceTarget(mode: 'cinematic' | 'classic') {
    const { preview: _legacy, ...query } = route.query
    return { path: route.path, query: { ...query, interface: mode }, hash: route.hash }
  }
  return { isCinematic, interfaceLink, interfaceTarget }
}
