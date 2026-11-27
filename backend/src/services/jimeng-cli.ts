import { execFile } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { jimengVideoModelSpecs } from './jimeng-video-models.js'
import { whileVideoCliDisconnecting } from './video-cli-tasks.js'
import { videoCliFailure } from './video-cli-errors.js'
import { getActiveVideoCliAccountId, resolveVideoCliAccountId, updateVideoCliAccountNameFromPlatform, videoCliAccountDirectory } from './video-cli-accounts.js'

type CliData = Record<string, unknown>
export type JimengReferenceKind = 'image' | 'video' | 'audio'
export type JimengVideoMode = 't2v' | 'first_last_frame' | 'm2v'

export interface JimengAccount {
  available: boolean
  authenticated: boolean
  username?: string
  credits?: number
  membership?: string
  message?: string
  accountId?: string
  authorizationPending?: boolean
}

export interface JimengAuthorization {
  authenticated: boolean
  verificationUrl?: string
  userCode?: string
  pending?: boolean
  message?: string
}

export interface JimengVideoModel {
  id: string
  name: string
  canonicalModel: string
}

export interface JimengVideoDraftInput {
  projectId: string
  model: string
  prompt: string
  mode: JimengVideoMode
  duration: number
  aspectRatio: string
  resolution: string
  references?: readonly { kind: JimengReferenceKind; resourceId: string }[]
}

export interface JimengVideoRunInput {
  projectId: string
  nodeId: string
  accountId: string
  draftFingerprint: string
  submitId: string
  /** Saved local account profile; absent on tasks created before multi-account support. */
  profileId?: string
  /** Ceiling a user confirmed before direct submission was introduced. */
  credits?: number
}

export interface JimengVideoStatus {
  state: 'pending' | 'completed' | 'failed'
  resourceId?: string
  duration?: number
  message?: string
}

export class JimengCliError extends Error {
  constructor(message: string, readonly code?: number, readonly reason?: string, readonly possiblySubmitted = false) {
    super(message)
    this.name = 'JimengCliError'
  }
}

const accountContext = new AsyncLocalStorage<string>()
export function getActiveJimengAccountId() { return getActiveVideoCliAccountId('jimeng') }
export function getCurrentJimengAccountId() { return accountContext.getStore() ?? getActiveJimengAccountId() }
export function withJimengAccount<T>(accountId: string | undefined, action: () => T): T {
  const id = resolveVideoCliAccountId('jimeng', accountId ?? accountContext.getStore())
  return accountContext.run(id, action)
}

const processEnvironment = [
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'USER', 'LOGNAME', 'PATH', 'SYSTEMROOT', 'LANG', 'LC_ALL',
  'TMPDIR', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'DREAMINA_CANVAS_STATE_DIR',
]

function cliBinary() {
  const executable = process.env.JIMENG_CLI_BIN?.trim() || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'dreamina-canvas.exe' : 'dreamina-canvas')
  if (!path.isAbsolute(executable)) throw new JimengCliError('JIMENG_CLI_BIN 必须为绝对路径', undefined, 'unavailable')
  return executable
}

function object(value: unknown): CliData {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as CliData : {}
}

function list(value: unknown): CliData[] {
  return Array.isArray(value) ? value.map(object) : []
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function creditAmount(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : undefined
}

function readEnvelope(output: string): CliData {
  try {
    // The schema declares userId as an integer and some IDs exceed JS's safe integer range.
    return object(JSON.parse(output, (key, value, context?: { source?: string }) =>
      key === 'userId' && typeof value === 'number' && context?.source ? context.source : value))
  } catch {
    return {}
  }
}

function cliError(info: CliData) {
  const code = typeof info.code === 'number' && Number.isInteger(info.code) ? info.code : undefined
  const candidate = string(info.reason)
  const reason = candidate && /^[a-z][a-z0-9_]{0,70}$/u.test(candidate) ? candidate : undefined
  if (code === 3) return new JimengCliError('请先授权即梦账号', code, 'auth_required')
  if (code === 40018) return new JimengCliError(videoCliFailure('jimeng', info, '即梦积分授权未成功，请检查账号和积分后重试'), code, reason)
  if (reason === 'vip_membership_required') return new JimengCliError('当前即梦账号没有使用该模型所需的会员权益', code, reason)
  if (reason === 'account_changed') return new JimengCliError('即梦授权账号已变更，请重新提交', code, reason)
  return new JimengCliError(videoCliFailure('jimeng', info, '即梦官方 CLI 请求失败'), code, reason)
}

function invoke(args: readonly string[], timeout = 30_000, signal?: AbortSignal): Promise<CliData> {
  const binary = cliBinary()
  const id = resolveVideoCliAccountId('jimeng', getCurrentJimengAccountId())
  const baseProfile = process.env.JIMENG_CLI_PROFILE?.trim() || 'drama-plus'
  const profile = id === 'default' ? baseProfile : `${baseProfile}-${id}`
  if (args.some(arg => arg.includes('\0'))) throw new JimengCliError('即梦请求参数含有无效字符')
  const env = Object.fromEntries(processEnvironment.map(key => [key, process.env[key]]))
  if (id !== 'default') env.DREAMINA_CANVAS_STATE_DIR = videoCliAccountDirectory('jimeng', id)
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [
      '--format=json', '--non-interactive', `--profile=${profile}`, ...args,
    ], { env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', stop)
      const output = readEnvelope(stdout)
      if (!error && output.ok === true) return resolve(object(output.data))
      // Failed commands emit the official JSON envelope on stderr. Never return raw output or execFile errors.
      const failure = output.ok === false ? output : readEnvelope(stderr)
      if (failure.ok === false) {
        const info = object(failure.error)
        // A generic parameter error is not enough to retry: ask the CLI schema
        // whether this exact read command is missing before using its old name.
        if (args[0] === 'schema' && args[1] === 'model ls' && info.code === 2 &&
            list(info.diagnostics).some(item => item.detail === 'The requested command path is not available in this CLI schema.')) {
          return reject(new JimengCliError('当前即梦 CLI 不支持 model ls', 2, 'unsupported_cli_command'))
        }
        return reject(cliError({ ...info, diagnostics: failure.diagnostics }))
      }
      if (error?.code === 'ENOENT' || error?.code === 'EACCES') {
        return reject(new JimengCliError('当前服务环境无法运行即梦官方画布 CLI，请检查安装及执行权限', undefined, 'unavailable'))
      }
      reject(new JimengCliError(error?.killed ? '等待即梦官方 CLI 超时' : '即梦官方 CLI 未返回可识别的结果', undefined, error?.killed ? 'timeout' : undefined))
    })
    const stop = () => { child.kill('SIGKILL') }
    if (signal?.aborted) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    child.stdin?.end()
  })
}

function officialVerificationUrl(value: unknown) {
  try {
    const uri = new URL(String(value))
    if (uri.protocol === 'https:' && uri.hostname === 'jimeng.jianying.com' && !uri.port && !uri.username && !uri.password) return uri.href
  } catch {
    return undefined
  }
}

interface AuthorizationScope {
  authenticated?: boolean
  starting?: Promise<JimengAuthorization>
  active?: { state: JimengAuthorization; controller: AbortController; finished: Promise<void> }
  message?: string
  disconnecting?: Promise<void>
}
const authorizationScopes = new Map<string, AuthorizationScope>()
function authorizationScope() {
  const id = getCurrentJimengAccountId()
  let scope = authorizationScopes.get(id)
  if (!scope) { scope = {}; authorizationScopes.set(id, scope) }
  return scope
}

export function getJimengAccount(): Promise<JimengAccount> {
  return withJimengAccount(undefined, getScopedJimengAccount)
}
async function getScopedJimengAccount(): Promise<JimengAccount> {
  const scope = authorizationScope()
  let authenticated = false
  try {
    const status = await invoke(['auth', 'status'])
    authenticated = status.loggedIn === true
    scope.authenticated = authenticated
    if (!authenticated) {
      return { available: true, authenticated, authorizationPending: !!scope.active, message: scope.message }
    }
    const data = await invoke(['auth', 'account'])
    const username = string(data.displayName)
    updateVideoCliAccountNameFromPlatform('jimeng', getCurrentJimengAccountId(), username)
    return {
      available: true,
      authenticated,
      username,
      credits: creditAmount(data.availableCredits ?? object(data.credits).available),
      membership: string(data.vipLevel),
      accountId: string(data.userId),
    }
  } catch (error) {
    if (!(error instanceof JimengCliError)) throw error
    if (error.reason === 'auth_required') authenticated = false
    return { available: error.reason !== 'unavailable', authenticated, message: error.message }
  }
}

export function startJimengAuthorization(): Promise<JimengAuthorization> {
  return withJimengAccount(undefined, () => {
    const scope = authorizationScope()
    if (scope.disconnecting) return Promise.reject(new JimengCliError('正在断开即梦账号，请稍后重新连接', undefined, 'account_busy'))
    if (scope.active) return Promise.resolve(scope.active.state)
    if (scope.starting) return scope.starting
    scope.starting = beginAuthorization().finally(() => { scope.starting = undefined })
    return scope.starting
  })
}

async function beginAuthorization(): Promise<JimengAuthorization> {
  const scope = authorizationScope()
  scope.message = undefined
  const data = await invoke(['auth', 'login', '--no-browser'])
  if (data.status === 'reused' || data.status === 'logged_in') return { authenticated: true }
  const challenge = object(data.challenge)
  const deviceCode = string(challenge.deviceCode)
  const completeUrl = officialVerificationUrl(challenge.verificationUriComplete)
  const verificationUrl = completeUrl || officialVerificationUrl(challenge.verificationUri)
  if (data.status !== 'authorization_required' || !deviceCode || !verificationUrl) {
    throw new JimengCliError('即梦 CLI 未返回可用的官方网页授权链接')
  }
  const state = { authenticated: false, pending: true, verificationUrl, userCode: completeUrl ? undefined : string(challenge.userCode) }
  const controller = new AbortController()
  const finished = invoke(['auth', 'wait', `--device-code=${deviceCode}`, '--timeout=5m'], 305_000, controller.signal)
    .then(result => {
      if (result.status !== 'logged_in') scope.message = '即梦账号授权尚未完成，请重新发起授权'
    })
    .catch(error => {
      if (!controller.signal.aborted) scope.message = error instanceof JimengCliError ? error.message : '即梦账号授权未完成或已过期，请重新发起授权'
    })
    .finally(() => { scope.active = undefined })
  scope.active = { state, controller, finished }
  return state
}

export function disconnectJimengAccount(options: { removeIfUnauthenticated?: boolean } = {}): Promise<void> {
  return withJimengAccount(undefined, () => disconnectScopedJimengAccount(options))
}
async function removableUnauthenticatedJimengAccount(scope: AuthorizationScope): Promise<boolean> {
  try {
    const status = await invoke(['auth', 'status'])
    if (status.loggedIn === true) { scope.authenticated = true; return false }
    if (status.loggedIn === false) { scope.authenticated = false; return true }
    throw new JimengCliError('即梦未返回可确认的登录状态，请刷新后再移除账号')
  } catch (error) {
    if (!(error instanceof JimengCliError)) throw error
    if (error.reason === 'auth_required') { scope.authenticated = false; return true }
    if (error.reason !== 'unavailable' || scope.authenticated === true) throw error
    const id = getCurrentJimengAccountId()
    const directory = id === 'default' ? process.env.DREAMINA_CANVAS_STATE_DIR : videoCliAccountDirectory('jimeng', id)
    // 未配置 legacy 状态目录时无法核实凭据，保留账号，避免丢失原授权。
    if (!directory) throw error
    const entries = await fs.readdir(directory).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code === 'ENOENT') return []
      throw failure
    })
    if (entries.length) throw error
    return true
  }
}
function disconnectScopedJimengAccount(options: { removeIfUnauthenticated?: boolean }): Promise<void> {
  const scope = authorizationScope()
  if (scope.disconnecting) return scope.disconnecting
  const busy = new JimengCliError('还有即梦视频任务在提交或运行，请等任务结束后再断开账号', undefined, 'account_busy')
  scope.disconnecting = whileVideoCliDisconnecting('jimeng', busy, async () => {
    await scope.starting?.catch(() => {})
    const authorization = scope.active
    // Let the waiting CLI process exit before logout so a late approval cannot write its credentials back.
    authorization?.controller.abort()
    await authorization?.finished
    if (!options.removeIfUnauthenticated || !await removableUnauthenticatedJimengAccount(scope)) {
      try {
        const result = await invoke(['auth', 'logout'])
        if (result.loggedOut !== true) throw new JimengCliError('即梦官方 CLI 未确认账号已断开')
      } catch (error) {
        if (!options.removeIfUnauthenticated || !(error instanceof JimengCliError) || error.reason !== 'auth_required') throw error
      }
    }
    scope.authenticated = false
    scope.message = undefined
  }, getCurrentJimengAccountId()).finally(() => { scope.disconnecting = undefined })
  return scope.disconnecting
}

export async function getJimengVideoModels(): Promise<JimengVideoModel[]> {
  let data: CliData | undefined
  try {
    data = await invoke(['model', 'ls', '--type=video'])
  } catch (error) {
    if (!(error instanceof JimengCliError) || error.code !== 2) throw error
    try {
      await invoke(['schema', 'model ls'])
    } catch (schemaError) {
      if (schemaError instanceof JimengCliError && schemaError.reason === 'unsupported_cli_command') {
        data = await invoke(['model', 'list', '--type=video'])
      } else throw schemaError
    }
    // If the schema supports the command, preserve its original error.
    if (!data) throw error
  }
  // Some CLI versions interpret an unknown subcommand as a model search and return success.
  if (!Array.isArray(data.items) && data.query === 'ls' && Array.isArray(data.matches)) {
    data = await invoke(['model', 'list', '--type=video'])
  }
  const catalog = list(data.items)
  return Object.entries(jimengVideoModelSpecs).flatMap(([id, { canonicalModel }]) => {
    const item = catalog.find(item => item.model === canonicalModel)
    const name = string(item?.displayName)
    return name ? [{ id, canonicalModel, name }] : []
  })
}

export async function getJimengPersonalSpaceAccountId() {
  const space = await invoke(['space', 'current'])
  const accountId = string(space.userId)
  if (!accountId || String(space.kind).toLowerCase() !== 'personal' || space.team) {
    throw new JimengCliError('请先授权即梦账号并切换到个人空间')
  }
  return accountId
}

function requirePersonalSubject(subject: CliData, accountId: string) {
  if (String(subject.kind).toLowerCase() !== 'personal' || String(subject.userId) !== accountId || subject.teamId) {
    throw new JimengCliError('当前即梦消费归属与个人账号不一致，请检查即梦空间后重试')
  }
}

export async function createJimengCanvas(title: string, projectId = randomUUID()): Promise<{ projectId: string; webUrl?: string }> {
  const data = await invoke(['canvas', 'create', `--project-id=${projectId}`, '--', title])
  const project = object(data.project)
  if (project.projectId !== projectId) throw new JimengCliError('即梦没有返回预期的画布 ID')
  return { projectId, webUrl: officialVerificationUrl(project.webUrl) }
}

export async function uploadJimengReference(projectId: string, filePath: string, kind: JimengReferenceKind, displayName?: string): Promise<string> {
  const resourceId = randomUUID()
  const data = await invoke(['resource', 'upload', `--project-id=${projectId}`, `--resource-id=${resourceId}`, `--file=${filePath}`, `--type=${kind}`,
    ...(displayName ? [`--name=${displayName}`] : []),
  ], 120_000)
  if (data.resourceId !== resourceId || String(data.mediaType).toLowerCase() !== kind) throw new JimengCliError('即梦没有返回预期的参考素材')
  return resourceId
}

function draftFingerprint(node: CliData): string {
  const gen = object(node.generation)
  if (node.type !== 'video' || !string(gen.model) || !string(gen.mode)) throw new JimengCliError('即梦未返回可核对的视频草稿')
  const references = list(gen.references).map(ref => [ref.kind, ref.id, ref.type])
  const fields = [gen.mode, gen.model, gen.prompt, gen.durationSeconds, gen.ratio, gen.resolution, gen.outputCount, references]
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

async function showVideoNode(projectId: string, nodeId: string) {
  const data = await invoke(['node', 'show', `--project-id=${projectId}`, `--node-id=${nodeId}`])
  const item = list(data.nodes).find(entry => String(entry.result).toUpperCase() === 'FOUND' && object(entry.node).nodeId === nodeId)
  const node = object(item?.node)
  if (node.type !== 'video') throw new JimengCliError('即梦未返回可核对的视频草稿')
  return node
}

function verifyVideoDraft(input: JimengVideoDraftInput, canonicalModel: string, node: CliData) {
  const generation = object(node.generation)
  const expectedReferences = (input.references || []).map(ref => `${ref.kind}:${ref.resourceId}`)
  const actualReferences = list(generation.references).map(ref => ref.kind === 'resource' ? `${ref.type}:${ref.id}` : '')
  // Multimodal references are stored in prompt order. First/last frames are positional.
  if (input.mode === 'm2v') {
    expectedReferences.sort()
    actualReferences.sort()
  }
  const sameReferences = expectedReferences.length === actualReferences.length && expectedReferences.every((ref, index) => ref === actualReferences[index])
  const checks: [boolean, string][] = [
    [generation.model === canonicalModel, '模型'],
    [generation.mode === input.mode, '生成模式'],
    [generation.durationSeconds === input.duration, '时长'],
    [generation.ratio === input.aspectRatio, '画幅'],
    [String(generation.resolution).toUpperCase() === input.resolution.toUpperCase(), '清晰度'],
    [generation.outputCount === 1, '生成数量'],
    [sameReferences, '参考素材'],
  ]
  const mismatches = checks.filter(([matches]) => !matches).map(([, field]) => field)
  if (mismatches.length) {
    throw new JimengCliError(`即梦保存的分镜参数与请求不一致（${mismatches.join('、')}），请检查后重试`)
  }
}

async function quoteNode(projectId: string, nodeId: string, accountId: string) {
  const data = await invoke(['node', 'quote', `--project-id=${projectId}`, `--node-id=${nodeId}`])
  requirePersonalSubject(object(data.consumptionSubject), accountId)
  const total = data.totalMaxCredits
  const version = data.draftVersion
  const items = list(data.items)
  if (items.length !== 1 || items[0].nodeId !== nodeId || items[0].error) {
    if (items[0]?.error) throw cliError(object(items[0].error))
    throw new JimengCliError('即梦未返回当前分镜的有效报价')
  }
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || items[0].maxCredits !== total ||
    data.confirmable === false || typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new JimengCliError('即梦未返回可确认的积分报价')
  }
  return total
}

export function createJimengVideoDraft(input: JimengVideoDraftInput, accountId: string): Promise<JimengVideoRunInput> {
  return withJimengAccount(undefined, () => createScopedJimengVideoDraft(input, accountId))
}
async function createScopedJimengVideoDraft(input: JimengVideoDraftInput, accountId: string): Promise<JimengVideoRunInput> {
  const models = (await getJimengVideoModels()).filter(item => item.id === input.model || item.canonicalModel === input.model)
  if (models.length !== 1) throw new JimengCliError('当前即梦账号未返回唯一可用的所选 Seedance 模型')
  const data = await invoke([
    'node', 'create', 'video', `--project-id=${input.projectId}`, `--mode=${input.mode}`, `--model=${models[0].canonicalModel}`,
    `--prompt=${input.prompt}`, `--duration=${input.duration}`, `--ratio=${input.aspectRatio}`,
    `--resolution=${input.resolution.toUpperCase()}`, '--count=1',
    ...(input.references || []).map(ref => `--ref=res:${ref.resourceId}`),
  ])
  const nodeId = string(object(data.node).nodeId)
  if (!nodeId) throw new JimengCliError('即梦未返回视频草稿节点 ID')
  const node = await showVideoNode(input.projectId, nodeId)
  verifyVideoDraft(input, models[0].canonicalModel, node)
  return { projectId: input.projectId, nodeId, accountId, profileId: getCurrentJimengAccountId(), draftFingerprint: draftFingerprint(node), submitId: randomUUID() }
}

export function runJimengVideo(input: JimengVideoRunInput, beforeRun?: () => void): Promise<void> {
  return withJimengAccount(input.profileId ?? 'default', () => runScopedJimengVideo(input, beforeRun))
}
async function runScopedJimengVideo(input: JimengVideoRunInput, beforeRun?: () => void): Promise<void> {
  const { projectId, nodeId, submitId, accountId } = input
  if (input.credits !== undefined && (!Number.isSafeInteger(input.credits) || input.credits < 0)) {
    throw new JimengCliError('已确认的即梦积分上限无效')
  }
  if (await getJimengPersonalSpaceAccountId() !== accountId) throw new JimengCliError('即梦授权账号已变更，请重新提交')
  const context = [`--project-id=${projectId}`, `--node-id=${nodeId}`]
  const current = await showVideoNode(projectId, nodeId)
  if (draftFingerprint(current) !== input.draftFingerprint) throw new JimengCliError('即梦视频草稿已变更，请重新提交')
  // The official CLI requires a short-lived token issued under an exact credit ceiling.
  const latest = await quoteNode(projectId, nodeId, accountId)
  if (input.credits !== undefined && latest > input.credits) {
    throw new JimengCliError('即梦最新报价超过已确认的积分上限，请重新提交')
  }
  const credits = input.credits ?? latest
  const approval = await invoke(['node', 'confirm', ...context, `--credit-ceiling=${credits}`])
  requirePersonalSubject(object(approval.consumptionSubject), accountId)
  const token = string(approval.creditConfirmationToken)
  if (!token || approval.creditCeiling !== credits) throw new JimengCliError('即梦未返回对应的积分上限授权')
  beforeRun?.()
  let result: CliData
  try {
    result = await invoke(['node', 'run', ...context, `--submit-id=${submitId}`, `--credit-token=${token}`], 60_000)
  } catch (error) {
    const cause = error instanceof JimengCliError ? error : undefined
    throw new JimengCliError(`即梦提交状态暂不明确，将查询原任务${cause?.message ? `。${cause.message}` : ''}`, cause?.code, cause?.reason, true)
  }
  const item = list(result.items).find(item => item.submitId === submitId && item.nodeId === nodeId)
  const state = String(item?.state).toUpperCase()
  if (state === 'REJECTED') throw cliError(object(item?.error))
  if (state !== 'ACCEPTED') throw new JimengCliError('即梦提交状态暂不明确，将查询原任务', undefined, undefined, true)
}

export function inspectJimengVideo(projectId: string, submitId: string, profileId = 'default'): Promise<JimengVideoStatus> {
  return withJimengAccount(profileId, () => inspectScopedJimengVideo(projectId, submitId))
}
async function inspectScopedJimengVideo(projectId: string, submitId: string): Promise<JimengVideoStatus> {
  const context = `--project-id=${projectId}`
  let operation: CliData
  try {
    operation = await invoke(['operation', 'status', context, '--', submitId])
  } catch (error) {
    if (error instanceof JimengCliError && error.code === 40012) return { state: 'pending' }
    throw error
  }
  const state = String(operation.state).toLowerCase()
  if (state === 'failed' || state === 'awaiting_confirmation' || state === 'rejected') {
    const failedResources = list(operation.resources).filter(item =>
      ['failed', 'failure', 'rejected', 'error'].includes(String(item.state ?? item.status).toLowerCase()))
    const message = videoCliFailure('jimeng', { ...operation, resources: failedResources },
      state === 'awaiting_confirmation' ? '即梦未受理生成，请检查积分授权后重试' : '即梦视频生成失败（平台未提供具体原因）')
    return { state: 'failed', message }
  }
  if (!['succeeded', 'success', 'completed'].includes(state)) return { state: 'pending' }
  for (const item of list(operation.resources)) {
    const resourceId = string(item.resourceId)
    if (!resourceId) continue
    const resource = await invoke(['resource', 'get', context, '--', resourceId])
    if (['failed', 'failure', 'rejected', 'error'].includes(String(resource.status).toLowerCase())) {
      return { state: 'failed', message: videoCliFailure('jimeng', resource.error ?? resource, '即梦视频素材生成失败') }
    }
    if (resource.resourceId !== resourceId || String(resource.type).toLowerCase() !== 'video' ||
      !['succeeded', 'success', 'completed'].includes(String(resource.status).toLowerCase())) continue
    const duration = object(resource.video).durationSeconds
    return { state: 'completed', resourceId, duration: typeof duration === 'number' ? duration : undefined }
  }
  return { state: 'pending' }
}

export function downloadJimengVideo(projectId: string, resourceId: string, destinationPath: string, profileId = 'default'): Promise<void> {
  return withJimengAccount(profileId, () => downloadScopedJimengVideo(projectId, resourceId, destinationPath))
}
async function downloadScopedJimengVideo(projectId: string, resourceId: string, destinationPath: string): Promise<void> {
  const data = await invoke(['resource', 'download', `--project-id=${projectId}`, `--output=${destinationPath}`, '--', resourceId], 120_000)
  const file = await fs.open(destinationPath, 'r')
  try {
    const media = Buffer.alloc(12)
    const { bytesRead } = await file.read(media, 0, media.length, 0)
    const { size } = await file.stat()
    if (data.resourceId !== resourceId || data.size !== size || bytesRead !== media.length || media.toString('ascii', 4, 8) !== 'ftyp') {
      throw new JimengCliError('即梦没有下载到有效的 MP4 文件')
    }
    const hash = createHash('sha256')
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) hash.update(chunk)
    if (data.sha256 !== hash.digest('hex')) throw new JimengCliError('即梦下载的视频文件校验失败')
  } finally {
    await file.close()
  }
}
