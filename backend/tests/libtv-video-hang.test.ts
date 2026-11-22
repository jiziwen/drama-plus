import assert from 'node:assert/strict'
import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'

test('LibTV CLI挂起后通过原任务真实状态取回成片，恢复不再次生成', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'libtv-hang-regression-'))
  const before = { ...process.env }
  const cli = path.join(root, 'fixture-cli.cjs')
  Object.assign(process.env, { HUOBAO_DATA_DIR: root, SQLITE_PATH: path.join(root, 'tasks.sqlite3'),
    STORAGE_PATH: path.join(root, 'static'), VIDEO_CLI_ACCOUNTS_DIR: path.join(root, 'accounts'),
    LIBTV_CLI_BIN: cli, LIBTV_CONFIG_DIR: root, LIBTV_PROJECT_ID: '01322532-e5de-42a4-9549-5248fb705309', MYSQL_AUTO_IMPORT: 'false' })
  const originalExec = cp.execFile
  const originalFetch = globalThis.fetch
  let productionTimeout: number | undefined
  let closeDb: (() => void) | undefined
  cp.execFile = ((file: any, args: any, options: any, callback: any) => {
    if (file !== cli) return (originalExec as any)(file, args, options, callback)
    const run = args.includes('--run')
    if (run) productionTimeout = options.timeout
    return (originalExec as any)(process.execPath, [cli, ...args], { ...options, ...(run && { timeout: 150 }) }, callback)
  }) as typeof cp.execFile
  syncBuiltinESMExports()
  t.after(async () => {
    cp.execFile = originalExec; syncBuiltinESMExports(); globalThis.fetch = originalFetch
    closeDb?.()
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
    Object.assign(process.env, before)
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(path.join(root, 'credentials.json'), JSON.stringify({ usertoken: 'fixture-private-token', useruuid: 'fixture-user', webid: 'fixture-webid' }))
  await writeFile(cli, `const fs=require('node:fs');const path=require('node:path');const a=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'commands'),JSON.stringify(a)+'\\n');
if(a.includes('--run')){setInterval(()=>{},1000)}
else if(a[1]==='create')console.log(JSON.stringify({newNodeKey:'original-node'}));
else if(a[0]==='node')console.log(JSON.stringify({nodeKey:'original-node',data:{type:'video',url:[],taskInfo:{taskId:fs.existsSync(path.join(__dirname,'overwritten'))?'another-upstream':'original-upstream',status:1,progressPercent:5}}}));
else if(a[0]==='project')console.log(JSON.stringify({uuid:a[1],teamId:0}));`)
  let remoteStatus = 2
  let checks = 0
  const resultUrl = 'https://tv-res.newtake.cloud/fixture/video.mp4'
  globalThis.fetch = async (input, options) => {
    if (String(input) === resultUrl) return new Response(Buffer.from('0000000c667479706d703432', 'hex'))
    if (String(input).startsWith('https://api.liblib.tv/api/canvas/project/detail?')) {
      assert.equal(options?.method, 'GET')
      return Response.json({ code: 0, data: { projectMeta: { teamId: 0 } } })
    }
    assert.equal(String(input), 'https://api.liblib.tv/api/task/generation/progress')
    assert.deepEqual(JSON.parse(String(options?.body)).taskIds, ['original-upstream'])
    checks++
    return Response.json({ code: 0, data: { progresses: [{ taskId: 'original-upstream', status: remoteStatus,
      taskResult: remoteStatus === 2 ? JSON.stringify({ videos: [{ videoUrl: resultUrl }] }) : undefined, progressPercent: 25 }] } })
  }
  const { db, schema } = await import('../src/db/index.js'); closeDb = () => db.$client.close()
  const { generateVideo, recoverVideoTask, isGenerationTaskActive } = await import('../src/services/generation.js')
  const { getScriptVideoGeneration } = await import('../src/services/script-video-generation.js')
  const date = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({ provider: 'libtv', name: 'fixture', baseUrl: '', apiKey: '', serviceType: 'video',
    model: '["star-video2.5"]', isActive: true, createdAt: date, updatedAt: date }).returning().get()
  const params = { configId: config.id, model: 'star-video2.5', prompt: '固定机位观察云层', duration: 4, resolution: '480p', allowLibTV: true }
  const finished = async (id: number) => {
    for (let n = 0; n < 150 && isGenerationTaskActive(id); n++) await new Promise(r => setTimeout(r, 10))
    assert.equal(isGenerationTaskActive(id), false, '挂起的CLI应释放任务等待')
    return db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
  }
  const first = await finished(await generateVideo(params))
  assert.ok(Number.isFinite(productionTimeout) && productionTimeout! > 0, '生成CLI必须有有限时限')
  assert.equal(first.status, 'completed', first.errorMsg || '')
  assert.equal(checks, 1)
  remoteStatus = 1
  const waiting = await finished(await generateVideo(params))
  assert.equal(waiting.status, 'failed')
  const status = await getScriptVideoGeneration(waiting.id)
  assert.equal(status.canRecover, true)
  assert.match(status.error!, /查询原任务|尚未|排队|生成/u)
  assert.equal(JSON.parse(waiting.params!).libtv.upstreamTaskId, 'original-upstream')
  await writeFile(path.join(root, 'overwritten'), 'fixture-only')
  remoteStatus = 2
  await recoverVideoTask(waiting.id)
  assert.equal((await finished(waiting.id)).status, 'completed')
  const commands = (await readFile(path.join(root, 'commands'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(commands.filter(args => args.includes('--run')).length, 2, '两次生成各提交一次，恢复仅查询原任务')
})
