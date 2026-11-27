/**
 * 媒体地址辅助 — 列表/卡片用缩略图与海报帧，大图预览仍用原图
 *
 * 命名约定（后端生成产物时自动产出，见 backend/src/utils/storage.ts、video-poster.ts）：
 *   图片 static/images/x.png      → 缩略图 static/images/x_thumb.webp
 *   视频 static/videos|merged/x.mp4 → 海报帧 static/videos|merged/x_poster.jpg
 * 历史图片首次请求时会自动补齐缩略图。
 */

/** Resolve thumbnails for images in local storage, including same-origin absolute URLs. */
export function thumbOf(url: string): string {
  if (!url) return url
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  try {
    const source = new URL(url, origin)
    if (source.origin !== origin) return url
    const decoded = decodeURIComponent(source.pathname)
    if (!decoded.startsWith('/static/') || /_thumb\.webp$/iu.test(decoded) ||
        !/\.(?:avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/iu.test(decoded)) return url
    return '/api/v1/storage/thumbnail?path=' + encodeURIComponent(decoded.slice(1))
  } catch {
    return url
  }
}

/** 视频地址 → 海报帧地址；无法推导（远程 URL 等）时返回空串，不设置 poster */
export function posterOf(url: string): string {
  if (!url || !url.includes('/static/')) return ''
  if (!/\.(mp4|webm|mov)$/i.test(url)) return ''
  return url.replace(/\.[^./]+$/, '_poster.jpg')
}

/** 按需补齐旧视频封面；版本随主视频变化，URL 不携带远程地址或签名。 */
export function videoPosterSrc(kind: 'tasks' | 'storyboards', id: number | string, source: string): string {
  if (!source) return ''
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return posterOf(source)
  let version = 0
  for (const char of source) version = (Math.imul(version, 31) + char.charCodeAt(0)) >>> 0
  return `/api/v1/${kind}/${id}/poster?v=${version.toString(36)}`
}
