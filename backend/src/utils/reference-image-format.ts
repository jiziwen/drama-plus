import sharp from 'sharp'

const extensions: Readonly<Record<string, string>> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  gif: '.gif',
  avif: '.avif',
}

/** Correct recognized image formats without decoding or changing the pixels. */
export async function matchReferenceImageExtension(file: string, extension: string): Promise<string> {
  const metadata = await sharp(file).metadata().catch(() => undefined)
  return imageExtensionFromMetadata(metadata, extension)
}

export function imageExtensionFromMetadata(metadata: sharp.Metadata | undefined, extension: string): string {
  if (!metadata?.format) return extension
  if (metadata.format === 'heif') {
    if (metadata.compression === 'av1') return '.avif'
    if (metadata.compression === 'hevc') return extension === '.heif' ? '.heif' : '.heic'
  }
  if (metadata.format === 'jpeg' && extension === '.jpeg') return extension
  return extensions[metadata.format] ?? extension
}
