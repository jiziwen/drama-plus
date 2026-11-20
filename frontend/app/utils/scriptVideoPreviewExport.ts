import { buildScriptVideoDelivery, type ScriptVideoDeliveryOptions } from '../../../backend/src/services/script-video-delivery'
import {
  exportMarkdown,
  type PreviewAsset,
  type PreviewCard,
  type PreviewExportContext,
} from './scriptVideoPreview'

const encoder = new TextEncoder()
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function header(size: number, values: Array<[number, number, number]>) {
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  for (const [offset, value, length] of values) {
    if (length === 2) view.setUint16(offset, value, true)
    else view.setUint32(offset, value, true)
  }
  return bytes
}

// ZIP STORE keeps image files untouched and works without a new client dependency.
function zip(files: Array<{ name: string; bytes: Uint8Array }>) {
  const chunks: BlobPart[] = [],
    directory: BlobPart[] = []
  let offset = 0,
    directorySize = 0
  for (const file of files) {
    const name = encoder.encode(file.name),
      checksum = crc32(file.bytes)
    const local = header(30, [
      [0, 0x04034b50, 4],
      [4, 20, 2],
      [6, 0x800, 2],
      [14, checksum, 4],
      [18, file.bytes.length, 4],
      [22, file.bytes.length, 4],
      [26, name.length, 2],
    ])
    const central = header(46, [
      [0, 0x02014b50, 4],
      [4, 20, 2],
      [6, 20, 2],
      [8, 0x800, 2],
      [16, checksum, 4],
      [20, file.bytes.length, 4],
      [24, file.bytes.length, 4],
      [28, name.length, 2],
      [42, offset, 4],
    ])
    chunks.push(local, name, new Uint8Array(file.bytes).buffer)
    directory.push(central, name)
    offset += local.length + name.length + file.bytes.length
    directorySize += central.length + name.length
  }
  const end = header(22, [
    [0, 0x06054b50, 4],
    [8, files.length, 2],
    [10, files.length, 2],
    [12, directorySize, 4],
    [16, offset, 4],
  ])
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' })
}

export function downloadPreviewFile(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function assetBlob(asset: PreviewAsset, url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`参考图读取失败：${asset.name}`)
  return response.blob()
}

export function portableDeliveryCard(card: PreviewCard, assets: PreviewAsset[], options: ScriptVideoDeliveryOptions) {
  const { prompt, images, voices, imageBindings, openingFrame, lightingRanges, lightingImages } = buildScriptVideoDelivery(card, assets, options)
  const referenceVoices = voices.map(({asset, roles}) => ({ url: asset.voiceAudio!.url, assetIds: roles.map(role => role.id) }))
  const assetIds = [...new Set([...imageBindings.map(item => item.assetId), ...referenceVoices.flatMap(voice => voice.assetIds)])]
  return {
    ...card, editorPrompt: card.prompt, prompt, assetIds, imageBindings,
    referenceImages: images.map(asset => asset.id),
    referenceVoices,
    ...(lightingRanges.length && { lightingRanges }),
    ...(lightingImages.length && { lightingImages: lightingImages.map((url, i) => ({ url, file: lightingFrameFile(images.length + Number(!!openingFrame?.imageIndex) + i + 1) })) }),
    ...(openingFrame && { openingFrame: { ...openingFrame, file: openingFrameFile(openingFrame.imageIndex) } }),
  }
}

function openingFrameFile(imageIndex?: number) {
  return `${imageIndex ? `图${imageIndex}` : '首帧'}-上一段视频尾帧.jpg`
}
function lightingFrameFile(index: number) {
  return `图${index}-场景光线参考.jpg`
}

export async function exportPreviewPackage(
  cards: PreviewCard[],
  assets: PreviewAsset[],
  filename = '剧本转视频-交付.zip',
  context: PreviewExportContext = {},
) {
  const options: ScriptVideoDeliveryOptions = context.delivery || { stylePreset: context.production?.stylePreset, cast: context.production?.characters }
  const cardOptions = (card: PreviewCard): ScriptVideoDeliveryOptions => ({
    ...options, continuation: context.continuations?.[card.id] ?? options.continuation,
    lightingRanges: context.lightingRanges?.[card.id] ?? options.lightingRanges,
  })
  const files: Array<{ name: string; bytes: Uint8Array }> = [
    {
      name: '分镜脚本.md',
      bytes: encoder.encode(exportMarkdown(cards, assets, { ...context, delivery: options })),
    },
    {
      name: '分镜数据.json',
      bytes: encoder.encode(
        JSON.stringify(
          {
            workflow: 'script-to-video',
            schemaVersion: 2,
            production: context.production,
            cards: cards.map(card => portableDeliveryCard(card, assets, cardOptions(card))),
            assets: assets.map(({ image, ...asset }) => asset),
          },
          null,
          2,
        ),
      ),
    },
  ]
  for (const [cardIndex, card] of cards.entries()) {
    const folder = `片段${String(cardIndex + 1).padStart(2, '0')}`
    const delivery = buildScriptVideoDelivery(card, assets, cardOptions(card))
    files.push({
      name: `${folder}/视频提示词.txt`,
      bytes: encoder.encode(delivery.prompt),
    })
    for (const [index, asset] of delivery.images.entries()) {
      const url = context.referenceImages?.[asset.image] || asset.image
      const blob = await assetBlob(asset, url)
      const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }
      const extension = extensions[blob.type] || /\.(jpe?g|png|webp|gif|avif)$/iu.exec(url)?.[1] || 'png'
      const safeName = asset.name.replace(/[/\\:*?"<>|]/g, '-')
      files.push({
        name: `${folder}/图${index + 1}-${safeName}.${extension}`,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      })
    }
    if (delivery.openingFrame) {
      const frame = delivery.openingFrame
      const response = await fetch(frame.imageUrl)
      if (!response.ok) throw new Error('上一段视频尾帧读取失败')
      files.push({ name: `${folder}/${openingFrameFile(frame.imageIndex)}`, bytes: new Uint8Array(await response.arrayBuffer()) })
    }
    for (const [i, url] of delivery.lightingImages.entries()) {
      const response = await fetch(url)
      if (!response.ok) throw new Error('场景光线参考图读取失败')
      const index = delivery.images.length + Number(!!delivery.openingFrame?.imageIndex) + i + 1
      files.push({ name: `${folder}/${lightingFrameFile(index)}`, bytes: new Uint8Array(await response.arrayBuffer()) })
    }
    const voiceFiles = new Map<string, { file: string; roles: string[] }>()
    for (const { asset, roles } of delivery.voices) {
      if (!asset.voiceAudio) continue
      const response = await fetch(asset.voiceAudio.url)
      if (!response.ok) throw new Error(`角色声音读取失败：${asset.name}`)
      const blob = await response.blob()
      const extension = asset.voiceAudio.url.match(/\.(mp3|wav|m4a|aac)$/iu)?.[1]?.toLowerCase() || 'wav'
      const safeName = asset.name.replace(/[/\\:*?"<>|]/g, '-')
      const file = `声音${voiceFiles.size + 1}-${safeName}.${extension}`
      voiceFiles.set(asset.voiceAudio.url, { file, roles: roles.map(role => role.name) })
      files.push({ name: `${folder}/${file}`, bytes: new Uint8Array(await blob.arrayBuffer()) })
    }
    if (voiceFiles.size) files.push({ name: `${folder}/角色声音参考.txt`, bytes: encoder.encode([...voiceFiles.values()].map((item, index) => `音频${index + 1}：${item.roles.join('、')}\n文件：${item.file}`).join('\n\n')) })
  }
  downloadPreviewFile(filename, zip(files))
}
