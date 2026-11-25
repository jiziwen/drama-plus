export const CHAT_ATTACHMENT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'srt', 'vtt', 'docx', 'pdf']
export const CHAT_ATTACHMENT_COUNT_LIMIT = 5
export const CHAT_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024
export const CHAT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024

export function chatAttachmentExtension(name: string) {
  return /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase() ?? ''
}
