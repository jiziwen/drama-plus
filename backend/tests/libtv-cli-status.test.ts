import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('LibTV Mini availability uses the configured account and verifies its live voice video schema', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'libtv-mini-schema-'))
  const previous = { VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR, LIBTV_CLI_BIN: process.env.LIBTV_CLI_BIN }
  Object.assign(process.env, { VIDEO_CLI_ACCOUNTS_DIR: directory, LIBTV_CLI_BIN: process.execPath })
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(directory, { recursive: true, force: true })
  })
  const accounts = await import('../src/services/video-cli-accounts.js')
  const profile = accounts.createVideoCliAccount('libtv', '测试账号')
  const expectedDirectory = accounts.videoCliAccountDirectory('libtv', profile.id)
  let result: any = { modelKey: 'star-video2-mini', modality: 'video', schema: {
    modelKey: 'star-video2-mini', properties: {
      resolution: { enum: [{ value: '480p' }, { value: '720p' }] },
      duration: { min: 4, max: 15, step: 1 }, enableSound: { enum: [{ value: 'on' }, { value: 'off' }] },
    }, config: { generateTypes: { text: 47 } }, rules: [{ forModeTypes: ['text2video'], require: ['prompt'] }],
  } }
  t.mock.method(childProcess, 'execFile', (_binary: string, args: string[], options: { env: NodeJS.ProcessEnv }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.deepEqual(args, ['model', 'star-video2-mini'])
    assert.equal(options.env.LIBTV_CONFIG_DIR, expectedDirectory)
    queueMicrotask(() => callback(null, JSON.stringify(result), ''))
    return Object.assign(new EventEmitter(), { stdin: { end() {} } })
  })
  syncBuiltinESMExports()
  const { libtvHasSeedance20Mini, withLibTVAccount, validateLibTVVideo } = await import('../src/services/libtv-cli.js')
  const check = () => withLibTVAccount(profile.id, () => libtvHasSeedance20Mini(5, '480p'))
  assert.equal(await check(), true)
  result.schema.properties.duration.step = 2
  assert.equal(await check(), false)
  result.schema.properties.duration.step = 1
  const input = { model: 'star-video2-mini', prompt: '说一句话', duration: 5, resolution: '480p' }
  assert.equal(validateLibTVVideo(input).mode, 'text2video')
  assert.throws(() => validateLibTVVideo({ ...input, duration: 16 }), /4–15/)
  assert.throws(() => validateLibTVVideo({ ...input, referenceAudioUrls: ['/static/uploads/a.wav'] }), /同时提供图片或视频/)
  result.schema.properties.enableSound.enum = [{ value: 'off' }]
  assert.equal(await check(), false)
  result.schema.properties.enableSound.enum = [{ value: 'on' }]
  result.schema.properties.resolution.enum = [{ value: '720p' }]
  assert.equal(await check(), false)
  result.schema.properties.resolution.enum = [{ value: '480p' }]
  result.schema.rules = []
  assert.equal(await check(), false)
  result.schema.rules = [{ forModeTypes: ['text2video'], require: ['prompt'] }]
  result.modelKey = 'star-video2.5'
  assert.equal(await check(), false)
})

test('LibTV 生成等待尊重有限期限，官方嵌套成片地址能够直接完成', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-libtv-cli-result-'))
  const previous = { VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR, LIBTV_CLI_BIN: process.env.LIBTV_CLI_BIN }
  Object.assign(process.env, { VIDEO_CLI_ACCOUNTS_DIR: directory, LIBTV_CLI_BIN: process.execPath })
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; await rm(directory, { recursive: true, force: true }) })
  let output: unknown = { status: 2, nodeKey: 'video-node', data: { type: 'video', url: ['https://tv-res.newtake.cloud/fixture.mp4'], taskInfo: { taskId: 'upstream-task', status: 2 } } }
  let capturedTimeout: number | undefined
  t.mock.method(childProcess, 'execFile', (_binary: string, _args: string[], options: { timeout?: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    capturedTimeout = options.timeout
    queueMicrotask(() => callback(null, JSON.stringify(output), ''))
    return Object.assign(new EventEmitter(), { stdin: { end() {} } })
  })
  syncBuiltinESMExports()
  const { runLibTVCli, runLibTVVideo, LibTVCliError } = await import('../src/services/libtv-cli.js')
  await runLibTVCli(['node', 'video-node', '--run'], true, 75)
  assert.equal(capturedTimeout, 75, '生成任务也必须遵守调用方给出的等待期限')
  const node = { projectId: '01322532-e5de-42a4-9549-5248fb705309', nodeKey: 'video-node', profileId: 'default' }
  assert.equal(await runLibTVVideo(node), 'https://tv-res.newtake.cloud/fixture.mp4')
  output = { status: 3, data: { type: 'video', taskInfo: { status: 3, failedReason: '参考素材未通过审核' } } }
  await assert.rejects(runLibTVVideo(node), error => error instanceof LibTVCliError && error.terminal && /参考素材未通过审核/u.test(error.message))
})

test('中断后的原画布状态通过官方只读进度查询恢复，固定原账号并读取成片/失败', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-libtv-progress-'))
  const previous = { VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR, LIBTV_CLI_BIN: process.env.LIBTV_CLI_BIN }
  const originalFetch = globalThis.fetch
  Object.assign(process.env, { VIDEO_CLI_ACCOUNTS_DIR: directory, LIBTV_CLI_BIN: process.execPath })
  t.after(async () => { globalThis.fetch = originalFetch; t.mock.restoreAll(); syncBuiltinESMExports(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }; await rm(directory, { recursive: true, force: true }) })
  const profiles = await import('../src/services/video-cli-accounts.js')
  const profile = profiles.createVideoCliAccount('libtv', '原任务账号')
  const otherProfile = profiles.createVideoCliAccount('libtv', '后来切换的账号')
  const credentialDirectory = profiles.videoCliAccountDirectory('libtv', profile.id)!
  await writeFile(path.join(credentialDirectory, 'credentials.json'), JSON.stringify({ usertoken: 'fixture-original-token', useruuid: 'fixture-user', webid: 'fixture-webid', activeTeamId: 81 }))
  const calls: string[][] = []
  let canvas: unknown = { nodeKey: 'video-node', data: { type: 'video', taskInfo: { taskId: 'upstream-task', status: 1, loading: true } } }
  t.mock.method(childProcess, 'execFile', (_binary: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    calls.push(args)
    assert.equal(options.env.LIBTV_CONFIG_DIR, credentialDirectory)
    assert.ok(options.timeout <= 8_000)
    queueMicrotask(() => callback(null, JSON.stringify(canvas), ''))
    return Object.assign(new EventEmitter(), { stdin: { end() {} } })
  })
  syncBuiltinESMExports()
  let progress: Record<string, unknown> = { taskId: 'upstream-task', status: 2, progressPercent: 100, taskResult: JSON.stringify({ videos: [{ videoUrl: 'https://tv-res.newtake.cloud/completed.mp4' }] }) }
  let networkCalls = 0
  let projectMeta: unknown = { teamId: 42 }
  let expectedTeamId: number | undefined = 42
  globalThis.fetch = async (input, init) => {
    networkCalls++
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('token'), 'fixture-original-token')
    assert.equal(headers.get('webid'), 'fixture-webid')
    assert.equal(headers.get('X-from-client'), 'cli')
    assert.equal(init?.redirect, 'error')
    if (String(input).includes('/api/canvas/project/detail?')) {
      assert.equal(String(input), 'https://api.liblib.tv/api/canvas/project/detail?uuid=01322532-e5de-42a4-9549-5248fb705309')
      assert.equal(init?.method, 'GET')
      return Response.json({ code: 0, data: { projectMeta } })
    }
    assert.equal(String(input), 'https://api.liblib.tv/api/task/generation/progress')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(JSON.parse(String(init?.body)), { taskIds: ['upstream-task'], ...(expectedTeamId !== undefined && { teamId: expectedTeamId }) })
    return Response.json({ code: 0, data: { progresses: [progress] } })
  }
  profiles.setActiveVideoCliAccount('libtv', otherProfile.id)
  const { inspectLibTVVideoStatus, inspectLibTVVideo, LibTVCliError } = await import('../src/services/libtv-cli.js')
  const node = { projectId: '01322532-e5de-42a4-9549-5248fb705309', nodeKey: 'video-node', profileId: profile.id }
  const completed = await inspectLibTVVideoStatus(node)
  assert.equal(completed.state, 'completed')
  assert.equal(completed.source, 'upstream')
  assert.equal(completed.url, 'https://tv-res.newtake.cloud/completed.mp4')
  progress = { taskId: 'upstream-task', status: 0, progressPercent: 2 }
  assert.equal((await inspectLibTVVideoStatus(node)).state, 'pending')
  progress = { taskId: 'upstream-task', status: 3, failedReason: '参考音频未通过审核 token=private-fixture-token' }
  const failed = await inspectLibTVVideoStatus(node)
  assert.equal(failed.state, 'failed')
  assert.match(failed.message!, /参考音频未通过审核/u)
  assert.doesNotMatch(failed.message!, /private-fixture-token/u)
  await assert.rejects(inspectLibTVVideo(node), error => error instanceof LibTVCliError && error.terminal)
  progress = { taskId: 'other-task', status: 2, taskResult: JSON.stringify({ videos: [{ url: 'https://tv-res.newtake.cloud/wrong.mp4' }] }) }
  assert.equal((await inspectLibTVVideoStatus(node)).state, 'unknown', '不能把其他任务的结果当作当前任务')
  progress = { status: 2, taskResult: JSON.stringify({ videos: [{ url: 'https://tv-res.newtake.cloud/completed.mp4' }] }) }
  assert.equal((await inspectLibTVVideoStatus(node)).state, 'completed', '官方单任务响应可没有taskId字段')
  canvas = { status: 2, data: { url: ['https://tv-res.newtake.cloud/wrong.mp4'], taskInfo: { taskId: 'another-run', status: 2 } } }
  const pinned = await inspectLibTVVideoStatus({ ...node, upstreamTaskId: 'upstream-task', teamId: 42 })
  assert.equal(pinned.url, 'https://tv-res.newtake.cloud/completed.mp4', '已保存的任务ID不能被画布后续生成覆盖')
  projectMeta = undefined
  const unknownScope = await inspectLibTVVideoStatus({ ...node, upstreamTaskId: 'upstream-task' })
  assert.equal(unknownScope.state, 'unknown', '缺少原项目团队信息时不能猜当前活跃团队')
  assert.match(unknownScope.message!, /空间/u)
  expectedTeamId = undefined
  const personal = await inspectLibTVVideoStatus({ ...node, teamId: 0, upstreamTaskId: 'upstream-task' })
  assert.equal(personal.state, 'completed', '个人项目不发送凭据内的活跃团队')
  const before = networkCalls
  canvas = { data: { type: 'video', taskInfo: { status: 1 } } }
  assert.equal((await inspectLibTVVideoStatus(node)).state, 'pending')
  assert.equal(networkCalls, before, '没有上游任务ID时不猜测或重新生成')
  assert.ok(calls.every(args => args.join(' ') === 'node video-node --project 01322532-e5de-42a4-9549-5248fb705309'))
})

test('画布排队超时后即使前项释放也不会延迟提交或扣费', async t => {
  const previousProject = process.env.LIBTV_PROJECT_ID
  process.env.LIBTV_PROJECT_ID = '01322532-e5de-42a4-9549-5248fb705309'
  t.after(() => { if (previousProject === undefined) delete process.env.LIBTV_PROJECT_ID; else process.env.LIBTV_PROJECT_ID = previousProject })
  const { withLibTVCanvas, LibTVCliError } = await import('../src/services/libtv-cli.js')
  let release!: () => void
  let started!: () => void
  const firstStarted = new Promise<void>(resolve => { started = resolve })
  const first = withLibTVCanvas(async () => { started(); await new Promise<void>(resolve => { release = resolve }); return 'first' })
  await firstStarted
  let submissions = 0
  const second = withLibTVCanvas(async () => { submissions++; return 'second' }, 25)
  await assert.rejects(second, error => error instanceof LibTVCliError && error.reason === 'timeout' && /尚未提交生成/u.test(error.message))
  release()
  assert.equal(await first, 'first')
  assert.equal(await withLibTVCanvas(async () => 'third'), 'third')
  assert.equal(submissions, 0, '超时回调永不执行，避免稍后提交导致意外扣费')
})
