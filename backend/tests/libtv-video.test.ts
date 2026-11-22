import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'

test('LibTV keeps the original canvas node through referenced generation and recovery', async t => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'drama-libtv-'))
  const storage = path.join(root, 'static')
  const project = randomUUID()
  const cli = path.join(root, 'libtv')
  const log = path.join(root, 'commands.jsonl')
  const state = path.join(root, 'state')
  const variables = {
    SQLITE_PATH: path.join(root, 'test.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: storage,
    MYSQL_AUTO_IMPORT: 'false', LIBTV_PROJECT_ID: project, LIBTV_CLI_BIN: cli,
  }
  const old = Object.entries(variables).map(([key]) => [key, process.env[key]] as const)
  const originalFetch = globalThis.fetch
  let closeDatabase: (() => void) | undefined
  const url = 'https://libtv-res.liblib.art/test/clip.mp4'
  const video = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
  t.after(async () => {
    closeDatabase?.()
    for (const [key, value] of old) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = originalFetch
    await fs.rm(root, { recursive: true, force: true })
  })
  Object.assign(process.env, variables)
  globalThis.fetch = async input => {
    assert.equal(String(input), url, 'only download the result referenced by the original CLI node')
    return new Response(video as BodyInit, { headers: { 'content-type': 'video/mp4' } })
  }
  await fs.mkdir(path.join(storage, 'uploads'), { recursive: true })
  await fs.writeFile(path.join(storage, 'uploads/ref.png'), 'image fixture')
  await fs.writeFile(path.join(storage, 'uploads/voice.wav'), 'audio fixture')
  await fs.writeFile(state, 'success')
  await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = fs.readFileSync(path.join(__dirname, 'state'), 'utf8');
fs.appendFileSync(path.join(__dirname, 'commands.jsonl'), JSON.stringify(args) + '\\n');
const url = ${JSON.stringify(url)};
let payload;
if (args[0] === 'project') payload = {uuid: args[1]};
else if (args[0] === 'upload') payload = {nodeKey: args.includes('audio') ? 'voice-node' : 'image-node'};
else if (args[1] === 'create') payload = {newNodeKey: 'video-node'};
else if (args.includes('--run')) {
  if (state === 'success') payload = {status: 2, taskId: 'upstream-task', url: [url]};
  else if (state === 'rejected') payload = {status: 3, failedReason: '参考音频超过时长限制', code: 422};
  else if (state === 'network-denied') { console.error(JSON.stringify({error:{message:'账号并发额度已满', code:429}})); process.exitCode = 1; }
  else process.exitCode = 1;
}
else if (args[0] === 'node') payload = state === 'query-rejected'
  ? {status: 3, failedReason: '参考视频未通过平台审核'}
  : {nodeKey: args[1], data: {type: 'video', url: state === 'recoverable' ? [url] : []}};
if (payload) console.log(JSON.stringify(payload));
`, { mode: 0o700 })

  const { db, schema } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const { checkLibTVConnection, validateLibTVVideo } = await import('../src/services/libtv-cli.js')
  const { generateVideo, recoverVideoTask, isGenerationTaskActive } = await import('../src/services/generation.js')
  const timestamp = new Date().toISOString()
  const model = 'star-video2.5-flash'
  const configId = db.insert(schema.aiServiceConfigs).values({
    provider: 'libtv', name: 'test', baseUrl: '', apiKey: '', serviceType: 'video', model: JSON.stringify([model]),
    isActive: true, createdAt: timestamp, updatedAt: timestamp,
  }).returning().get().id
  const params = {
    model, configId, duration: 30, aspectRatio: '16:9', resolution: '720p',
    prompt: '画面参考 @图片1。对白音色参考 @音频1。',
    referenceImageUrls: ['/static/uploads/ref.png'],
    referenceAudioUrls: ['/static/uploads/voice.wav'],
  }
  await checkLibTVConnection()
  await assert.rejects(generateVideo(params), /私有站点/)
  assert.throws(() => validateLibTVVideo({ ...params, duration: 31 }), /4–30/)
  assert.throws(() => validateLibTVVideo({ ...params, model: 'star-video2.5-draft' }), /480p/)
  assert.throws(() => validateLibTVVideo({ ...params, referenceImageUrls: ['/static/uploads/../secret.png'] }), /先上传/)
  const waitForDone = async (id: number) => {
    for (let i = 0; i < 200 && isGenerationTaskActive(id); i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(isGenerationTaskActive(id), false)
    return db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
  }
  const first = await generateVideo({ ...params, allowLibTV: true })
  const completed = await waitForDone(first)
  assert.equal(completed.status, 'completed')
  assert.equal(completed.taskId, 'video-node')
  assert.deepEqual(await fs.readFile(path.join(root, completed.localPath!)), video)
  const commands = async (): Promise<string[][]> => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const calls = await commands()
  assert.deepEqual(calls[0], ['project', project])
  assert.deepEqual(calls[1].slice(2, 6), ['--project', project, '--type', 'image'])
  assert.deepEqual(calls[2].slice(2, 6), ['--project', project, '--type', 'audio'])
  assert.ok(calls[3].includes('model=Seedance 2.5 Flash'))
  assert.ok(calls[3].includes('duration=30'))
  assert.ok(calls[3].includes('--prompt=画面参考 @图片1{{Node image-node}}。对白音色参考 @音频1{{Node voice-node}}。'))
  assert.deepEqual(calls[4], ['node', 'video-node', '--project', project, '--run'])

  await fs.writeFile(state, 'ambiguous')
  const second = await generateVideo({ ...params, allowLibTV: true })
  const uncertain = await waitForDone(second)
  assert.equal(uncertain.errorCode, 'submission_unknown')
  assert.equal(uncertain.taskId, 'video-node')
  await fs.writeFile(state, 'recoverable')
  // Changing the setting must not change the recovered task's upstream canvas.
  process.env.LIBTV_PROJECT_ID = randomUUID()
  await recoverVideoTask(second)
  const recovered = await waitForDone(second)
  assert.equal(recovered.status, 'completed')
  assert.deepEqual(await fs.readFile(path.join(root, recovered.localPath!)), video)
  const recoveredCalls = await commands()
  assert.equal(recoveredCalls.filter(args => args.includes('--run')).length, 2)
  assert.deepEqual(recoveredCalls.at(-1), ['node', 'video-node', '--project', project])

  await fs.writeFile(state, 'rejected')
  const rejected = await waitForDone(await generateVideo({ ...params, allowLibTV: true }))
  assert.equal(rejected.errorCode, 'generation_failed')
  assert.match(rejected.errorMsg!, /参考音频超过时长限制/u)
  assert.match(rejected.errorMsg!, /422/u)

  await fs.writeFile(state, 'query-rejected')
  const queryRejected = await waitForDone(await generateVideo({ ...params, allowLibTV: true }))
  assert.equal(queryRejected.errorCode, 'generation_failed', '恢复查询发现平台终态失败，应正确归类')
  assert.match(queryRejected.errorMsg!, /参考视频未通过平台审核/u)

  await fs.writeFile(state, 'network-denied')
  const rateLimited = await waitForDone(await generateVideo({ ...params, allowLibTV: true }))
  assert.equal(rateLimited.errorCode, 'submission_unknown')
  assert.match(rateLimited.errorMsg!, /账号并发额度已满/u)
  assert.match(rateLimited.errorMsg!, /429/u)
})
