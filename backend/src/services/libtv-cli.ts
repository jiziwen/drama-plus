import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { getActiveVideoCliAccountId, resolveVideoCliAccountId, updateVideoCliAccountNameFromPlatform, videoCliAccountDirectory } from './video-cli-accounts.js'
import { videoCliFailure } from './video-cli-errors.js'
import { libtvWebAssistant } from './libtv-web-assistant.js'
import { STORAGE_ROOT } from '../utils/paths.js'
import type { GenerateVideoParams } from './generation.js'
import { libtvVideoModel, LIBTV_SEEDANCE_20_MINI_MODEL, LIBTV_VIDEO_RATIOS } from './libtv-video-models.js'
import { activeLibTVCanvas, configuredLibTVCanvas, ensureLibTVCanvas, libtvAccountIdentifier, libtvProjectIdPattern as availableProject } from './libtv-project.js'
import { whileVideoCliDisconnecting } from './video-cli-tasks.js'

type CliObject = Record<string, unknown>
const asObject = (value: unknown): CliObject | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as CliObject : undefined

export class LibTVCliError extends Error {
  constructor(message: string, readonly terminal = false,
    readonly reason?: 'unavailable' | 'auth_required' | 'timeout' | 'account_busy') { super(message) }
}

const usableNodeKey = /^[\w][\w.-]{0,127}$/u
const runtimeEnv = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'PATH', 'TMPDIR', 'TEMP', 'TMP',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'LANG', 'LC_ALL', 'LIBTV_CONFIG_DIR',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']

export async function libtvProjectId() {
  const configured = configuredLibTVCanvas()
  if (configured) return configured.id
  const accountId = await getLibTVAuthenticatedAccountId()
  const canvas = activeLibTVCanvas(accountId)
  if (!canvas) throw new LibTVCliError('请在「设置 → AI 服务」连接 LibTV 并等待画布准备完成')
  return canvas.id
}

function outputObject(stdout: string) {
  try { return asObject(JSON.parse(stdout)) } catch {}
  // Piped CLI output can use NDJSON. A single node command has one final result.
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = asObject(JSON.parse(line))
      if (value) return value
    } catch {}
  }
}

function libtvRuntime() {
  const executable = process.env.LIBTV_CLI_BIN?.trim() || path.join(homedir(), '.libtv', process.platform === 'win32' ? 'libtv.exe' : 'libtv')
  if (!path.isAbsolute(executable)) throw new LibTVCliError('LIBTV_CLI_BIN 必须是 LibTV 官方 CLI 的绝对路径', false, 'unavailable')
  // Keep credentials isolated per saved account; the default slot preserves existing CLI login.
  const env: NodeJS.ProcessEnv = { LIBTV_DEBUG: '0' }
  for (const key of runtimeEnv) if (process.env[key] !== undefined) env[key] = process.env[key]
  const directory = videoCliAccountDirectory('libtv', currentProfileId())
  if (directory) { mkdirSync(directory, { recursive: true, mode: 0o700 }); env.LIBTV_CONFIG_DIR = directory }
  return { executable, options: { env, cwd: path.dirname(executable), windowsHide: true } }
}

export const LIBTV_GENERATION_TIMEOUT_MS = 12 * 60_000

export async function runLibTVCli(args: readonly string[], generation = false, timeout = generation ? LIBTV_GENERATION_TIMEOUT_MS : 120_000): Promise<CliObject> {
  const { executable, options } = libtvRuntime()
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      ...options, maxBuffer: 4 * 1024 * 1024,
      // CLI waits for terminal status itself; a stuck process must still release our worker.
      timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, LIBTV_GENERATION_TIMEOUT_MS) : LIBTV_GENERATION_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      const output = outputObject(stdout)
      if (output && [3, 4].includes(Number(output.status))) {
        return reject(new LibTVCliError(videoCliFailure('libtv', { ...output, ...asObject(asObject(output.data)?.taskInfo) }, 'LibTV 已确认视频任务失败'), true))
      }
      if (!error && output && output.ok !== false && output.success !== false && !output.error &&
          (output.code === undefined || String(output.code) === '0')) return resolve(output)
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        return reject(new LibTVCliError('服务端尚未安装可执行的 LibTV 官方 CLI', false, 'unavailable'))
      }
      if (/未登录|登录已过期|登录失效|\[401\]/u.test(stderr)) {
        return reject(new LibTVCliError('请先授权 LibTV 账号', false, 'auth_required'))
      }
      if (error?.killed) return reject(new LibTVCliError('等待 LibTV 官方 CLI 响应超时', false, 'timeout'))
      // Raw stderr and child-process error messages can include arguments or credentials.
      return reject(new LibTVCliError(videoCliFailure('libtv', output ?? stderr, generation ? 'LibTV 未返回可确认的生成结果' : 'LibTV 官方 CLI 调用失败，请检查服务端登录与画布权限')))
    })
    child.stdin?.end()
  })
}

export async function checkLibTVConnection() {
  await runLibTVCli(['project', await libtvProjectId()])
}

/** Verify the current account's live official model schema before creating a voice video. */
export async function libtvHasSeedance20Mini(seconds: number, size: string): Promise<boolean> {
  const result = await runLibTVCli(['model', LIBTV_SEEDANCE_20_MINI_MODEL])
  const schema = asObject(result.schema)
  const properties = asObject(schema?.properties)
  const resolution = asObject(properties?.resolution)
  const duration = asObject(properties?.duration)
  const sound = asObject(properties?.enableSound)
  const config = asObject(schema?.config)
  const types = asObject(config?.generateTypes)
  const rules = Array.isArray(schema?.rules) ? schema.rules : []
  const enumHas = (value: unknown, expected: string) => Array.isArray(value) && value.some(item =>
    item === expected || asObject(item)?.value === expected)
  return result.modelKey === LIBTV_SEEDANCE_20_MINI_MODEL && result.modality === 'video' &&
    schema?.modelKey === LIBTV_SEEDANCE_20_MINI_MODEL &&
    enumHas(resolution?.enum, size) && enumHas(sound?.enum, 'on') &&
    typeof duration?.min === 'number' && duration.min <= seconds &&
    typeof duration?.max === 'number' && duration.max >= seconds &&
    typeof duration?.step === 'number' && duration.step > 0 &&
    Number.isInteger((seconds - duration.min) / duration.step) &&
    typeof types?.text === 'number' && rules.some(rule => {
      const value = asObject(rule)
      return Array.isArray(value?.forModeTypes) && value.forModeTypes.includes('text2video') &&
        Array.isArray(value.require) && value.require.includes('prompt')
    })
}

type LibTVAuthStatus = 'unauthenticated' | 'authenticated' | 'pending' | 'expired' | 'failed' | 'unavailable'
export type LibTVAccount = {
  available: boolean
  authenticated: boolean
  status: LibTVAuthStatus
  accountId?: string
  canvas_ready: boolean
  canvas_preparing?: boolean
  canvas_name?: string
  username?: string
  message?: string
  expires_at?: number
  verification_url?: string
  assistant_download_url?: string
  login_method?: 'local_helper'
}

type LoginFailure = { status: 'expired' | 'failed' | 'unavailable'; message: string }
type LocalLogin = { expiresAt: number; scope: string; relayState?: string; assistantDownloadUrl?: string; verification?: string; closed: Promise<void>; cancel: () => void; expire: () => void; stopping?: boolean }
type AuthorizationOptions = { scope?: string; helperOrigin?: string }
type WebRelay = { expiresAt: number; callback: string; login: LocalLogin }
const webRelays = new Map<string, WebRelay>()
const LOGIN_START_MS = 8_000
const LOGIN_LIFETIME_MS = 5 * 60_000
const ACCOUNT_TIMEOUT_MS = 8_000
const SMS_COOLDOWN_MS = 60_000
const SMS_ATTEMPT_LIMIT = 5
type PhoneChallenge = { id: string; scope: string; phone: string; expiresAt: number; attempts: number }
type AccountSession = {
  authenticated?: boolean
  phoneChallenge?: PhoneChallenge
  phoneStepInFlight: boolean
  nextPhoneSendAt: number
  localLogin?: LocalLogin
  authStart?: Promise<LibTVAccount>
  authStartScope?: string
  disconnectRequest?: Promise<void>
  accountProbe?: Promise<LibTVAccount>
  lastLoginFailure?: LoginFailure
  canvasSetup?: { expiresAt: number }
  canvasSetupFailure?: { accountId: string; message: string }
}
const accountContext = new AsyncLocalStorage<string>()
const accountSessions = new Map<string, AccountSession>()
export const getActiveLibTVAccountId = () => getActiveVideoCliAccountId('libtv')
export function withLibTVAccount<T>(id: string, action: () => T): T {
  return accountContext.run(resolveVideoCliAccountId('libtv', id), action)
}
function currentProfileId() { return accountContext.getStore() ?? getActiveLibTVAccountId() }
function session() {
  const id = currentProfileId()
  let state = accountSessions.get(id)
  if (!state) {
    state = { phoneStepInFlight: false, nextPhoneSendAt: 0 }
    accountSessions.set(id, state)
  }
  return state
}

function pendingAccount(login: LocalLogin, includeVerification = false): LibTVAccount {
  return { available: true, authenticated: false, status: 'pending', canvas_ready: false,
    expires_at: login.expiresAt, ...(includeVerification && (login.assistantDownloadUrl
      ? { assistant_download_url: login.assistantDownloadUrl, login_method: 'local_helper' as const }
      : { verification_url: login.verification })) }
}

function loginError(status: LoginFailure['status'], message: string): LibTVAccount {
  return { status, available: status !== 'unavailable', authenticated: false, canvas_ready: false, message }
}

function localVerificationUrl(line: string, login: LocalLogin, authorization: AuthorizationOptions) {
  const candidate = line.match(/https:\/\/www\.liblib\.tv\/zh\?[^\s<>"']+/u)?.[0]
  if (!candidate) return
  try {
    const url = new URL(candidate)
    if (url.origin !== 'https://www.liblib.tv' || url.pathname !== '/zh' || url.username || url.password ||
        url.hash || [...url.searchParams.keys()].length !== 1) return
    const callbackUrl = url.searchParams.get('callback_url') || ''
    const callback = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/callback$/u.exec(callbackUrl)
    if (!callback || Number(callback[1]) < 1024 || Number(callback[1]) > 65_535) return
    if (authorization.helperOrigin) {
      const origin = new URL(authorization.helperOrigin)
      if (origin.protocol !== 'https:' || origin.search || origin.hash || origin.username || origin.password || origin.pathname !== '/') return
      const state = randomUUID()
      const download = new URL('/api/v1/libtv/auth/assistant', origin)
      download.searchParams.set('state', state)
      download.searchParams.set('accountId', currentProfileId())
      login.relayState = state
      login.assistantDownloadUrl = download.href
      webRelays.set(state, { expiresAt: login.expiresAt, callback: callbackUrl, login })
      return url.href
    }
    // Preserve the official CLI protocol. expires_at opts into a separate website
    // profile check that can silently stall; the CLI validates every credential.
    return url.href
  } catch {}
}

export function getLibTVWebAssistant(state: string, scope: string) {
  const relay = webRelays.get(state)
  if (!relay || relay.login.scope !== scope || Date.now() >= relay.expiresAt || relay.login.stopping || !relay.login.assistantDownloadUrl) {
    throw new LibTVPhoneAuthorizationError('本机授权助手已失效，请返回设置重新连接。', 410)
  }
  return libtvWebAssistant({ state, expiresAt: relay.expiresAt,
    callbackUrl: new URL('/api/v1/libtv/auth/callback', relay.login.assistantDownloadUrl).href })
}

/** Receive the official website redirect and deliver it only to the CLI that issued this challenge. */
export async function completeLibTVWebAuthorization(state: string, token: string) {
  const relay = webRelays.get(state)
  if (!relay || Date.now() >= relay.expiresAt || relay.login.stopping) {
    if (relay) webRelays.delete(state)
    return { ok: false, message: 'LibTV 网页授权已过期或已使用，请返回设置重新连接。' }
  }
  if (!token || token.length > 16_384 || /[\u0000-\u0020\u007f]/u.test(token)) {
    return { ok: false, message: 'LibTV 没有返回有效授权信息，请返回设置重新连接。' }
  }
  // Consume before network I/O: duplicate redirects cannot replay credentials or switch accounts.
  webRelays.delete(state)
  try {
    const callback = new URL(relay.callback)
    callback.searchParams.set('token', token)
    const response = await fetch(callback, { redirect: 'error', signal: AbortSignal.timeout(22_000) })
    await response.body?.cancel()
    if (!response.ok) return { ok: false, message: 'LibTV 未接受本次网页登录，请返回设置查看原因并重新连接。' }
    return { ok: true, message: 'LibTV 授权已完成，请返回应用点击「刷新账号与画布」。' }
  } catch {
    return { ok: false, message: '无法完成 LibTV 网页授权回调，请返回设置重新连接。' }
  }
}

function loginFailureMessage(line: string) {
  if (/token 无效或无法拉取用户信息|接口错误\s*\[401\]|登录已过期/u.test(line)) {
    return 'LibTV 未接受本次网页登录。请在 LibTV 官网退出并重新登录，再回这里连接。'
  }
  if (/\b(?:EACCES|EPERM|EROFS|ENOSPC|EISDIR|ENOTDIR)\b/u.test(line)) {
    return 'LibTV 登录凭据无法写入，请检查服务端的 LibTV 凭据目录权限和剩余空间。'
  }
  if (/\b(?:AbortError|TimeoutError|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND)\b|fetch failed/u.test(line)) {
    return 'LibTV 登录校验时连接失败，请稍后重新发起授权。'
  }
  const fallback = 'LibTV 网页授权未完成，请重新发起授权'
  const detail = videoCliFailure('libtv', line, fallback)
  if (detail !== fallback) return detail
}

async function inspectAuthenticatedAccount() {
  const profileId = currentProfileId()
  const account = await runLibTVCli(['account', 'info'], false, ACCOUNT_TIMEOUT_MS)
  const accountId = libtvAccountIdentifier(account)
  if (!accountId) throw new LibTVCliError('LibTV 未返回可识别的账号信息，请确认使用官方 CLI 或重新登录')
  const nickname = asObject(account.user)?.nickname
  const username = typeof nickname === 'string' && nickname.trim() ? nickname.trim().slice(0, 120) : undefined
  session().authenticated = true
  updateVideoCliAccountNameFromPlatform('libtv', profileId, username)
  return { accountId, username }
}

export async function getLibTVAuthenticatedAccountId(): Promise<string> {
  return (await inspectAuthenticatedAccount()).accountId
}

async function probeLibTVAccount(): Promise<LibTVAccount> {
  const state = session()
  try {
    const { accountId, username } = await inspectAuthenticatedAccount()
    state.lastLoginFailure = undefined
    return { available: true, authenticated: true, accountId, username, status: 'authenticated', canvas_ready: false }
  } catch (error) {
    if (!(error instanceof LibTVCliError)) return loginError('failed', '无法检查 LibTV 登录状态')
    if (error.reason === 'auth_required') {
      return state.lastLoginFailure ? loginError(state.lastLoginFailure.status, state.lastLoginFailure.message)
        : { available: true, authenticated: false, status: 'unauthenticated', canvas_ready: false }
    }
    return loginError(error.reason === 'unavailable' ? 'unavailable' : 'failed',
      error.message)
  }
}

function readLibTVAccount(): Promise<LibTVAccount> {
  const state = session()
  state.accountProbe ??= probeLibTVAccount().finally(() => { state.accountProbe = undefined })
  return state.accountProbe
}

async function checkAccountCanvas(account: LibTVAccount, provision: boolean): Promise<LibTVAccount> {
  const state = session()
  if (!account.accountId) return account
  try {
    const canvas = provision ? await ensureLibTVCanvas(account.accountId, runLibTVCli)
      : activeLibTVCanvas(account.accountId)
    if (!canvas) return { ...account, message: state.canvasSetupFailure?.accountId === account.accountId
      ? state.canvasSetupFailure.message : 'LibTV 已授权，请在设置中准备视频画布' }
    const summary = await runLibTVCli(['project', canvas.id], false, ACCOUNT_TIMEOUT_MS)
    const name = canvas.name ?? summary.name ?? summary.projectName ?? summary.title
    if (state.canvasSetupFailure?.accountId === account.accountId) state.canvasSetupFailure = undefined
    return { ...account, canvas_ready: true,
      ...(typeof name === 'string' && name.trim() && { canvas_name: name.trim().slice(0, 120) }) }
  } catch (error) {
    const message = error instanceof LibTVCliError
      ? error.message : '无法准备 LibTV 画布，请检查服务器配置后重试'
    if (provision) state.canvasSetupFailure = { accountId: account.accountId, message }
    return { ...account, message }
  }
}

function pendingCanvasSetup(setup: { expiresAt: number }): LibTVAccount {
  return { available: true, authenticated: false, status: 'pending', canvas_ready: false, canvas_preparing: true,
    expires_at: setup.expiresAt, message: '正在准备 LibTV 画布…' }
}

function startCanvasSetup(account?: LibTVAccount): LibTVAccount {
  const state = session()
  if (state.canvasSetup) return pendingCanvasSetup(state.canvasSetup)
  const setup = { expiresAt: Date.now() + 150_000 }
  state.canvasSetup = setup
  void (async () => checkAccountCanvas(account ?? await readLibTVAccount(), true))()
    .finally(() => { if (state.canvasSetup === setup) state.canvasSetup = undefined })
  return pendingCanvasSetup(setup)
}

export async function getLibTVAccount(includeVerification = false, scope = 'local'): Promise<LibTVAccount> {
  const state = session()
  if (state.disconnectRequest) await state.disconnectRequest.catch(() => {})
  if (expireLocalLibTVLogin(state)) return loginError('expired', 'LibTV 授权已过期，请重新发起授权')
  if (state.localLogin && !state.localLogin.stopping) return pendingAccount(state.localLogin, state.localLogin.scope === scope && (includeVerification || !!state.localLogin.assistantDownloadUrl))
  if (state.canvasSetup) return pendingCanvasSetup(state.canvasSetup)
  return checkAccountCanvas(await readLibTVAccount(), false)
}

function expireLocalLibTVLogin(state: AccountSession): LocalLogin | undefined {
  const login = state.localLogin
  if (login && !login.stopping && Date.now() >= login.expiresAt) {
    login.expire()
    return login
  }
}

function launchLocalLibTVLogin(authorization: AuthorizationOptions): Promise<LibTVAccount> {
  const state = session()
  const { executable, options } = libtvRuntime()
  return new Promise(resolve => {
    const child = spawn(executable, ['login', 'web'], { ...options, stdio: ['ignore', 'ignore', 'pipe'] })
    let closed!: () => void
    const login: LocalLogin = {
      expiresAt: Date.now() + LOGIN_LIFETIME_MS,
      scope: authorization.scope ?? 'local',
      closed: new Promise<void>(resolve => { closed = resolve }),
      cancel: () => stop('failed', 'LibTV 授权已取消'),
      expire: () => stop('expired', 'LibTV 授权已过期，请重新发起授权'),
    }
    state.localLogin = login
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let buffer = ''
    let failureMessage: string | undefined
    const startTimer = setTimeout(() => stop('failed', 'LibTV 未及时返回有效的官方网页授权链接，请重试'), LOGIN_START_MS)
    const expiryTimer = setTimeout(() => stop('expired', 'LibTV 授权已过期，请重新发起授权'), LOGIN_LIFETIME_MS)
    function finish(status: LoginFailure['status'], message: string) {
      state.lastLoginFailure = { status, message }
      resolve(loginError(status, message))
    }
    function stop(status: LoginFailure['status'], message: string) {
      if (login.stopping) return
      login.stopping = true
      clearTimeout(startTimer)
      clearTimeout(expiryTimer)
      if (login.relayState) webRelays.delete(login.relayState)
      child.kill('SIGTERM')
      forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000)
      finish(status, message)
    }
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (login.stopping) return
      // Only accept a complete line, so output split inside a query cannot publish a partial URL.
      const lines = (buffer + chunk).split(/\r?\n/u)
      buffer = lines.pop()!.slice(-8_192)
      for (const line of lines) {
        failureMessage ??= loginFailureMessage(line)
        if (login.verification || login.assistantDownloadUrl) {
          continue
        }
        const verification = localVerificationUrl(line, login, authorization)
        if (!verification) continue
        if (!login.assistantDownloadUrl) login.verification = verification
        clearTimeout(startTimer)
        resolve(pendingAccount(login, true))
      }
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      stop(error.code === 'ENOENT' || error.code === 'EACCES' ? 'unavailable' : 'failed', '无法运行 LibTV 官方 CLI 登录')
    })
    child.once('close', code => {
      clearTimeout(startTimer)
      clearTimeout(expiryTimer)
      clearTimeout(forceKill)
      if (login.relayState) webRelays.delete(login.relayState)
      if (state.localLogin === login) state.localLogin = undefined
      closed()
      if (login.stopping || state.disconnectRequest) return
      if (code === 0) {
        state.lastLoginFailure = undefined
        resolve(startCanvasSetup())
      } else {
        finish('failed', failureMessage ?? loginFailureMessage(buffer) ?? 'LibTV 网页授权未完成，请重新发起授权')
      }
    })
  })
}

export function startLibTVAuthorization(authorization: AuthorizationOptions = {}): Promise<LibTVAccount> {
  const state = session()
  if (state.disconnectRequest) return Promise.resolve(loginError('failed', 'LibTV 正在断开账号，请稍后重试'))
  const expired = expireLocalLibTVLogin(state)
  if (expired) return expired.closed.then(() => startLibTVAuthorization(authorization))
  if (state.localLogin && !state.localLogin.stopping && state.localLogin.scope !== (authorization.scope ?? 'local')) {
    return Promise.resolve(loginError('failed', '另一浏览器正在连接此 LibTV 账号，请等待完成或添加其他账号。'))
  }
  if (state.authStart) return state.authStartScope === (authorization.scope ?? 'local') ? state.authStart
    : Promise.resolve(loginError('failed', '另一浏览器正在连接此 LibTV 账号，请等待完成或添加其他账号。'))
  if ((state.localLogin?.verification || state.localLogin?.assistantDownloadUrl) && !state.localLogin.stopping) return Promise.resolve(pendingAccount(state.localLogin, true))
  if (state.canvasSetup) return Promise.resolve(pendingCanvasSetup(state.canvasSetup))
  if (state.phoneStepInFlight || state.phoneChallenge) {
    return Promise.resolve(loginError('failed', '服务器正在进行 LibTV 手机号授权，请等待授权结束后再试。'))
  }
  state.authStartScope = authorization.scope ?? 'local'
  state.authStart = (async () => {
    if (state.localLogin?.stopping) await state.localLogin.closed
    const account = await getLibTVAccount()
    if (!account.available || account.canvas_ready || account.status === 'pending') return account
    if (account.authenticated) return startCanvasSetup(account)
    state.lastLoginFailure = undefined
    return launchLocalLibTVLogin(authorization)
  })().finally(() => { state.authStart = undefined; state.authStartScope = undefined })
  return state.authStart
}

export async function startLibTVCanvasPreparation() {
  const state = session()
  const account = await getLibTVAccount()
  return !state.disconnectRequest && account.authenticated && !account.canvas_ready ? startCanvasSetup(account) : account
}

async function removableUnauthenticatedLibTVAccount(state: AccountSession): Promise<boolean> {
  try { await inspectAuthenticatedAccount(); return false } catch (error) {
    if (!(error instanceof LibTVCliError)) throw error
    if (error.reason === 'auth_required') { state.authenticated = false; return true }
    if (error.reason !== 'unavailable' || state.authenticated === true) throw error
    const id = currentProfileId()
    if (id === 'default') {
      const directory = process.env.LIBTV_CONFIG_DIR || path.join(homedir(), '.libtv')
      const credentials = await stat(path.join(directory, 'credentials.json')).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT') return undefined
        throw failure
      })
      if (credentials) throw error
    } else {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(videoCliAccountDirectory('libtv', id)!)
      if (entries.length) throw error
    }
    return true
  }
}
export function disconnectLibTVAccount(options: { removeIfUnauthenticated?: boolean } = {}): Promise<void> {
  const state = session()
  if (state.disconnectRequest) return state.disconnectRequest
  if (state.phoneStepInFlight || state.canvasSetup || state.authStart) {
    return Promise.reject(new LibTVCliError('LibTV 正在处理授权或准备画布，请稍后重试', false, 'account_busy'))
  }
  const busy = new LibTVCliError('LibTV 还有视频任务在提交或运行，请等任务结束后再断开账号', false, 'account_busy')
  state.disconnectRequest = whileVideoCliDisconnecting('libtv', busy, async () => {
    const login = state.localLogin
    if (login) {
      login.cancel()
      await login.closed
    }
    state.phoneChallenge = undefined
    await state.accountProbe
    if (!options.removeIfUnauthenticated || !await removableUnauthenticatedLibTVAccount(state)) {
      try {
        const result = await runLibTVCli(['logout'], false, 15_000)
        if (result.loggedOut !== true) throw new LibTVCliError('LibTV 未确认账号已断开，请稍后重试')
      } catch (error) {
        if (!options.removeIfUnauthenticated || !(error instanceof LibTVCliError) || error.reason !== 'auth_required') throw error
      }
    }
    state.authenticated = false
    state.lastLoginFailure = undefined
  }, currentProfileId()).finally(() => { state.disconnectRequest = undefined })
  return state.disconnectRequest
}

export class LibTVPhoneAuthorizationError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 409 | 410 | 429 | 503) { super(message) }
}

function runLibTVPhoneLogin(phone: string, code?: string): Promise<void> {
  const { executable, options } = libtvRuntime()
  const args = ['login', 'phone', '-p', phone, ...(code === undefined ? [] : ['-c', code])]
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      ...options, timeout: 22_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
    }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        return reject(new LibTVPhoneAuthorizationError('服务端尚未安装可执行的 LibTV 官方 CLI。', 503))
      }
      if (code === undefined && /(?:需要|需)人机验证/u.test(stderr)) {
        return reject(new LibTVPhoneAuthorizationError('LibTV 要求在官方页面完成人机验证。请使用官方网页登录，或请管理员在服务器上完成官方 CLI 授权。', 409))
      }
      if (error.killed || /\b(?:AbortError|TimeoutError|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND)\b|fetch failed/u.test(stderr)) {
        return reject(new LibTVPhoneAuthorizationError('连接 LibTV 手机号授权服务失败，请稍后重试。', 503))
      }
      const phoneReason = /验证码.*(?:错误|无效|过期)|(?:错误|无效|过期).*验证码/u.test(stderr)
        ? '短信验证码错误或已过期，请重新获取验证码。'
        : /频繁|频控|次数|限流|429/u.test(stderr) ? 'LibTV 短信请求过于频繁，请稍后重试。'
        : /封禁|禁用|冻结/u.test(stderr) ? 'LibTV 账号已被限制，请到官网检查账号状态。' : undefined
      if (phoneReason) return reject(new LibTVPhoneAuthorizationError(phoneReason, 400))
      return reject(new LibTVPhoneAuthorizationError(videoCliFailure('libtv', stderr, code === undefined
        ? 'LibTV 未确认验证码已发送。请核对手机号，稍后再试。'
        : 'LibTV 未完成授权，请核对验证码和有效期后重试。'), 400))
    })
    child.stdin?.end()
  })
}

export async function sendLibTVPhoneCode(scope: string, phone: string) {
  const state = session()
  if (state.disconnectRequest || state.phoneStepInFlight || state.authStart || state.localLogin || state.canvasSetup) {
    throw new LibTVPhoneAuthorizationError('LibTV 正在处理另一项授权请求，请稍后重试。', 409)
  }
  if (state.phoneChallenge && Date.now() < state.phoneChallenge.expiresAt && scope !== state.phoneChallenge.scope) {
    throw new LibTVPhoneAuthorizationError('LibTV 正在等候另一位用户完成授权，请稍后重试。', 409)
  }
  if (Date.now() < state.nextPhoneSendAt) throw new LibTVPhoneAuthorizationError('发送过于频繁，请在 60 秒后重试。', 429)
  state.phoneStepInFlight = true
  try {
    const account = await readLibTVAccount()
    if (account.authenticated) throw new LibTVPhoneAuthorizationError('LibTV 已授权，请刷新账号状态。', 409)
    if (!account.available) throw new LibTVPhoneAuthorizationError('服务端尚未安装可执行的 LibTV 官方 CLI。', 503)

    state.nextPhoneSendAt = Date.now() + SMS_COOLDOWN_MS
    await runLibTVPhoneLogin(phone)
    const id = randomUUID()
    const expiresAt = Date.now() + LOGIN_LIFETIME_MS
    state.phoneChallenge = { id, scope, phone, expiresAt, attempts: 0 }
    setTimeout(() => {
      if (state.phoneChallenge?.id === id) state.phoneChallenge = undefined
    }, LOGIN_LIFETIME_MS).unref()
    return { challenge_id: id, expires_at: expiresAt }
  } finally {
    state.phoneStepInFlight = false
  }
}

export async function verifyLibTVPhoneCode(scope: string, challengeId: string, code: string): Promise<LibTVAccount> {
  const state = session()
  if (state.disconnectRequest || state.phoneStepInFlight || state.authStart || state.localLogin) {
    throw new LibTVPhoneAuthorizationError('LibTV 正在处理另一项授权请求，请稍后重试。', 409)
  }
  const challenge = state.phoneChallenge
  if (!challenge || challenge.id !== challengeId || challenge.scope !== scope || Date.now() >= challenge.expiresAt) {
    throw new LibTVPhoneAuthorizationError('本次短信授权已失效，请重新获取验证码。', 410)
  }
  state.phoneStepInFlight = true
  try {
    const existing = await readLibTVAccount()
    if (existing.authenticated) {
      state.phoneChallenge = undefined
      return startCanvasSetup(existing)
    }
    challenge.attempts++
    await runLibTVPhoneLogin(challenge.phone, code)
    state.phoneChallenge = undefined
    state.lastLoginFailure = undefined
    // Probe fresh credentials, even if a status request started before login completed.
    const account = await probeLibTVAccount()
    return account.authenticated ? startCanvasSetup(account) : account
  } finally {
    if (challenge.attempts >= SMS_ATTEMPT_LIMIT && state.phoneChallenge === challenge) state.phoneChallenge = undefined
    state.phoneStepInFlight = false
  }
}

type MediaKind = 'image' | 'video' | 'audio'
type Media = { kind: MediaKind; source: string }
const allowedExtensions: Record<MediaKind, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp'],
  video: ['.mp4', '.mov', '.webm'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'],
}

export function validateLibTVVideo(params: GenerateVideoParams) {
  const model = params.model && libtvVideoModel(params.model)
  if (!model) throw new LibTVCliError('请选择 LibTV 支持的 Seedance 模型')
  const prompt = params.prompt?.trim()
  if (!prompt) throw new LibTVCliError('请填写视频提示词')
  if (params.referenceFileUrl || params.referenceLinkUrl) throw new LibTVCliError('LibTV Seedance 参考素材须为项目内图片、视频或音频')
  const duration = params.duration ?? 5
  const resolution = (params.resolution || model.defaultResolution).toLowerCase()
  const ratio = params.aspectRatio || '16:9'
  if (!Number.isInteger(duration) || duration < model.minDuration || duration > model.maxDuration) {
    throw new LibTVCliError(`LibTV 所选模型支持 ${model.minDuration}–${model.maxDuration} 秒的整数时长`)
  }
  if (!model.resolutions.includes(resolution)) throw new LibTVCliError(`LibTV 所选模型支持 ${model.resolutions.join('、')}`)
  if (!LIBTV_VIDEO_RATIOS.includes(ratio)) throw new LibTVCliError('所选画幅不适用于 LibTV 视频')
  const images = params.referenceImageUrls?.length ? params.referenceImageUrls : params.imageUrl ? [params.imageUrl] : []
  const videos = params.referenceVideoUrls || []
  const audios = params.referenceAudioUrls || []
  if (model.id === LIBTV_SEEDANCE_20_MINI_MODEL && audios.length && !images.length && !videos.length) {
    throw new LibTVCliError('所选 LibTV 模型使用参考音频时须同时提供图片或视频')
  }
  const refs: Media[] = [
    ...images.map(source => ({ kind: 'image' as const, source })),
    ...videos.map(source => ({ kind: 'video' as const, source })),
    ...audios.map(source => ({ kind: 'audio' as const, source })),
  ]
  let mode = refs.length ? (audios.length && !images.length && !videos.length ? 'audio2video' : 'mixed2video') : 'text2video'
  if (params.firstFrameUrl || params.lastFrameUrl) {
    if (refs.length || !params.firstFrameUrl) throw new LibTVCliError('LibTV 首尾帧模式需使用首帧，且不可与其他参考素材混用')
    refs.push({ kind: 'image', source: params.firstFrameUrl })
    if (params.lastFrameUrl) refs.push({ kind: 'image', source: params.lastFrameUrl })
    mode = 'frames2video'
  }
  if (images.length > model.images || videos.length > model.videos || audios.length > model.audios || refs.length > model.maxReferences) {
    throw new LibTVCliError('参考素材数量超过所选 LibTV 模型的限制')
  }
  if (refs.some(({ source, kind }) => !isStoredMedia(source, kind))) {
    throw new LibTVCliError('LibTV 参考素材须先上传到当前项目，格式须符合所选模型')
  }
  return { model, mode, refs, prompt, duration, resolution, ratio, generateAudio: params.generateAudio !== false }
}

function isStoredMedia(source: string, kind: MediaKind) {
  return /^\/?static\//u.test(source) && !/[%?#\\\u0000-\u001f]/u.test(source) &&
    !source.split('/').some(part => part === '.' || part === '..') && allowedExtensions[kind].includes(path.extname(source).toLowerCase())
}

async function localMediaFile(reference: Media) {
  try {
    const root = await realpath(STORAGE_ROOT)
    const filename = await realpath(path.join(root, reference.source.replace(/^\/?static\//u, '')))
    const file = await stat(filename)
    if (!filename.startsWith(root + path.sep) || !file.isFile() || !file.size) throw new Error()
    return filename
  } catch { throw new LibTVCliError('LibTV 参考素材无法读取，请重新上传') }
}

function returnedNode(output: CliObject) {
  const key = output.newNodeKey ?? output.nodeKey
  if (typeof key === 'string' && usableNodeKey.test(key)) return key
  throw new LibTVCliError('LibTV 官方 CLI 未返回有效画布节点编号')
}

export function bindLibTVPrompt(prompt: string, media: { kind: MediaKind; key: string }[]) {
  const keys = { image: [] as string[], video: [] as string[], audio: [] as string[] }
  for (const { kind, key } of media) keys[kind].push(key)
  return prompt.replace(/@(?:图片|图像|视频|音频|声音)\s*(\d+)/gu, (tag, number) => {
    const kind = tag.startsWith('@视频') ? 'video' : tag.startsWith('@音频') || tag.startsWith('@声音') ? 'audio' : 'image'
    const key = keys[kind][Number(number) - 1]
    return key ? `${tag}{{Node ${key}}}` : tag
  })
}

export interface LibTVNode { projectId: string; nodeKey: string; profileId?: string; teamId?: number; upstreamTaskId?: string }

function assertNode(node: LibTVNode) {
  if (!availableProject.test(node.projectId) || !usableNodeKey.test(node.nodeKey)) {
    throw new LibTVCliError('未找到有效的 LibTV 原视频节点')
  }
}

export async function createLibTVVideoNode(params: GenerateVideoParams, taskId: number): Promise<LibTVNode> {
  const input = validateLibTVVideo(params)
  const project = await libtvProjectId()
  // Pin the project's scope rather than the account's currently selected team.
  let teamId: number | undefined
  try { teamId = await readLibTVProjectTeamId(project) } catch {}
  const files = await Promise.all(input.refs.map(localMediaFile))
  const name = `小李短剧-${taskId}-${randomUUID().slice(0, 8)}`
  const media = []
  for (const [index, ref] of input.refs.entries()) {
    const result = await runLibTVCli(['upload', `${name}-${index + 1}`, '--project', project, '--type', ref.kind, '--file', files[index]])
    media.push({ kind: ref.kind, key: returnedNode(result) })
  }
  const output = await runLibTVCli([
    'node', 'create', name, '--project', project, '--type', 'video',
    '-s', `model=${input.model.name}`, '-s', `modeType=${input.mode}`,
    '-s', `ratio=${input.ratio}`, '-s', `resolution=${input.resolution}`, '-s', `duration=${input.duration}`,
    '-s', 'count=1', '-s', `enableSound=${input.generateAudio ? 'on' : 'off'}`,
    ...media.flatMap(({ key }) => ['--left', key]),
    `--prompt=${bindLibTVPrompt(input.prompt, media)}`,
  ])
  return { projectId: project, nodeKey: returnedNode(output), profileId: currentProfileId(), ...(teamId !== undefined && { teamId }) }
}

function videoUrl(source: unknown) {
  const candidates = Array.isArray(source) ? source : [source]
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        /(?:^|\.)(?:liblib\.art|liblib\.cloud|liblib\.tv|newtake\.cloud)$/iu.test(url.hostname)) return url.href
    } catch {}
  }
}

export async function runLibTVVideo(node: LibTVNode, timeout = LIBTV_GENERATION_TIMEOUT_MS): Promise<string | undefined> {
  if ((node.profileId ?? 'default') !== currentProfileId()) return withLibTVAccount(node.profileId ?? 'default', () => runLibTVVideo(node, timeout))
  assertNode(node)
  const result = await runLibTVCli(['node', node.nodeKey, '--project', node.projectId, '--run'], true, timeout)
  const status = statusFromLibTVNode(result)
  if (status.state === 'failed') throw new LibTVCliError(status.message!, true)
  return status.state === 'completed' ? status.url : undefined
}

export async function inspectLibTVVideo(node: LibTVNode): Promise<string | undefined> {
  const result = await inspectLibTVVideoStatus(node)
  if (result.state === 'failed') throw new LibTVCliError(result.message!, true)
  return result.state === 'completed' ? result.url : undefined
}

export interface LibTVVideoStatus {
  state: 'pending' | 'completed' | 'failed' | 'unknown'
  source: 'canvas' | 'upstream'
  url?: string
  message?: string
  progress?: number
  upstreamTaskId?: string
}

function statusFromLibTVNode(output: CliObject): LibTVVideoStatus {
  const focus = asObject(output.node) || asObject(output.focus) || output
  const data = asObject(focus.data) ?? focus
  const task = asObject(data.taskInfo)
  const rawStatus = task?.status ?? output.status ?? data.status
  const status = rawStatus === undefined ? undefined : Number(rawStatus)
  const upstreamTaskId = typeof task?.taskId === 'string' ? task.taskId : typeof output.taskId === 'string' ? output.taskId : undefined
  const base = { source: 'canvas' as const, ...(upstreamTaskId && { upstreamTaskId }),
    ...(typeof task?.progressPercent === 'number' && { progress: task.progressPercent }) }
  if ([3, 4].includes(status!)) return { ...base, state: 'failed', message: videoCliFailure('libtv', { ...output, ...data, ...task }, status === 4 ? 'LibTV 视频生成超时' : 'LibTV 已确认视频任务失败') }
  if ([0, 1].includes(status!)) return { ...base, state: 'pending' }
  const url = videoUrl(data.url ?? output.url)
  if (url && (status === 2 || rawStatus === undefined)) return { ...base, state: 'completed', url }
  return { ...base, state: 'unknown', message: status === 2 ? 'LibTV 已生成完成，但尚未返回有效视频地址' : 'LibTV 尚未返回可确认的任务状态' }
}

/** Query the original upstream task when CLI snapshots were left behind by an interrupted run. */
export async function inspectLibTVVideoStatus(node: LibTVNode): Promise<LibTVVideoStatus> {
  if ((node.profileId ?? 'default') !== currentProfileId()) return withLibTVAccount(node.profileId ?? 'default', () => inspectLibTVVideoStatus(node))
  assertNode(node)
  // A saved upstream identity remains authoritative if the canvas node is rerun elsewhere.
  if (node.upstreamTaskId) return inspectOriginalLibTVTask(node, node.upstreamTaskId)
  const output = await runLibTVCli(['node', node.nodeKey, '--project', node.projectId], false, ACCOUNT_TIMEOUT_MS)
  const snapshot = statusFromLibTVNode(output)
  if (snapshot.state === 'completed' || snapshot.state === 'failed' || !snapshot.upstreamTaskId) return snapshot
  return inspectOriginalLibTVTask(node, snapshot.upstreamTaskId)
}

async function inspectOriginalLibTVTask(node: LibTVNode, taskId: string): Promise<LibTVVideoStatus> {
  let teamId = node.teamId
  if (typeof teamId !== 'number' || !Number.isSafeInteger(teamId) || teamId < 0) {
    try { teamId = await readLibTVProjectTeamId(node.projectId) } catch (error) {
      return { state: 'unknown', source: 'upstream', upstreamTaskId: taskId,
        message: videoCliFailure('libtv', { message: error instanceof Error ? error.message : undefined }, '无法读取 LibTV 原画布所属的团队空间')
          + '；无法确认原画布所属空间，请恢复原账号对画布的访问后查询原任务' }
    }
  }
  return readOriginalLibTVTask(taskId, teamId)
}

async function readLibTVProjectTeamId(projectId: string): Promise<number> {
  const output = await libtvReadonlyRequest(`/api/canvas/project/detail?uuid=${encodeURIComponent(projectId)}`)
  const meta = asObject(asObject(output.data)?.projectMeta)
  if (!meta) throw new LibTVCliError('LibTV 未返回原画布所属空间信息')
  if (meta.teamId === undefined || meta.teamId === null || meta.teamId === 0) return 0
  if (typeof meta.teamId === 'number' && Number.isSafeInteger(meta.teamId) && meta.teamId > 0) return meta.teamId
  throw new LibTVCliError('LibTV 原画布返回了无效的团队编号')
}

async function libtvReadonlyRequest(endpoint: string, body?: CliObject): Promise<CliObject> {
  const { options } = libtvRuntime()
  const credentialsDirectory = options.env.LIBTV_CONFIG_DIR || path.join(homedir(), '.libtv')
  let credential: CliObject | undefined
  try { credential = asObject(JSON.parse(await readFile(path.join(credentialsDirectory, 'credentials.json'), 'utf8'))) } catch {}
  const token = typeof credential?.usertoken === 'string' ? credential.usertoken.trim() : ''
  const webid = typeof credential?.webid === 'string' ? credential.webid.trim() : ''
  if (!token || !webid) throw new LibTVCliError('请重新授权原 LibTV 账号后查询原视频任务', false, 'auth_required')
  let response: Response
  try {
    // Same read-only progress request and headers used by official CLI 1.2.0.
    response = await fetch(`https://api.liblib.tv${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: { token, webid, 'x-language': 'zh', 'X-Log-ID': randomUUID(), 'X-from-client': 'cli', 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS), redirect: 'error',
    })
  } catch (error) {
    throw new LibTVCliError((error as Error)?.name === 'TimeoutError' ? '查询 LibTV 原视频任务超时，可稍后继续查询' : '连接 LibTV 原视频任务查询接口失败，可稍后继续查询', false, 'timeout')
  }
  const output = asObject(await response.json().catch(() => undefined))
  if (response.status === 401) throw new LibTVCliError('原 LibTV 账号授权已失效，请重新授权后查询原任务', false, 'auth_required')
  if (!response.ok || !output || Number(output.code) !== 0) throw new LibTVCliError(videoCliFailure('libtv', output, `查询 LibTV 原任务失败（HTTP ${response.status}）`))
  return output
}

async function readOriginalLibTVTask(taskId: string, teamId: number): Promise<LibTVVideoStatus> {
  if (!/^[\w.-]{1,160}$/u.test(taskId)) throw new LibTVCliError('LibTV 原任务编号无效，请核对画布任务')
  const output = await libtvReadonlyRequest('/api/task/generation/progress', { taskIds: [taskId], ...(teamId > 0 && { teamId }) })
  const progresses = asObject(output.data)?.progresses
  const rows = Array.isArray(progresses) ? progresses.map(asObject).filter((item): item is CliObject => !!item) : []
  const progress = rows.find(item => item.taskId === taskId || item.task_id === taskId)
    ?? (rows.length === 1 && rows[0].taskId === undefined && rows[0].task_id === undefined ? rows[0] : undefined)
  if (!progress) return { state: 'unknown', source: 'upstream', upstreamTaskId: taskId, message: 'LibTV 未返回原任务的状态，请稍后继续查询' }
  const status = Number(progress.status)
  const base = { source: 'upstream' as const, upstreamTaskId: taskId,
    ...(typeof progress.progressPercent === 'number' && { progress: progress.progressPercent }) }
  if ([3, 4].includes(status)) return { ...base, state: 'failed', message: videoCliFailure('libtv', progress, status === 4 ? 'LibTV 视频生成超时' : 'LibTV 已确认视频任务失败') }
  if ([0, 1].includes(status)) return { ...base, state: 'pending' }
  if (status === 2) {
    let result = asObject(progress.taskResult)
    if (typeof progress.taskResult === 'string') { try { result = asObject(JSON.parse(progress.taskResult)) } catch {} }
    const videos = Array.isArray(result?.videos) && result.videos.length ? result.videos : result?.images
    const urls = Array.isArray(videos) ? videos.flatMap(item => {
      const video = asObject(item)
      return video ? [video.videoUrl, video.previewPath, video.url, video.originalPath, video.storagePath] : []
    }) : []
    const url = videoUrl([...urls, result?.videoUrl])
    if (url) return { ...base, state: 'completed', url }
    return { ...base, state: 'unknown', message: 'LibTV 原任务已完成，但未返回有效成片地址，请到原画布核对' }
  }
  return { ...base, state: 'unknown', message: 'LibTV 原任务返回了未识别的状态，请稍后继续查询' }
}

// A node command saves canvas revisions. Avoid interleaving mutations and terminal writeback in one canvas.
const canvasTails = new Map<string, Promise<unknown>>()
export async function withLibTVCanvas<T>(update: () => Promise<T>, waitTimeoutMs = LIBTV_GENERATION_TIMEOUT_MS): Promise<T> {
  const canvasId = await libtvProjectId()
  const waitMs = Number.isFinite(waitTimeoutMs) && waitTimeoutMs >= 0 ? Math.min(waitTimeoutMs, LIBTV_GENERATION_TIMEOUT_MS) : LIBTV_GENERATION_TIMEOUT_MS
  const deadline = Date.now() + waitMs
  const timeoutError = () => new LibTVCliError('LibTV 排队等待超时，尚未提交生成，请稍后重试', false, 'timeout')
  let expired = false
  let started = false
  let timer: ReturnType<typeof setTimeout>
  const queued = (canvasTails.get(canvasId) ?? Promise.resolve()).then(() => {
    if (expired || Date.now() >= deadline) throw timeoutError()
    started = true
    clearTimeout(timer)
    return update()
  })
  // Reject while waiting, then keep a skipped queue entry so it can never submit later.
  const result = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (started) return
      expired = true
      reject(timeoutError())
    }, waitMs)
    queued.then(resolve, reject).finally(() => clearTimeout(timer))
  })
  const tail = queued.catch(() => {})
  canvasTails.set(canvasId, tail)
  void tail.finally(() => { if (canvasTails.get(canvasId) === tail) canvasTails.delete(canvasId) })
  return result
}
