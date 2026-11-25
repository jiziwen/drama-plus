import { fileURLToPath } from 'node:url'
import { SaxesParser } from 'saxes'
import { fromBufferPromise } from 'yauzl'
import { decodeTextFile } from './text-file.js'
import {
  CHAT_ATTACHMENT_COUNT_LIMIT,
  CHAT_ATTACHMENT_EXTENSIONS,
  CHAT_ATTACHMENT_FILE_BYTES,
  CHAT_ATTACHMENT_TOTAL_BYTES,
  chatAttachmentExtension,
} from './ai-chat-attachment-limits.js'
import type { ChatAttachment } from './ai-chat-types.js'

export type ChatAttachmentInput = ChatAttachment & { text: string }

const EXTRACTED_CHAR_LIMIT = CHAT_ATTACHMENT_TOTAL_BYTES
const WORD_XML_LIMIT = 32 * 1024 * 1024
const PDF_PAGE_LIMIT = 1500
class ChatAttachmentError extends Error {}

function collectText(limit: number) {
  const chunks: string[] = []
  let length = 0
  return {
    append(text: string) {
      if (!text) return
      length += text.length
      if (length > limit) throw new ChatAttachmentError('提取的正文过长，请拆分文件后分次发送。')
      chunks.push(text)
    },
    toString: () => chunks.join(''),
  }
}

async function readWord(bytes: ArrayBuffer, limit: number, signal: AbortSignal) {
  const zip = await fromBufferPromise(Buffer.from(bytes), { lazyEntries: true })
  try {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted()
      if (entry.fileName !== 'word/document.xml') continue
      if (entry.uncompressedSize > WORD_XML_LIMIT) throw new ChatAttachmentError('Word 正文过长，请拆分文件后分次发送。')
      const output = collectText(limit)
      const parser = new SaxesParser({ xmlns: true })
      const wordNamespaces = new Set([
        'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
        'http://purl.oclc.org/ooxml/wordprocessingml/main',
      ])
      let readingText = false
      parser.on('opentag', tag => {
        if (!wordNamespaces.has(tag.uri)) return
        if (tag.local === 't') readingText = true
        if (tag.local === 'tab') output.append('\t')
        if (tag.local === 'br' || tag.local === 'cr') output.append('\n')
      })
      parser.on('text', text => { if (readingText) output.append(text) })
      parser.on('cdata', text => { if (readingText) output.append(text) })
      parser.on('closetag', tag => {
        if (!wordNamespaces.has(tag.uri)) return
        if (tag.local === 't') readingText = false
        if (tag.local === 'p') output.append('\n')
      })
      const input = await zip.openReadStreamPromise(entry)
      input.setEncoding('utf8')
      for await (const chunk of input) {
        signal.throwIfAborted()
        parser.write(chunk)
      }
      parser.close()
      return output.toString()
    }
    throw new ChatAttachmentError('Word 文件缺少可读取的正文。')
  } finally {
    zip.close()
  }
}

async function readPdf(bytes: ArrayBuffer, limit: number, signal: AbortSignal) {
  const { getResolvedPDFJS } = await import('unpdf')
  const { getDocument } = await getResolvedPDFJS()
  signal.throwIfAborted()
  const assetDir = process.env.HUOBAO_DESKTOP === '1'
    ? new URL('./pdf-text/', import.meta.url)
    : new URL('./', import.meta.resolve('pdfjs-dist/package.json'))
  const task = getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: fileURLToPath(new URL('cmaps/', assetDir)),
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', assetDir)),
    useWorkerFetch: false,
  })
  const abort = () => { void task.destroy().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const pdf = await task.promise
    if (pdf.numPages > PDF_PAGE_LIMIT) throw new ChatAttachmentError(`PDF 超过 ${PDF_PAGE_LIMIT} 页，请拆分文件后发送。`)
    const output = collectText(limit)
    for (let number = 1; number <= pdf.numPages; number++) {
      signal.throwIfAborted()
      const page = await pdf.getPage(number)
      const items = page.streamTextContent().getReader()
      try {
        while (true) {
          const { value, done } = await items.read()
          if (done) break
          for (const item of value.items) {
            if ('str' in item) output.append(item.str + (item.hasEOL ? '\n' : ''))
          }
        }
      } finally {
        await items.cancel().catch(() => {})
        page.cleanup()
      }
      output.append('\n\n')
    }
    return output.toString()
  } finally {
    signal.removeEventListener('abort', abort)
    if (!signal.aborted) await task.destroy()
  }
}

export async function readChatAttachments(files: File[], signal: AbortSignal): Promise<ChatAttachmentInput[]> {
  if (files.length > CHAT_ATTACHMENT_COUNT_LIMIT) throw new Error('每条消息最多上传 5 个文件。')
  if (files.reduce((total, file) => total + file.size, 0) > CHAT_ATTACHMENT_TOTAL_BYTES) {
    throw new Error('每条消息的附件合计不能超过 20 MB。')
  }

  const attachments: ChatAttachmentInput[] = []
  let remaining = EXTRACTED_CHAR_LIMIT
  for (const file of files) {
    signal.throwIfAborted()
    const name = file.name.split(/[/\\]/u).at(-1)?.replace(/[\u0000-\u001f\u007f]/gu, '').trim() ?? ''
    const extension = chatAttachmentExtension(name)
    if (name.length > 255 || !CHAT_ATTACHMENT_EXTENSIONS.includes(extension)) {
      throw new Error(`不支持文件「${name.slice(0, 255)}」。请选择 TXT、MD、CSV、TSV、JSON、SRT、VTT、DOCX 或 PDF。`)
    }
    if (file.size > CHAT_ATTACHMENT_FILE_BYTES) throw new Error(`「${name}」超过 10 MB，请拆分后发送。`)

    let text: string
    try {
      const bytes = await file.arrayBuffer()
      if (extension === 'docx') text = await readWord(bytes, remaining, signal)
      else if (extension === 'pdf') text = await readPdf(bytes, remaining, signal)
      else text = decodeTextFile(new Uint8Array(bytes))
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ChatAttachmentError) throw new Error(`「${name}」${error.message}`)
      throw new Error(`无法读取「${name}」，请检查文件格式、编码或是否加密。`)
    }
    text = text.trim()
    if (!text || text.includes('\0')) {
      const hint = extension === 'pdf' ? '。如果是扫描件，请先执行 OCR 或导出为 TXT' : ''
      throw new Error(`「${name}」没有可读取的文字${hint}。`)
    }
    remaining -= text.length
    if (remaining < 0) throw new Error('提取的正文过长，请拆分文件后分次发送。')
    attachments.push({ name, size: file.size, text })
  }
  return attachments
}
