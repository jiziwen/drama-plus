import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { serve } from '@hono/node-server'

const root = await mkdtemp(path.join(os.tmpdir(), 'script-video-voice-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.DREAMINA_CANVAS_STATE_DIR = root
process.env.VIDEO_CLI_ACCOUNTS_DIR = path.join(root, 'accounts')
process.env.JIMENG_CLI_BIN = path.join(root, 'fake-dreamina-canvas')
process.env.LIBTV_CLI_BIN = path.join(root, 'fake-libtv')
const { ffmpegPath: ffmpeg, ffprobePath: ffprobe } = await import('../src/utils/ffmpeg.js')

const source = path.join(root, 'sound.mp4'), silent = path.join(root, 'silent.mp4')
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:size=32x32:rate=2', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'mpeg4', '-c:a', 'aac', source])
execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:size=32x32:rate=2', '-t', '1', '-c:v', 'mpeg4', silent])
const sound = await readFile(source)
await writeFile(process.env.LIBTV_CLI_BIN, String.raw`#!/usr/bin/env node
if (process.argv[2] !== 'model' || process.argv[3] !== 'star-video2-mini') process.exit(1);
console.log(JSON.stringify({modelKey:'star-video2-mini',modality:'video',schema:{modelKey:'star-video2-mini',properties:{resolution:{enum:['480p']},duration:{min:4,max:15,step:1},enableSound:{enum:['on','off']}},config:{generateTypes:{text:1}},rules:[{forModeTypes:['text2video'],require:['prompt']}]}}));
`, { mode: 0o700 })
await writeFile(process.env.JIMENG_CLI_BIN, String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), {randomUUID,createHash} = require('node:crypto');
const root = process.env.DREAMINA_CANVAS_STATE_DIR, args = process.argv.slice(5), cmd = args.slice(0,2).join(' ');
const file = name => path.join(root, name), flag = name => args.find(x => x.startsWith('--'+name+'='))?.slice(name.length+3);
const ok = data => console.log(JSON.stringify({ok:true,data}));
fs.appendFileSync(file('calls.jsonl'),JSON.stringify({cmd,args})+'\n');
const subject={kind:'personal',userId:'123'};
switch(cmd) {
case 'space current': ok(subject); break;
case 'canvas create': ok({project:{projectId:flag('project-id')}}); break;
case 'model ls': ok({items:[...(!fs.existsSync(file('no-mini'))?[{model:'seedance_2.0_mini',displayName:'Seedance 2.0 mini'}]:[]),{model:'seedance_2.5',displayName:'Seedance 2.5'}]}); break;
case 'node create': {
  const nodeId='node_'+randomUUID(), gen={model:flag('model'),mode:flag('mode'),prompt:flag('prompt'),durationSeconds:Number(flag('duration')),ratio:flag('ratio'),resolution:flag('resolution'),outputCount:Number(flag('count')),references:[]};
  fs.writeFileSync(file(nodeId+'.json'),JSON.stringify({nodeId,type:'video',generation:gen}));ok({node:{nodeId}});break;
}
case 'node show': {const node=JSON.parse(fs.readFileSync(file(flag('node-id')+'.json'),'utf8'));ok({nodes:[{result:'FOUND',node}]});break;}
case 'node quote': ok({consumptionSubject:subject,items:[{nodeId:flag('node-id'),maxCredits:0}],totalMaxCredits:0,confirmable:true,draftVersion:1});break;
case 'node confirm': ok({consumptionSubject:subject,creditCeiling:0,creditConfirmationToken:'fixture-token'});break;
case 'node run': {
  const node=JSON.parse(fs.readFileSync(file(flag('node-id')+'.json'),'utf8'));
  const submit=flag('submit-id');fs.writeFileSync(file(submit+'.json'),JSON.stringify({silent:node.generation.prompt.includes('无音轨测试')}));
  const finish=()=>ok({items:[{nodeId:flag('node-id'),submitId:submit,state:'ACCEPTED'}]});
  if(fs.existsSync(file('hold'))) {const timer=setInterval(()=>{if(!fs.existsSync(file('hold'))){clearInterval(timer);finish()}},20)} else finish();break;
}
case 'operation status': {const submit=args.at(-1),record=JSON.parse(fs.readFileSync(file(submit+'.json'),'utf8'));ok({state:'succeeded',resources:[{resourceId:record.silent?'resource_silent':'resource_sound',state:'succeeded'}]});break;}
case 'resource get': ok({resourceId:args.at(-1),type:'video',status:'succeeded',video:{durationSeconds:3}});break;
case 'resource download': {const id=args.at(-1),source=file(id==='resource_silent'?'silent.mp4':'sound.mp4'),buf=fs.readFileSync(source);fs.writeFileSync(flag('output'),buf);ok({resourceId:id,size:buf.length,sha256:createHash('sha256').update(buf).digest('hex')});break;}
default: console.error(JSON.stringify({ok:false,error:{code:2,message:'unsupported fixture command'}}));process.exitCode=2;
}
`, { mode: 0o700 })

const { db, schema } = await import('../src/db/index.js')
const { default: routes, scriptVideoStore: store } = await import('../src/routes/script-video.js')
const model = 'jimeng-seedance-2.0-mini'
const now = new Date().toISOString()
const configId = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'jimeng',
  name: '即梦测试账号', baseUrl: '', apiKey: '', model: JSON.stringify(['jimeng-seedance-2.5']),
  videoCliAccountId: 'default', isActive: true, createdAt: now, updatedAt: now }).returning().get().id
const project = await store.create('声音测试')
project.assets.push(...['success', 'silent', 'manual', 'saved'].map(id => ({ id, name: id, kind: 'character' as const, image: '/static/uploads/character.png' })))
project.assets.push({ id: 'prop', name: 'prop', kind: 'prop', image: '/static/uploads/prop.png' })
project.assets.push({ id: 'hero', name: '阿宁', kind: 'character', image: '/static/uploads/character.png' })
project.episodes[0].confirmedScript = '人物：阿宁\n声音：嗓音沙哑，说话慢'
await store.update(project.id, project, project.revision)
await store.mutateAssets(project.id, assets => ({ assets: assets.map(asset => {
  if (asset.id === 'saved') return { ...asset, voiceDescription: { text: '温暖自然的声线', sourceLabel: '第 1 集' } }
  if (asset.id === 'success') return { ...asset, voiceDescription: { text: '沉稳声音', sourceLabel: '第 2 集' } }
  if (asset.id === 'manual') return { ...asset, voiceDescription: { text: '原有声线', sourceLabel: '第 3 集' } }
  return asset
}), result: undefined }))
const server = serve({ fetch: routes.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
await once(server, 'listening')
const address = server.address()
assert.ok(address && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`

after(async () => {
  await rm(path.join(root, 'hold'), { force: true })
  await new Promise<void>(resolve => server.close(() => resolve()))
  await store.close()
  db.$client.close()
  await rm(root, { recursive: true, force: true })
})

const request = (asset: string, description = '沉稳声音', override: Record<string, unknown> = {}) => fetch(
  `${origin}/projects/${project.id}/assets/${asset}/voice-generation`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ configId, model, description, dialogue: '你好，欢迎来到这里。', ...override }),
  },
)
async function jobs() {
  const response = await fetch(`${origin}/projects/${project.id}/assets/voice-generations`)
  assert.equal(response.status, 200)
  return (await response.json() as any).data as any[]
}
async function waitForJob(id: number) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const found = (await jobs()).find(job => job.id === id)
    if (found && found.status !== 'processing') return found
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`voice task ${id} did not finish`)
}
async function calls() {
  return (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as { cmd: string; args: string[] }[]
}
async function describe(asset: string, episodeId?: string) {
  return fetch(`${origin}/projects/${project.id}/assets/${asset}/voice-description`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ episodeId }),
  })
}

test('offers the current official mini model even if the saved config only lists 2.5', async () => {
  const response = await fetch(`${origin}/projects/${project.id}/assets/voice-generation-models`)
  assert.equal(response.status, 200)
  const result = (await response.json() as any).data
  assert.ok(result.options.some((option: any) => option.configId === configId && option.model === model), 'mini must be selectable from the saved 2.5-only configuration')
})

test('offers LibTV mini after Jimeng, even when the LibTV config has higher priority', async () => {
  const libtvId = db.insert(schema.aiServiceConfigs).values({ serviceType: 'video', provider: 'libtv', name: 'LibTV',
    baseUrl: '', apiKey: '', model: JSON.stringify(['star-video2.5']), videoCliAccountId: 'default', isActive: true, priority: 100,
    createdAt: now, updatedAt: now }).returning().get().id
  try {
    const response = await fetch(`${origin}/projects/${project.id}/assets/voice-generation-models`)
    assert.equal(response.status, 200)
    const result = (await response.json() as any).data
    assert.deepEqual(result.options.map(({ configId, model, resolution }: any) => [configId, model, resolution]), [
      [configId, model, '720p'],
      [libtvId, 'star-video2-mini', '480p'],
    ])
  } finally {
    const { eq } = await import('drizzle-orm')
    db.delete(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, libtvId)).run()
  }
})

test('private endpoints reject cross-origin requests', async () => {
  const headers = { Origin: 'https://other.example.test', 'Sec-Fetch-Site': 'cross-site' }
  assert.equal((await fetch(`${origin}/projects/${project.id}/assets/voice-generation-models`, { headers })).status, 403)
  assert.equal((await fetch(`${origin}/projects/${project.id}/assets/success/voice-generation`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ configId, model, description: '普通', dialogue: '你好' }),
  })).status, 403)
})

test('reuses a saved character description without sending a generation request', async () => {
  const before = (await calls()).length
  const response = await describe('saved')
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual((await response.json() as any).data, { text: '温暖自然的声线', sourceLabel: '第 1 集' })
  assert.equal((await describe('prop')).status, 404)
  assert.equal((await calls()).length, before)
})

test('older clients saving a project without descriptions preserve server-owned values', async () => {
  const oldClientProject = await store.get(project.id)
  for (const asset of oldClientProject.assets) delete asset.voiceDescription
  const response = await fetch(`${origin}/projects/${project.id}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: oldClientProject, expectedRevision: oldClientProject.revision }),
  })
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual((await (await describe('saved')).json() as any).data, { text: '温暖自然的声线', sourceLabel: '第 1 集' })
})

test('extracts an explicit voice from the confirmed script and persists it without a paid call', async () => {
  const before = (await calls()).length
  const response = await describe('hero', project.episodes[0].id)
  assert.equal(response.status, 200, await response.clone().text())
  const description = { text: '嗓音沙哑，说话慢', sourceLabel: '第 1 集' }
  assert.deepEqual((await response.json() as any).data, description)
  assert.deepEqual((await store.summary(project.id)).assets.find(asset => asset.id === 'hero')?.voiceDescription, description)
  assert.deepEqual((await (await describe('hero')).json() as any).data, description)
  assert.equal((await calls()).length, before)
})

test('does not submit when the selected account no longer lists mini', async () => {
  await writeFile(path.join(root, 'no-mini'), '')
  try {
    const result = (await (await fetch(`${origin}/projects/${project.id}/assets/voice-generation-models`)).json() as any).data
    assert.deepEqual(result.options, [])
    const response = await request('success')
    assert.equal(response.status, 400)
    assert.match(await response.text(), /未提供 Seedance 2.0 Mini/)
    assert.ok(!(await calls()).some(call => call.cmd === 'node create'))
  } finally { await rm(path.join(root, 'no-mini'), { force: true }) }
})

test('generates a character voice using the exact mini model and prevents duplicate jobs', async t => {
  await writeFile(path.join(root, 'hold'), '')
  t.after(() => rm(path.join(root, 'hold'), { force: true }))
  const response = await request('success')
  assert.equal(response.status, 201, await response.clone().text())
  const { id } = (await response.json() as any).data
  assert.deepEqual((await (await describe('success')).json() as any).data, { text: '沉稳声音', sourceLabel: '第 2 集' })
  assert.equal((await jobs()).find(job => job.id === id)?.status, 'processing')
  assert.equal((await request('success')).status, 409)
  await rm(path.join(root, 'hold'))
  const job = await waitForJob(id)
  assert.equal(job.status, 'completed', job.error)
  assert.match(job.videoUrl, /^\/static\/videos\/jimeng-[\da-f-]+\.mp4$/)
  assert.deepEqual(await readFile(path.join(root, job.videoUrl.slice(1))), sound)
  const created = (await calls()).filter(call => call.cmd === 'node create')
  assert.equal(created.length, 1)
  assert.ok(created[0].args.includes('--model=seedance_2.0_mini'))
  assert.ok(created[0].args.includes('--resolution=720P'))
  assert.ok(created[0].args.includes('--duration=5'))
  const prompt = created[0].args.find(value => value.startsWith('--prompt='))?.slice('--prompt='.length)
  assert.ok(prompt, '必须把试音提示词发送给即梦')
  assert.match(prompt, /全程只拍浅灰色的吸音墙和桌上的一支无标识麦克风/u)
  assert.match(prompt, /画面中无人/u)
  assert.match(prompt, /(?:一位|一人|单一|只有一|仅一)/u)
  assert.match(prompt, /画外/u)
  assert.match(prompt, /人声/u)
  assert.match(prompt, /沉稳声音/u)
  assert.match(prompt, /你好，欢迎来到这里。/u)
  const asset = (await store.summary(project.id)).assets.find(item => item.id === 'success')!
  assert.deepEqual(asset.voiceAudio, job.voiceAudio)
  const mp3 = path.join(root, asset.voiceAudio!.url.replace(/^\//, ''))
  assert.ok((await stat(mp3)).size > 0)
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', mp3], { encoding: 'utf8' }))
  assert.equal(probe.streams[0].codec_name, 'mp3')
})

test('rejects invalid model or selection without dispatching', async () => {
  const before = (await calls()).length
  assert.equal((await request('success', '普通', { model: 'jimeng-seedance-2.5' })).status, 400)
  assert.equal((await request('success', '普通', { configId: 999999 })).status, 400)
  assert.equal((await request('absent')).status, 404)
  assert.equal((await calls()).length, before)
})

test('missing audio fails without setting an asset voice', async () => {
  const response = await request('silent', '无音轨测试')
  assert.equal(response.status, 201, await response.clone().text())
  const { id } = (await response.json() as any).data
  const job = await waitForJob(id)
  assert.equal(job.status, 'failed')
  assert.match(job.videoUrl, /^\/static\/videos\/jimeng-[\da-f-]+\.mp4$/)
  assert.match(job.error, /没有音频轨道/)
  assert.equal((await store.summary(project.id)).assets.find(item => item.id === 'silent')?.voiceAudio, undefined)
})

test('manual voice change made while generation runs is preserved', async t => {
  await writeFile(path.join(root, 'hold'), '')
  t.after(() => rm(path.join(root, 'hold'), { force: true }))
  const response = await request('manual')
  assert.equal(response.status, 201, await response.clone().text())
  const { id } = (await response.json() as any).data
  assert.deepEqual((await (await describe('manual')).json() as any).data, { text: '沉稳声音', sourceLabel: '手动编辑' })
  const manual = { url: '/static/uploads/manual.mp3', name: 'manual.mp3', mimeType: 'audio/mpeg' as const }
  await mkdir(path.join(root, 'static/uploads'), { recursive: true })
  await store.mutateAssets(project.id, assets => ({ assets: assets.map(asset => asset.id === 'manual' ? { ...asset, voiceAudio: manual } : asset), result: undefined }))
  await rm(path.join(root, 'hold'))
  const job = await waitForJob(id)
  assert.equal(job.status, 'failed')
  assert.match(job.error, /声音已更改/)
  assert.deepEqual((await store.summary(project.id)).assets.find(item => item.id === 'manual')?.voiceAudio, manual)
})
