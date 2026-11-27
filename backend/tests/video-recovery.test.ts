import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

// Isolated DB/storage; never read or modify user tasks/configurations.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-recovery-'))
process.env.SQLITE_PATH = path.join(root, 'tasks.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'
const { db, schema } = await import('../src/db/index.ts')
const { generateVideo, isGenerationTaskActive, recoverVideoTask, resumeInterruptedTasks, resumeRecoverableVideoTask } = await import('../src/services/generation.ts')
const tasksRoute = (await import('../src/routes/tasks.ts')).default
let submissionCount = 0, downloads = 0, recoveryCalls = 0, statusChecks = 0, available = false, brokenResponse = false
let lastStatusPath: string | undefined
const video = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.endsWith('/recover')) { recoveryCalls++; res.end('{}'); return }
  if (req.url?.startsWith('/v2/query/')) { statusChecks++; lastStatusPath = req.url; res.end(JSON.stringify({ task: { id:'upstream-1', status:'succeeded', duration:12, content:{url:base+'/content'} } })); return }
  if (req.url === '/expired') { res.writeHead(403).end(); return }
  if (req.method === 'POST' && brokenResponse) { submissionCount++; res.setHeader('X-Firemux-Task-Id','gateway-known'); res.end('{invalid'); return }
  if (req.method === 'POST') { submissionCount++; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ task: { id:'upstream-1', status:'succeeded', duration:12, content:{url:base+'/content'} } })); return }
  downloads++
  if (!available) { res.writeHead(404).end(); return }
  res.end(video)
})
await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const ts = new Date().toISOString()
const config = db.insert(schema.aiServiceConfigs).values({ serviceType:'video', provider:'minimax', name:'test', baseUrl:base, apiKey:'test-secret', model:'["MiniMax-H3"]', createdAt:ts, updatedAt:ts }).returning().get()
const sb = db.insert(schema.storyboards).values({ episodeId:1,storyboardNumber:1,createdAt:ts,updatedAt:ts }).returning().get()
const row = (id:number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id,id)).get()!
async function waitFor(id:number, status:string) {
  const deadline=Date.now()+15000
  while(Date.now()<deadline) { if(row(id).status===status) return row(id); await new Promise(r=>setTimeout(r,10)) }
  assert.fail(`Task ${id} did not reach ${status}: ${JSON.stringify(row(id))}`)
}

test('failed download preserves completed upstream result; concurrent recovery does not generate again', async () => {
  const attempts=await Promise.allSettled([0,1].map(()=>generateVideo({storyboardId:sb.id,prompt:'test',configId:config.id,duration:6})))
  assert.equal(attempts.filter(r=>r.status==='rejected').length,1)
  const id=(attempts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<number>).value
  const failed=await waitFor(id,'failed')
  assert.equal(failed.taskId,'upstream-1'); assert.equal(failed.resultUrl,base+'/content')
  assert.equal(failed.stage,'downloading'); assert.equal(failed.errorCode,'delivery_failed')
  assert.equal(failed.configId,config.id)
  assert.equal(submissionCount,1)
  const blocked=await tasksRoute.request('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'video',storyboard_id:sb.id,prompt:'again'})})
  assert.equal(blocked.status,400)
  available=true
  await Promise.all([recoverVideoTask(id),recoverVideoTask(id),recoverVideoTask(id)])
  const completed=await waitFor(id,'completed')
  assert.equal(completed.localPath,`static/videos/task-${id}.mp4`)
  assert.equal(submissionCount,1); assert.equal(downloads,2)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,sb.id)).get()!.duration,12)
  const diagnostics=await tasksRoute.request(`/${id}/diagnostics`)
  const data=await diagnostics.text()
  assert.doesNotMatch(data,/test-secret|127\.0\.0\.1|\/content/)
})

test('restart resumes persisted results, leaves unknown submissions for manual review, and does not overwrite newer videos',async()=>{
  const older=db.insert(schema.sysTask).values({type:'video',storyboardId:sb.id,provider:'minimax',resultUrl:base+'/content',status:'processing',params:'{"resultDuration":9}',createdAt:ts,updatedAt:ts}).returning().get()
  const latest=db.insert(schema.sysTask).values({type:'video',storyboardId:sb.id,status:'completed',createdAt:ts,updatedAt:ts}).returning().get()
  db.update(schema.storyboards).set({videoUrl:'static/videos/newer.mp4'}).where(eq(schema.storyboards.id,sb.id)).run()
  const unknown=db.insert(schema.sysTask).values({type:'video',status:'processing',createdAt:ts,updatedAt:ts}).returning().get()
  const preparing = db.insert(schema.sysTask).values({
    type: 'video', provider: 'minimax', configId: config.id, configBaseUrl: base,
    taskId: 'prepared-id', stage: 'preparing', status: 'processing', createdAt: ts, updatedAt: ts,
  }).returning().get()
  const previousQueries = statusChecks
  await resumeInterruptedTasks()
  await waitFor(older.id,'completed')
  assert.equal(row(unknown.id).errorCode,'submission_unknown')
  assert.equal(row(preparing.id).errorCode, 'submission_unknown')
  assert.equal(statusChecks, previousQueries)
  assert.equal(row(latest.id).status,'completed')
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id,sb.id)).get()!.videoUrl,'static/videos/newer.mp4')
  assert.equal(submissionCount,1)
  await assert.rejects(recoverVideoTask(unknown.id),/未保存上游任务编号/)
})

test('expired signed result is refreshed through the original task query without generating',async()=>{
  const task=db.insert(schema.sysTask).values({type:'video',provider:'minimax',configId:config.id,configBaseUrl:base,
    taskId:'upstream-1',resultUrl:base+'/expired',status:'failed',errorCode:'delivery_failed',createdAt:ts,updatedAt:ts}).returning().get()
  const before=submissionCount
  await recoverVideoTask(task.id)
  const done=await waitFor(task.id,'completed')
  assert.equal(done.resultUrl,base+'/content');assert.equal(submissionCount,before)
})

test('Firemux delivery recovery calls only its recovery endpoint and task query',async()=>{
  const task=db.insert(schema.sysTask).values({type:'video',provider:'minimax',configId:config.id,configBaseUrl:base,
    taskId:'upstream-1',status:'failed',errorCode:'delivery_failed',createdAt:ts,updatedAt:ts}).returning().get()
  const before=submissionCount
  await recoverVideoTask(task.id);await waitFor(task.id,'completed')
  assert.equal(recoveryCalls,1);assert.equal(submissionCount,before)
})

test('response header preserves recovery ID when response JSON is interrupted; changed configuration is rejected',async()=>{
  brokenResponse=true
  available = true
  const id=await generateVideo({prompt:'test',configId:config.id})
  const failed = await waitFor(id, 'failed')
  assert.equal(failed.taskId, 'gateway-known')
  assert.equal(failed.errorCode, 'submission_unknown')
  db.update(schema.aiServiceConfigs).set({baseUrl:'https://different.example'}).where(eq(schema.aiServiceConfigs.id,config.id)).run()
  await assert.rejects(recoverVideoTask(id),/原视频服务配置/)
  db.update(schema.aiServiceConfigs).set({baseUrl:base}).where(eq(schema.aiServiceConfigs.id,config.id)).run()
  const before = submissionCount
  db.update(schema.sysTask).set({ updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() }).where(eq(schema.sysTask.id, id)).run()
  await resumeRecoverableVideoTask(failed)
  assert.equal((await waitFor(id, 'completed')).taskId, 'gateway-known')
  assert.equal(lastStatusPath, '/v2/query/video_generation/gateway-known')
  assert.equal(submissionCount, before)
})

test('automatic recovery resumes overnight polling of the original video once and leaves confirmed failures alone', async () => {
  available = true
  const yesterday = new Date(Date.now() - 12 * 60 * 60_000).toISOString()
  const prior = {
    type: 'video', provider: 'minimax', configId: config.id, configBaseUrl: base,
    taskId: 'upstream-1', stage: 'polling', status: 'failed', createdAt: yesterday, updatedAt: yesterday,
  }
  const [timedOut, upstreamFailed, missingTask] = db.insert(schema.sysTask).values([
    { ...prior, errorMsg: 'Timeout: polling attempts exhausted' },
    { ...prior, errorCode: 'generation_failed', errorMsg: 'Provider confirmed failure' },
    { ...prior, taskId: null, errorCode: 'submission_unknown' },
  ]).returning().all()
  const previousQueries = statusChecks, previousSubmissions = submissionCount
  await Promise.all([resumeRecoverableVideoTask(timedOut), resumeRecoverableVideoTask(timedOut)])
  const completed = await waitFor(timedOut.id, 'completed')
  assert.equal(completed.taskId, 'upstream-1')
  assert.equal(completed.localPath, `static/videos/task-${timedOut.id}.mp4`)
  assert.equal((await resumeRecoverableVideoTask(upstreamFailed)).status, 'failed')
  assert.equal((await resumeRecoverableVideoTask(missingTask)).status, 'failed')
  assert.equal(statusChecks - previousQueries, 1)
  assert.equal(submissionCount, previousSubmissions)
})

test('status reads back off after the original provider configuration is unavailable', async () => {
  available = true
  const old = new Date(Date.now() - 3 * 60_000).toISOString()
  const task = db.insert(schema.sysTask).values({
    type: 'video', provider: 'minimax', configId: config.id, configBaseUrl: base,
    taskId: 'upstream-1', stage: 'polling', status: 'failed', errorCode: 'poll_timeout',
    createdAt: old, updatedAt: old,
  }).returning().get()
  const previousQueries = statusChecks, previousSubmissions = submissionCount

  db.update(schema.aiServiceConfigs).set({ isActive: false }).where(eq(schema.aiServiceConfigs.id, config.id)).run()
  try {
    const deferred = await resumeRecoverableVideoTask(task)
    assert.equal(deferred.status, 'failed')
    assert.equal(deferred.errorCode, 'recovery_failed')
    assert.notEqual(deferred.updatedAt, old)
  } finally {
    db.update(schema.aiServiceConfigs).set({ isActive: true }).where(eq(schema.aiServiceConfigs.id, config.id)).run()
  }

  assert.equal((await resumeRecoverableVideoTask(task)).status, 'failed')
  assert.equal(statusChecks, previousQueries)
  db.update(schema.sysTask).set({ updatedAt: old }).where(eq(schema.sysTask.id, task.id)).run()
  await resumeRecoverableVideoTask(task)
  await waitFor(task.id, 'completed')
  assert.equal(statusChecks - previousQueries, 1)
  assert.equal(submissionCount, previousSubmissions)
})

test('automatic recovery keeps tasks canceled or completed while retrieving the original provider configuration', async () => {
  const old = new Date(Date.now() - 3 * 60_000).toISOString()
  const previousQueries = statusChecks
  for (const status of ['canceled', 'completed']) {
    const task = db.insert(schema.sysTask).values({
      type: 'video', provider: 'minimax', configId: config.id, configBaseUrl: base,
      taskId: 'upstream-1', stage: 'polling', status: 'failed', errorCode: 'poll_timeout',
      createdAt: old, updatedAt: old,
    }).returning().get()
    const recovering = resumeRecoverableVideoTask(task)
    assert.equal(isGenerationTaskActive(task.id), true)
    db.update(schema.sysTask).set({ status, errorCode: null }).where(eq(schema.sysTask.id, task.id)).run()
    assert.equal((await recovering).status, status)
    assert.equal(isGenerationTaskActive(task.id), false)
  }
  assert.equal(statusChecks, previousQueries)
})

test.after(async()=>{
  await new Promise<void>(resolve=>server.close(()=>resolve()))
  db.$client.close() // Release Windows SQLite/WAL handles before removing this test's temp directory.
  await fs.rm(root,{recursive:true,force:true})
})
