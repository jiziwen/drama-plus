export function joinProviderUrl(baseUrl: string, requiredPrefix: string, path: string) {
  const normalizedBase = (baseUrl || '').replace(/\/+$/, '')
  const normalizedPrefix = normalizeSegment(requiredPrefix)
  const normalizedPath = normalizeSegment(path)

  if (!normalizedBase) {
    return `${normalizedPrefix}${normalizedPath}`
  }

  try {
    const url = new URL(normalizedBase)
    const currentPath = url.pathname.replace(/\/+$/, '')
    const mergedPrefix = mergeProviderPrefix(currentPath, normalizedPrefix)

    url.pathname = `${mergedPrefix}${normalizedPath}`.replace(/\/{2,}/g, '/')
    return url.toString()
  } catch {
    const basePath = mergeProviderPrefix(normalizedBase, normalizedPrefix)
    return `${basePath}${normalizedPath}`
  }
}

function mergeProviderPrefix(basePath: string, prefix: string) {
  // Agent Plan 使用独立的 /api/plan/v3；也兼容只填写 /api/plan 的配置。
  if (prefix === '/api/v3' && /\/api\/plan(?:\/v3)?$/.test(basePath)) {
    return basePath.endsWith('/v3') ? basePath : `${basePath}/v3`
  }
  return basePath.endsWith(prefix) ? basePath : `${basePath}${prefix}`
}

function normalizeSegment(segment: string) {
  if (!segment) return ''
  return segment.startsWith('/') ? segment : `/${segment}`
}
