import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_ROOT } from '../utils/paths.js'

export type VideoCliAccountProvider = 'jimeng' | 'libtv'
export interface VideoCliAccountEntry { id: string; name: string }
interface StoredAccountEntry extends VideoCliAccountEntry { autoNamed?: boolean }
interface Registry { accounts: StoredAccountEntry[]; activeAccountId?: string }

export class VideoCliAccountError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); this.name = 'VideoCliAccountError' }
}

function directory() { return path.resolve(process.env.VIDEO_CLI_ACCOUNTS_DIR || path.join(DATA_ROOT, 'video-accounts')) }
function filename(provider: VideoCliAccountProvider) { return path.join(directory(), `${provider}.json`) }
function validId(id: string) { return id === 'default' || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(id) }

function read(provider: VideoCliAccountProvider): Registry {
  const file = filename(provider)
  if (!existsSync(file)) return { accounts: [{ id: 'default', name: '默认账号', autoNamed: true }], activeAccountId: 'default' }
  const data = JSON.parse(readFileSync(file, 'utf8')) as Registry
  if (!Array.isArray(data.accounts) || data.accounts.some(account => !validId(account.id) || typeof account.name !== 'string')) {
    throw new Error('视频账号配置无法读取，请检查账号数据文件')
  }
  return data
}

function save(provider: VideoCliAccountProvider, data: Registry) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  const file = filename(provider)
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 })
  renameSync(temporary, file)
}

function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) throw new VideoCliAccountError('账号名称需为 1–80 个字符')
  return value.trim()
}

export function listVideoCliAccounts(provider: VideoCliAccountProvider): VideoCliAccountEntry[] { return read(provider).accounts.map(({ id, name }) => ({ id, name })) }
export function getActiveVideoCliAccountId(provider: VideoCliAccountProvider): string {
  const data = read(provider)
  return data.accounts.find(account => account.id === data.activeAccountId)?.id || data.accounts[0]?.id || 'default'
}
export function resolveVideoCliAccountId(provider: VideoCliAccountProvider, id?: string): string {
  const accountId = id ?? getActiveVideoCliAccountId(provider)
  if (!validId(accountId) || !read(provider).accounts.some(account => account.id === accountId)) throw new VideoCliAccountError('所选视频账号不存在，请重新选择或添加账号', 404)
  return accountId
}
export function createVideoCliAccount(provider: VideoCliAccountProvider, accountName?: string): VideoCliAccountEntry {
  const data = read(provider)
  if (data.accounts.length >= 100) throw new VideoCliAccountError('最多可添加 100 个账号，请先移除不再使用的账号')
  const entry = { id: randomUUID(), name: name(accountName ?? `账号 ${data.accounts.length + 1}`), autoNamed: accountName === undefined }
  data.accounts.push(entry)
  data.activeAccountId ??= entry.id
  save(provider, data)
  return { id: entry.id, name: entry.name }
}
export function setActiveVideoCliAccount(provider: VideoCliAccountProvider, id: string) {
  resolveVideoCliAccountId(provider, id)
  const data = read(provider)
  data.activeAccountId = id
  save(provider, data)
}
export function renameVideoCliAccount(provider: VideoCliAccountProvider, id: string, accountName: string) {
  resolveVideoCliAccountId(provider, id)
  const data = read(provider)
  const entry = data.accounts.find(account => account.id === id)!
  entry.name = name(accountName)
  entry.autoNamed = false
  save(provider, data)
  return { id: entry.id, name: entry.name }
}

/** Use the official display name until the user explicitly writes a personal label. */
export function updateVideoCliAccountNameFromPlatform(provider: VideoCliAccountProvider, id: string, username: string | undefined) {
  const nextName = username?.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, 80)
  if (!nextName) return
  const data = read(provider)
  const entry = data.accounts.find(account => account.id === id)
  // A completed stale probe must not recreate an account removed in the meantime.
  if (!entry) return
  const legacyDefault = entry.autoNamed === undefined && entry.id === 'default' && entry.name === '默认账号'
  if (entry.autoNamed !== true && !legacyDefault || entry.name === nextName) return
  entry.name = nextName
  entry.autoNamed = true
  save(provider, data)
}
export function removeVideoCliAccount(provider: VideoCliAccountProvider, id: string) {
  resolveVideoCliAccountId(provider, id)
  const data = read(provider)
  data.accounts = data.accounts.filter(account => account.id !== id)
  if (data.activeAccountId === id) data.activeAccountId = data.accounts[0]?.id
  save(provider, data)
}
export function videoCliAccountDirectory(provider: VideoCliAccountProvider, id: string): string | undefined {
  resolveVideoCliAccountId(provider, id)
  if (id === 'default') return undefined
  const folder = path.join(directory(), provider, id)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  return folder
}
