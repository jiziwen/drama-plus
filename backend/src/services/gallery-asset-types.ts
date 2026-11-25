export const GALLERY_ASSET_KINDS = ['characters', 'scenes', 'props'] as const
export const GALLERY_IMAGE_ASPECTS = ['9:16', '16:9', '1:1'] as const

export type GalleryAssetKind = typeof GALLERY_ASSET_KINDS[number]
export type GalleryImageAspect = typeof GALLERY_IMAGE_ASPECTS[number]

export const GALLERY_IMAGE_SIZES: Record<GalleryImageAspect, string> = {
  '9:16': '1152x2048',
  '16:9': '2048x1152',
  '1:1': '1536x1536',
}

export const isGalleryImageAspect = (value: unknown): value is GalleryImageAspect =>
  GALLERY_IMAGE_ASPECTS.some(aspect => aspect === value)

export type GalleryImageRequest = {
  prompt: string
  aspect: GalleryImageAspect
  model: string
  configId: number
}

export type GalleryAsset = {
  id: number
  kind: GalleryAssetKind
  name: string
  description: string
  prompt: string
  image: string | null
  model: string | null
  configId: number | null
  aspect: GalleryImageAspect | null
  task: { id: number; status: string | null; error: string | null } | null
}
