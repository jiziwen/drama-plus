/** Presentation derived from persisted project assets; never invent production progress. */
export function projectCover(project: any): string {
  return projectGalleryImages(project)[0]?.src || ''
}

/** Scene images first, then characters; duplicate file URLs and props never enter the gallery. */
export function projectGalleryImages(project: any) {
  const seen = new Set<string>()
  const result: { id: string; src: string; name: string; kind: string }[] = []
  for (const [key, kind] of [['scenes', '场景'], ['characters', '角色']]) {
    for (const [index, item] of (project[key] || []).entries()) {
      const source = item.image_url || item.imageUrl || item.local_path || item.localPath
      if (!source) continue
      try {
        const url = new URL(source, typeof location === 'undefined' ? 'http://studio.local' : location.origin)
        if (!['http:', 'https:'].includes(url.protocol)) continue
        const identity = url.origin + url.pathname
        if (seen.has(identity)) continue
        seen.add(identity)
        result.push({ id: `${key}-${item.id ?? index}`, src: /^https?:\/\//i.test(source) ? source : `${url.pathname}${url.search}`, name: item.location || item.name || kind, kind })
      } catch { /* A malformed asset does not prevent showing other project images. */ }
    }
  }
  return result
}

export function projectCounts(projects: any[]) {
  return [projects.length,
    projects.reduce((n, p) => n + (p.episodes?.length || 0), 0),
    projects.reduce((n, p) => n + (p.characters?.length || 0), 0),
    projects.reduce((n, p) => n + (p.scenes?.length || 0), 0)]
}
