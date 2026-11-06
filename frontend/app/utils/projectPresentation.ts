/** Presentation derived from persisted project assets; never invent production progress. */
export function projectCover(project: any): string {
  const assets = [...(project.characters || []), ...(project.scenes || []), ...(project.props || [])]
  const asset = assets.find(item => item.image_url || item.imageUrl || item.local_path || item.localPath)
  const source = asset?.image_url || asset?.imageUrl || asset?.local_path || asset?.localPath || ''
  return source && !source.startsWith('/') && !/^https?:\/\//i.test(source) ? `/${source}` : source
}

export function projectCounts(projects: any[]) {
  return [projects.length,
    projects.reduce((n, p) => n + (p.episodes?.length || 0), 0),
    projects.reduce((n, p) => n + (p.characters?.length || 0), 0),
    projects.reduce((n, p) => n + (p.scenes?.length || 0), 0)]
}
