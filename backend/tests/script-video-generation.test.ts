import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import { createServer } from 'node:net'
import sharp from 'sharp'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { eq } from 'drizzle-orm'
import type { ScriptVideoGenerationInput } from '../src/services/script-video-generation.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-video-generation-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.HUOBAO_DATA_DIR = root
process.env.MYSQL_AUTO_IMPORT = 'false'
const ffmpegBin = process.env.FFMPEG_BIN || createRequire(import.meta.url)('ffmpeg-static') as string
process.env.FFMPEG_BIN = ffmpegBin
process.env.FFPROBE_BIN = createRequire(import.meta.url)('ffprobe-static').path
const { db, schema } = await import('../src/db/index.js')
const { startScriptVideoGeneration, getScriptVideoGeneration, getScriptVideoSubmissionPrompt, previewScriptVideoPrompt,
  prepareScriptVideoArchiveImages, prepareScriptVideoContinuations, prepareScriptVideoDeliveryReferences } = await import('../src/services/script-video-generation.js')
const { scriptVideoCapabilities } = await import('../src/services/script-video-capabilities.js')
const { getScriptVideoStylePreset, scriptVideoPromptStylePrefix } = await import('../src/services/script-video-style.js')
const { buildScriptVideoDelivery } = await import('../src/services/script-video-delivery.js')
const { getVideoPromptMode, setVideoPromptMode } = await import('../src/services/app-settings.js')

// Preserve the legacy layout expectations in this suite unless a test selects the guide.
setVideoPromptMode('inline')

const submissions: Array<{model: string; content: {text?: string; image_url?: {url: string}; audio_url?: {url: string}; role?: string}[]; ratio: string; duration: number; resolution: string}> = []
type AicostJsonSubmission = { model: string; prompt: string; seconds: number; aspect_ratio: string; resolution: string; images: string[]; audios: string[] }
const aicostSubmissions: Array<FormData | AicostJsonSubmission> = []
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
let polls = 0
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    if (req.headers.authorization !== 'Bearer test-only') {
      res.writeHead(401); res.end('unauthorized'); return
    }
    res.end(JSON.stringify({data: [{id: 'seedance2.5-2k'}]})); return
  }
  if (req.method === 'POST' && req.url === '/v1/videos') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.headers['content-type'] === 'application/json') {
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.model === 'seedance2.5-unavailable-720p') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'model_not_found', message: 'No available channel' } })); return
      }
      if (body.model === 'seedance2.5-ambiguous-720p') {
        res.writeHead(503); res.end('Gateway did not return a result'); return
      }
      if (body.model === 'seedance2.5-reset-after-upload-720p') {
        req.socket.destroy(); return
      }
      aicostSubmissions.push(body)
    } else {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': req.headers['content-type'] || '' } }).formData()
      aicostSubmissions.push(form)
    }
    res.end(JSON.stringify({id: 'aicost-accepted', status: 'queued'})); return
  }
  if (req.url === '/v1/videos/aicost-accepted') {
    res.end(JSON.stringify({status: 'SUCCESS', video_url: baseUrl + '/video.mp4', seconds: 30})); return
  }
  if (req.method === 'POST' && req.url === '/api/v3/contents/generations/tasks') {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    submissions.push(payload)
    if (payload.content[0].text.includes('服务端拒绝')) {
      res.writeHead(400); res.end('unsupported input'); return
    }
    res.end(JSON.stringify({id: 'accepted-1'})); return
  }
  if (req.url === '/api/v3/contents/generations/tasks/accepted-1') {
    polls++
    res.end(JSON.stringify({status: 'succeeded', content: {video_url: baseUrl + '/video.mp4'}})); return
  }
  if (req.url === '/video.mp4') { res.end(mp4); return }
  res.writeHead(404); res.end()
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.$client.close()
  await fs.rm(root, { recursive: true, force: true })
})

const model = 'doubao-seedance-2-0-fast'
const now = new Date().toISOString()
function createConfig(isActive: boolean, serviceType = 'video') {
  return db.insert(schema.aiServiceConfigs).values({ provider: 'volcengine', name: 'loopback', baseUrl,
    serviceType, apiKey: 'test-only', model: JSON.stringify(['doubao-seedance-2.0', model, 'doubao-seedance-2-5-260628', 'doubao-seedance-2-5-flash-261115', 'unsupported']),
    isActive, createdAt: now, updatedAt: now }).returning().get().id
}
const configId = createConfig(true)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64')
const png2 = Buffer.concat([png, Buffer.from('second')])
await fs.mkdir(path.join(root, 'static/uploads'), { recursive: true })
await fs.writeFile(path.join(root, 'static/uploads/a.png'), png)
await fs.writeFile(path.join(root, 'static/uploads/b.png'), png2)
const assets = [
  { id: 'a', name: '侍卫', image: '/static/uploads/a.png' },
  { id: 'b', name: '长剑', image: '/static/uploads/b.png' },
]

test('有未知、未绑定、歧义或丢失素材时可查看正文，仅有效文件参加编号', async () => {
  const catalog = [
    { ...assets[0], kind: 'character', voiceAudio: { url: '/static/uploads/missing.wav', name: '失效参考.wav' } },
    { ...assets[1], kind: 'prop' },
    { ...assets[0], id: 'broken', name: '营帐', kind: 'scene', image: '/static/uploads/missing.png' },
    { ...assets[0], id: 'flag', name: '旗帜', kind: 'prop' },
    { ...assets[0], id: 'red', name: '来客_红衣', kind: 'character' },
    { ...assets[1], id: 'blue', name: '来客_蓝衣', kind: 'character' },
  ]
  const card = { id: 'preview', duration: 4, assetIds: ['broken', 'deleted', 'a', 'b'],
    prompt: '镜头 01（0–4秒）\n画面与动作：@未知道具 在 @营帐 旁；@长剑 放在 @旗帜 边，@来客 站在帐外。\n对白／音效：侍卫：“小心！”',
    shots: [{ duration: 4, dialogue: '侍卫：“小心！”', visualAssetIds: ['broken', 'deleted', 'b'] }] }
  const args = { ...input, card, assets: catalog }
  const count = db.select().from(schema.sysTask).all().length
  const preview = await previewScriptVideoPrompt({ ...args, selection: args })
  assert.match(preview.prompt, /@未知道具/u)
  assert.match(preview.prompt, /@营帐/u)
  assert.match(preview.prompt, /@旗帜/u)
  assert.match(preview.prompt, /@来客/u)
  assert.ok(!preview.prompt.includes('undefined'))
  assert.deepEqual(preview.images.map(image => [image.index, image.name]), [[1, '侍卫'], [2, '长剑']])
  assert.deepEqual(preview.audios, [])
  for (const warning of ['未知道具', '来客', '旗帜', '营帐', 'deleted', '声音文件不存在']) {
    assert.ok(preview.warnings?.some(message => message.includes(warning)), warning)
  }
  await assert.rejects(() => startScriptVideoGeneration(args), /找不到素材|多个匹配|尚未绑定/u)
  assert.equal(db.select().from(schema.sysTask).all().length, count)
})
const input: ScriptVideoGenerationInput = {
  projectId: 'new-project', episodeId: 'new-episode', configId, model, aspectRatio: '9:16', resolution: '480p', assets,
  card: { id: 'new-card', duration: 5, shots: [{duration: 2}, {duration: 3}], assetIds: ['b','a'],
    prompt: '图1 = @长剑，图2 = @侍卫\n全段 5 秒\n@侍卫 挥动 @长剑，@侍卫 收剑。' },
}
async function finish(id: number) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = await getScriptVideoGeneration(id)
    if (state.status !== 'processing') return state
    await new Promise(resolve => setTimeout(resolve, 65))
  }
  throw new Error('Timed out waiting for the loopback provider')
}

test('a manual video uses free-form text without shots, while model limits and normal card checks still apply', async () => {
  const prompt = '全段 30 秒\n无人城门前的薄雾缓慢掠过。'
  const card = { ...input.card, assetIds: [], shots: [], prompt }
  const manual = { ...input, assets: [], card: { ...card, manuallyAdded: true as const } }
  const selection = { configId, model, aspectRatio: '9:16', resolution: '480p' }
  const before = submissions.length
  const final = await previewScriptVideoPrompt({ ...manual, selection })
  assert.equal(final.prompt, prompt)
  await assert.rejects(startScriptVideoGeneration({ ...manual, duration: 30 }), /单次最多/u)
  await assert.rejects(startScriptVideoGeneration({ ...manual, card }), /提示词和分镜脚本/u)
  assert.equal(submissions.length, before)
})

test('AICost 503 with model_not_found is a definite rejection, while a generic 503 remains unknown', async () => {
  const models = ['seedance2.5-unavailable-720p', 'seedance2.5-ambiguous-720p']
  const configId = db.insert(schema.aiServiceConfigs).values({ provider: 'aicost', name: 'mock rejection', baseUrl,
    serviceType: 'video', apiKey: 'test-only', model: JSON.stringify(models), isActive: true, createdAt: now, updatedAt: now }).returning().get().id
  const episode = { ...input, configId, resolution: '720p', assets: [], card: { ...input.card, assetIds: [], prompt: '全段 5 秒。山间云雾缓慢移动。' } }
  const rejected = await startScriptVideoGeneration({ ...episode, model: models[0] })
  const state = await finish(rejected.taskId)
  assert.equal(state.code, 'VIDEO_FAILED')
  assert.match(state.error || '', /没有可用渠道/)
  assert.equal(db.select().from(schema.sysTask).where(eq(schema.sysTask.id, rejected.taskId)).get()?.errorCode, 'submission_rejected')

  // Recreate the status written before the fix while keeping the recorded HTTP response.
  db.update(schema.sysTask).set({ errorCode: 'submission_unknown', errorMsg: 'API error 503' }).where(eq(schema.sysTask.id, rejected.taskId)).run()
  assert.deepEqual(await getScriptVideoGeneration(rejected.taskId), state)

  const ambiguous = await startScriptVideoGeneration({ ...episode, model: models[1] })
  assert.equal((await finish(ambiguous.taskId)).code, 'SUBMISSION_UNKNOWN')
})

test('AICost disconnect before TLS permits retry, while a disconnect after upload remains unknown', async t => {
  const abortTls = createServer(socket => socket.once('data', () => socket.destroy()))
  await new Promise<void>(resolve => abortTls.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => abortTls.close(() => resolve())))
  const createAicost = (model: string, apiUrl: string) => db.insert(schema.aiServiceConfigs).values({
    provider: 'aicost', name: 'mock connection failure', baseUrl: apiUrl, serviceType: 'video', apiKey: 'test-only',
    model: JSON.stringify([model]), isActive: true, createdAt: now, updatedAt: now,
  }).returning().get().id
  const episode = { ...input, resolution: '720p', assets: [],
    card: { ...input.card, assetIds: [], prompt: '全段 5 秒。山间云雾缓慢移动。' } }
  const model = 'seedance2.5-pre-tls-720p'
  const tlsUrl = `https://127.0.0.1:${(abortTls.address() as AddressInfo).port}`
  const unsent = await startScriptVideoGeneration({ ...episode, configId: createAicost(model, tlsUrl), model })
  const status = await finish(unsent.taskId)
  assert.equal(status.code, 'VIDEO_FAILED')
  assert.match(status.error || '', /请求未送达，可直接重试/u)
  const stored = () => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, unsent.taskId)).get()!
  assert.equal(stored().errorCode, 'submission_not_sent')

  // Older jobs saved a generic error. Only their original transport log can clear it.
  db.update(schema.sysTask).set({ errorCode: 'submission_unknown', errorMsg: 'fetch failed' })
    .where(eq(schema.sysTask.id, unsent.taskId)).run()
  assert.equal((await getScriptVideoGeneration(unsent.taskId, { reconcileRejection: false })).code, 'SUBMISSION_UNKNOWN')
  assert.deepEqual(await getScriptVideoGeneration(unsent.taskId), status)
  assert.equal(stored().errorCode, 'submission_not_sent')

  const receivedModel = 'seedance2.5-reset-after-upload-720p'
  const received = await startScriptVideoGeneration({ ...episode, configId: createAicost(receivedModel, baseUrl), model: receivedModel })
  assert.equal((await finish(received.taskId)).code, 'SUBMISSION_UNKNOWN')
})

test('按所选配置、模型、参考图和绑定序号提交，经服务商轮询、下载后提供本地视频', async () => {
  const submitted = await startScriptVideoGeneration(input)
  assert.equal(submitted.status, 'processing')
  const pending = await getScriptVideoGeneration(submitted.taskId)
  assert.equal(pending.videoUrl, undefined)
  const result = await finish(submitted.taskId)
  assert.equal(result.status, 'completed', result.error)
  assert.match(result.videoUrl!, /^\/static\/videos\/task-\d+\.mp4$/)
  assert.deepEqual(await fs.readFile(path.join(root, result.videoUrl!)), mp4)
  assert.equal(submissions.length, 1)
  assert.equal(polls, 1)
  const [body] = submissions
  assert.deepEqual([body.model, body.ratio, body.resolution, body.duration], [model, '9:16', '480p', 5])
  assert.equal(body.content[0].text, '全段 5 秒\n@图片2侍卫 挥动 @图片1长剑，@图片2侍卫 收剑。')
  assert.deepEqual(body.content.slice(1).map(item => item.image_url?.url), [png2, png].map(b => 'data:image/png;base64,' + b.toString('base64')))
  const record = db.select().from(schema.sysTask).where(eq(schema.sysTask.id, submitted.taskId)).get()!
  assert.deepEqual([record.configId, record.taskId, record.storyboardId, record.dramaId], [configId, 'accepted-1', null, null])
})

test('拒绝无效模型、时长、绑定或本地参考图，且不创建任务或向服务商提交', async () => {
  const before = db.select().from(schema.sysTask).all().length
  const priorSubmits = submissions.length
  const { card } = input
  const check = async (patch: Partial<ScriptVideoGenerationInput>, match: RegExp) => {
    await assert.rejects(startScriptVideoGeneration({...input, ...patch}), (e: any) => e?.code === 'VALIDATION' && match.test(e.message))
  }
  await check({configId: createConfig(false)}, /停用/)
  await check({configId: createConfig(true, 'image')}, /不是视频/)
  await check({model: 'not-configured'}, /不在/)
  await check({model: 'unsupported'}, /尚未配置/)
  await check({duration: 31}, /1–30 的整数秒/)
  await check({duration: 4.5}, /1–30 的整数秒/)
  await check({duration: 16}, /最多 15 秒/)
  await check({duration: 3}, /4–15 的整数秒/)
  await check({card: {...card, duration: 30, shots: [{duration: 30}], prompt: '全段 30 秒'}}, /最多 15 秒.*拆分/)
  await check({card: {...card, duration: 3, shots: [{duration: 3}], prompt: '全段 3 秒'}}, /整数秒/)
  await check({card: {...card, shots: [{duration: 3}]}}, /逐镜时长/)
  await check({card: {...card, prompt: '@侍卫_夜行服 出剑。'}}, /找不到素材 @侍卫_夜行服/)
  await check({card: {...card, assetIds: ['b']}}, /尚未绑定/)
  await check({assets: [{...assets[0], image: '/static/uploads/missing.png'}, assets[1]]}, /不存在/)
  await check({
    assets: [{ ...assets[0], kind: 'character' }, assets[1]],
    card: { ...card, prompt: '对白／音效：@侍卫（OS）：“天亮了。”' },
  }, /侍卫.*上传角色参考音频/u)
  assert.equal(db.select().from(schema.sysTask).all().length, before)
  assert.equal(submissions.length, priorSubmits)
})

test('提示词的文字时长与时码不阻断提交，实际请求使用结构中的时长', async () => {
  const submitted = await startScriptVideoGeneration({ ...input,
    card: { ...input.card, prompt: '全段 7 秒\n镜头 01（3–40秒）\n画面与动作：无人庭院里树影轻晃。', assetIds: [] },
  })
  await finish(submitted.taskId)
  const body = submissions.at(-1)!
  assert.equal(body.duration, 5)
  assert.match(body.content[0].text || '', /全段 7 秒/u)
})

test('服务商拒绝时保留实际失败状态，未生成播放地址', async () => {
  const submitted = await startScriptVideoGeneration({
    ...input,
    assets: [{ ...assets[0], kind: 'character', voiceMode: 'model' }, assets[1]],
    card: { ...input.card, prompt: '对白／音效：@侍卫（OS）：“服务端拒绝。”' },
  })
  const result = await finish(submitted.taskId)
  const lastSubmission = submissions.at(-1)!
  assert.match(lastSubmission.content[0].text!, /侍卫由模型生成音色/u)
  assert.equal(lastSubmission.content.some(item => item.audio_url), false)
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'VIDEO_FAILED')
  assert.equal(result.videoUrl, undefined)
  assert.match(result.error!, /unsupported input/)
})

test('发送旧原始风格快照时去掉标签与冗余空行并保留手改正文', async () => {
  const style = getScriptVideoStylePreset('cool')!
  const body = '←承上：@侍卫 开门\n\n\n手改正文'
  const submitted = await startScriptVideoGeneration({...input, stylePreset:style, card:{...input.card,prompt:style.prefix + '\n' + body}})
  const result = await finish(submitted.taskId)
  assert.equal(result.status, 'completed', result.error)
  const sent = submissions.at(-1)!.content[0].text!
  assert.ok(sent.startsWith(scriptVideoPromptStylePrefix(style)))
  assert.ok(!sent.startsWith('冷色调'))
  assert.ok(sent.endsWith('←承上：@图片2侍卫 开门\n\n\n手改正文'))
  assert.doesNotMatch(sent, /(?:\r?\n){3,}←承上/)
})

test('模型上限与工作流实际能力一致，不为未知模型推测时长', () => {
  assert.equal(scriptVideoCapabilities('volcengine', model)?.maxDuration, 15)
  assert.equal(scriptVideoCapabilities('minimax', 'MiniMax-H3')?.maxDuration, 15)
  assert.equal(scriptVideoCapabilities('aliyun', 'wan3.0-video-prime')?.maxDuration, 30)
  assert.equal(scriptVideoCapabilities('comfyui', 'wf-minimax-h3')?.maxReferences, 6)
  assert.equal(scriptVideoCapabilities('comfyui', 'wf-minimax-h3')?.maxAudioReferences, 0)
  assert.equal(scriptVideoCapabilities('volcengine', model)?.maxAudioDuration, 15)
  assert.equal(scriptVideoCapabilities('minimax', 'MiniMax-H3')?.maxTotalReferences, 12)
  assert.equal(scriptVideoCapabilities('comfyui', 'custom', { outputNode: '5', workflow: {input:'{{prompt}}'} }), null)
  assert.equal(scriptVideoCapabilities('comfyui', 'custom', { outputNode: '5', workflow: {input:'{{prompt}}', time:'{{frames}}'} })?.maxReferences, 0)
  assert.equal(scriptVideoCapabilities('unknown', model), null)
})

test('AICost 手工添加服务可只读测试，空模型配置不抢占默认视频模型', async () => {
  const { default: aiConfigs } = await import('../src/routes/aiConfigs.js')
  const { getActiveConfig, getActiveConfigId } = await import('../src/services/ai.js')
  const settings = { service_type: 'video', provider: 'aicost', base_url: baseUrl + '/v1', api_key: 'test-only', priority: 99 }
  const post = (route: string) => aiConfigs.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
  const probe = await post('/test')
  assert.equal(probe.status, 200)
  const probed = (await probe.json()).data
  assert.deepEqual([probed.ok, probed.method, probed.url, probed.response_preview], [true, 'GET', baseUrl + '/v1/models', ''])
  assert.equal(aicostSubmissions.length, 0)
  const created = await post('/')
  assert.equal(created.status, 201)
  assert.deepEqual((await created.json()).data.model, [])
  assert.equal((await getActiveConfig('video'))?.id, configId)
  assert.equal(await getActiveConfigId('video'), configId)
})

function wav(seconds: number): Buffer {
  const size = 8000 * 2 * seconds
  const buffer = Buffer.alloc(44 + size)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(size, 40)
  return buffer
}

test('火山方舟按原顺序发送公网角色图和音频，依资产去重，风格原文保持在首位', async () => {
  await fs.writeFile(path.join(root, 'static/uploads/voice.wav'), wav(3))
  await fs.writeFile(path.join(root, 'static/uploads/voice2.wav'), wav(4))
  process.env.PUBLIC_BASE_URL = 'https://media.example.test'
  const roleAssets = [
    {...assets[0], kind:'character', voiceAudio:{url:'/static/uploads/voice.wav',name:'声音.wav',duration:999}},
    {...assets[1], kind:'character', voiceAudio:{url:'/static/uploads/voice2.wav',name:'声音2.wav'}},
    {id:'c',name:'同音角色',image:'/static/uploads/a.png',kind:'character',voiceAudio:{url:'/static/uploads/voice.wav',name:'同音.wav'}},
    {id:'d',name:'未绑定',image:'/static/uploads/a.png',kind:'character',voiceAudio:{url:'/static/uploads/missing.wav',name:'未绑定.wav'}},
  ]
  const prompt = '冷色调\r\n\r\n画面与动作：@侍卫与@长剑、@同音角色对望。\n' +
    '对白／音效：@长剑：“到齐了吗？”；@侍卫：“到了。”；@同音角色：“我也在。”'
  const submitted = await startScriptVideoGeneration({...input, assets:roleAssets, card:{...input.card, assetIds:['b','a','c'], prompt}})
  const result = await finish(submitted.taskId)
  assert.equal(result.status, 'completed', result.error)
  const body = submissions.at(-1)!
  assert.ok(body.content[0].text!.startsWith('冷色调\r\n\r\n'))
  assert.match(body.content[0].text!, /@图片1长剑的对白音色参考音频1/)
  assert.match(body.content[0].text!, /@图片2侍卫的对白音色参考音频2/)
  assert.match(body.content[0].text!, /@图片2同音角色的对白音色参考音频2/)
  assert.deepEqual(body.content.filter(item => item.image_url).map(item => [item.image_url!.url, item.role]), [
    ['https://media.example.test/static/uploads/b.png', 'reference_image'],
    ['https://media.example.test/static/uploads/a.png', 'reference_image'],
  ])
  assert.deepEqual(body.content.filter(item => item.audio_url).map(item => [item.audio_url!.url,item.role]), [
    ['https://media.example.test/static/uploads/voice2.wav','reference_audio'],
    ['https://media.example.test/static/uploads/voice.wav','reference_audio'],
  ])
})

test('音频实际内容、时长、公网和路径不合规时拒绝提交且不创建计费任务', async () => {
  const before = db.select().from(schema.sysTask).all().length
  const prior = submissions.length
  const voiceInput = (url:string, duration?:number) => ({...input, assets:[{...assets[0],kind:'character',voiceAudio:{url,name:'声音.wav',duration}},assets[1]]})
  await fs.writeFile(path.join(root, 'static/uploads/short.wav'), wav(1))
  await fs.writeFile(path.join(root, 'static/uploads/long.wav'), wav(16))
  await fs.writeFile(path.join(root, 'static/uploads/eight.wav'), wav(8))
  await fs.writeFile(path.join(root, 'static/uploads/fake.wav'), Buffer.from('not audio'))
  for (const [url, pattern] of [['/static/uploads/short.wav',/2–15/], ['/static/uploads/long.wav',/2–15/], ['/static/uploads/fake.wav',/无法解析/], ['/static/uploads/missing.wav',/不存在/], ['/static/uploads/../voice.wav',/MP3 或 WAV/], ['/static/uploads/voice.m4a',/MP3 或 WAV/]] as const) {
    await assert.rejects(startScriptVideoGeneration(voiceInput(url, 3)), (error:any) => error.code === 'VALIDATION' && pattern.test(error.message))
  }
  const tooLong = {...input, assets:[
    {...assets[0],kind:'character',voiceAudio:{url:'/static/uploads/eight.wav',name:'一.wav'}},
    {...assets[1],kind:'character',voiceAudio:{url:'/static/uploads/eight2.wav',name:'二.wav'}},
  ]}
  await fs.writeFile(path.join(root, 'static/uploads/eight2.wav'), wav(8))
  await assert.rejects(startScriptVideoGeneration(tooLong), /总时长不超过 15 秒/)
  const comfy = db.insert(schema.aiServiceConfigs).values({provider:'comfyui',name:'comfy',baseUrl,serviceType:'video',apiKey:'',model:JSON.stringify(['wf-minimax-h3']),isActive:true,createdAt:now,updatedAt:now}).returning().get().id
  await assert.rejects(startScriptVideoGeneration({...voiceInput('/static/uploads/voice.wav'),configId:comfy,model:'wf-minimax-h3'}), /不支持声音参考/)
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000'
  await assert.rejects(startScriptVideoGeneration(voiceInput('/static/uploads/voice.wav')), /公网/)
  delete process.env.PUBLIC_BASE_URL
  await assert.rejects(startScriptVideoGeneration(voiceInput('/static/uploads/voice.wav')), /PUBLIC_BASE_URL/)
  assert.equal(db.select().from(schema.sysTask).all().length, before)
  assert.equal(submissions.length, prior)
})


test('项目内 Seedance 2.5 直出 30 秒：保留 4K、上传件不变、声音可本地内联，Flash 超规格在付费前拦截', async () => {
  const role = { id: 'role', name: '青衣', kind: 'character', image: '/static/uploads/seedance-role.jpg',
    voiceAudio: { url: '/static/uploads/seedance-role.wav', name: '角色声音.wav' } }
  const image = await sharp({ create: { width: 512, height: 720, channels: 3, background: '#abcdef' } }).jpeg().toBuffer()
  const voice = wav(17)
  await fs.writeFile(path.join(root, role.image), image)
  await fs.writeFile(path.join(root, role.voiceAudio.url), voice)
  delete process.env.PUBLIC_BASE_URL
  const episode = { ...input, model: 'doubao-seedance-2-5-260628', aspectRatio: '21:9', resolution: '4K', assets: [role],
    card: { ...input.card, duration: 30, assetIds: ['role'], prompt: '人物：@青衣\n镜头 01（0–30秒）\n对白／音效：青衣：“幸会。”',
      shots: [{ duration: 30, camera: '近景', action: '青衣抬头', dialogue: '青衣：“幸会。”' }] } }
  const before = submissions.length
  await assert.rejects(startScriptVideoGeneration({ ...episode, model: 'doubao-seedance-2-5-flash-261115' }), /分辨率/)
  const { taskId } = await startScriptVideoGeneration(episode)
  const status = await finish(taskId)
  assert.equal(status.status, 'completed', status.error)
  assert.equal(submissions.length, before + 1)
  const sent = submissions.at(-1)!
  const { buildScriptVideoDelivery } = await import('../src/services/script-video-delivery.js')
  const options = { provider: 'volcengine', model: episode.model }
  assert.equal(sent.content[0].text, buildScriptVideoDelivery(episode.card, episode.assets, options).prompt)
  const prepared = await prepareScriptVideoArchiveImages([episode.card], [...episode.assets, { ...role, id:'unused', name:'未用', image:'/static/missing.png' }], options, episode.resolution)
  assert.deepEqual(Object.keys(prepared), [role.image])
  const archiveImage = await fs.readFile(path.join(root, prepared[role.image]))
  assert.equal(sent.content.find(item => item.image_url)?.image_url?.url, 'data:image/jpeg;base64,' + archiveImage.toString('base64'))
  assert.deepEqual([sent.ratio, sent.duration, sent.resolution], ['21:9', 30, '4k'])
  assert.equal(sent.content.find(item => item.audio_url)?.audio_url?.url, 'data:audio/wav;base64,' + voice.toString('base64'))
  assert.deepEqual(await fs.readFile(path.join(root, role.image)), image)
  assert.match(sent.content.find(item => item.image_url)?.image_url?.url || '', /^data:image\/jpeg;base64,/u)
})

test('AICost 按 PUBLIC_BASE_URL 选择公网参考图与角色音频或本地内嵌，保留提示词和素材顺序', async (t) => {
  const previousPublicBase = process.env.PUBLIC_BASE_URL
  t.after(() => {
    if (previousPublicBase === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = previousPublicBase
  })
  const { buildScriptVideoDelivery } = await import('../src/services/script-video-delivery.js')
  const aicostModel = 'seedance2.5-ae-480p'
  const customModel = 'custom-gateway-id'
  const configId = db.insert(schema.aiServiceConfigs).values({ provider: 'aicost', name: 'AICost', baseUrl,
    serviceType: 'video', apiKey: 'test-only', model: JSON.stringify([aicostModel, customModel]),
    isActive: true, createdAt: now, updatedAt: now }).returning().get().id
  const voiceAudio = { url: '/static/uploads/aicost-voice.wav', name: '声音.wav' }
  const otherVoiceAudio = { url: '/static/uploads/aicost-voice-other.wav', name: '另一个声音.wav' }
  const voice = wav(3)
  const otherVoice = wav(4)
  await fs.writeFile(path.join(root, voiceAudio.url), voice)
  await fs.writeFile(path.join(root, otherVoiceAudio.url), otherVoice)
  delete process.env.PUBLIC_BASE_URL
  const applicableAssets = [{ ...assets[0], kind: 'character', voiceAudio, voiceMode: 'model' as const },
    { ...assets[1], name: '戍卒', kind: 'character', voiceAudio: otherVoiceAudio }]
  const dialogue = '侍卫：“我来守门。”；戍卒：“好。”'
  const card = { ...input.card, duration: 30, shots: [{ duration: 23 }, { duration: 3, dialogue }, { duration: 4 }],
    prompt: `镜头 01（0–23秒）\n画面与动作：侍卫和戍卒站在门边。\n镜头 02（23–26秒）\n对白／音效：${dialogue}\n镜头 03（26–30秒）\n画面与动作：二人继续守门。` }
  const episode = { ...input, configId, model: aicostModel, resolution: '480P', card, assets: applicableAssets }
  const priorTasks = db.select({ id: schema.sysTask.id }).from(schema.sysTask).all().length
  const priorSubmissions = aicostSubmissions.length
  const preview = await previewScriptVideoPrompt({ ...episode, selection: episode })
  assert.equal(db.select({ id: schema.sysTask.id }).from(schema.sysTask).all().length, priorTasks)
  assert.equal(aicostSubmissions.length, priorSubmissions)
  assert.deepEqual(preview.images.map(({ tag, name, url }) => [tag, name, url]), [
    ['@图片1', '侍卫', '/static/uploads/a.png'], ['@图片2', '戍卒', '/static/uploads/b.png'],
  ])
  assert.deepEqual(preview.audios.map(({ tag, name, url }) => [tag, name, url]), [
    ['@音频1', '侍卫', voiceAudio.url], ['@音频2', '戍卒', otherVoiceAudio.url],
  ])
  const withoutVoice = await previewScriptVideoPrompt({ ...episode, selection: episode,
    assets: [applicableAssets[0], { ...applicableAssets[1], voiceAudio: undefined, voiceMode: 'reference' }] })
  assert.deepEqual(withoutVoice.missingVoices, ['戍卒'])
  assert.equal(withoutVoice.audios.length, 1)
  const submitted = await startScriptVideoGeneration(episode)
  const result = await finish(submitted.taskId)
  assert.equal(result.status, 'completed', result.error)
  assert.deepEqual(await fs.readFile(path.join(root, result.videoUrl!)), mp4)
  assert.equal(aicostSubmissions.length, 1)
  const payload = aicostSubmissions[0]
  assert.ok(!(payload instanceof FormData))
  assert.deepEqual([payload.model, payload.seconds, payload.aspect_ratio, payload.resolution], [aicostModel, 30, '9:16', '480p'])
  const delivery = buildScriptVideoDelivery(card, applicableAssets, { model: aicostModel, provider: 'aicost' })
  assert.equal(payload.prompt, delivery.prompt)
  assert.equal(payload.prompt, preview.prompt)
  assert.match(payload.prompt, /^镜头02（23–26秒）$/mu)
  const persisted = getScriptVideoSubmissionPrompt(submitted.taskId, [], submitted.referenceNames)
  assert.deepEqual(persisted, { ...preview, source: 'submitted' })
  assert.match(delivery.prompt, /@图片1侍卫的对白音色参考@音频1/)
  assert.match(delivery.prompt, /@图片2戍卒的对白音色参考@音频2/)
  assert.deepEqual(payload.images, [png, png2].map(bytes => 'data:image/png;base64,' + bytes.toString('base64')))
  assert.deepEqual(payload.audios, [voice, otherVoice].map(bytes => 'data:audio/wav;base64,' + bytes.toString('base64')))
  assert.deepEqual([scriptVideoCapabilities('aicost', customModel)?.maxDuration, scriptVideoCapabilities('aicost', customModel)?.maxAudioReferences], [30, null])
  const custom = await startScriptVideoGeneration({ ...episode, model: customModel })
  assert.equal((await finish(custom.taskId)).status, 'completed')
  assert.equal(aicostSubmissions.length, 2)
  const form = aicostSubmissions[1]
  assert.ok(form instanceof FormData)
  assert.equal(form.get('model'), customModel)
  assert.equal(form.getAll('images').length, 2)
  assert.equal(form.getAll('audios').length, 2)

  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000'
  await assert.rejects(startScriptVideoGeneration(episode), /PUBLIC_BASE_URL.*公网/)
  assert.equal(aicostSubmissions.length, 2)

  process.env.PUBLIC_BASE_URL = 'https://media.example.test/'
  const hosted = await startScriptVideoGeneration(episode)
  assert.equal((await finish(hosted.taskId)).status, 'completed')
  assert.equal(aicostSubmissions.length, 3)
  const hostedPayload = aicostSubmissions[2]
  assert.ok(!(hostedPayload instanceof FormData))
  assert.deepEqual(hostedPayload, {
    ...payload,
    images: ['https://media.example.test/static/uploads/a.png', 'https://media.example.test/static/uploads/b.png'],
    audios: [voiceAudio, otherVoiceAudio].map(({url}) => `https://media.example.test${url}`),
  })

  const priorMode = getVideoPromptMode()
  t.after(() => setVideoPromptMode(priorMode))
  setVideoPromptMode('reference-guide')
  const prop = { id: 'blade', kind: 'prop', name: '绣春刀', image: '/static/uploads/aicost-blade.png' }
  await fs.writeFile(path.join(root, prop.image), png)
  const guidedEpisode = { ...episode, assets: [...applicableAssets, prop], card: { ...card, assetIds: [...card.assetIds, prop.id] } }
  const guidedPreview = await previewScriptVideoPrompt({ ...guidedEpisode, selection: guidedEpisode })
  assert.match(guidedPreview.prompt, /^参考素材：[\s\S]+@图片3 是 @绣春刀/u)
  const body = guidedPreview.prompt.split(/^镜头01/mu)[1]
  assert.doesNotMatch(body, /@图片\d/u)
  assert.match(body, /@戍卒 @音频2/u)
  const guided = await startScriptVideoGeneration(guidedEpisode)
  assert.equal((await finish(guided.taskId)).status, 'completed')
  const guidedPayload = aicostSubmissions.at(-1)!
  assert.ok(!(guidedPayload instanceof FormData))
  assert.equal(guidedPayload.prompt, guidedPreview.prompt)
  assert.deepEqual(guidedPayload.images, [...hostedPayload.images, 'https://media.example.test' + prop.image])
  assert.deepEqual(guidedPayload.audios, hostedPayload.audios)

  const inlineEpisode = { ...guidedEpisode, promptMode: 'inline' as const }
  const inlinePreview = await previewScriptVideoPrompt({ ...inlineEpisode, selection: inlineEpisode })
  const inline = await startScriptVideoGeneration(inlineEpisode)
  assert.equal((await finish(inline.taskId)).status, 'completed')
  const inlinePayload = aicostSubmissions.at(-1)!
  assert.ok(!(inlinePayload instanceof FormData))
  assert.equal(inlinePayload.prompt, inlinePreview.prompt)
  assert.doesNotMatch(inlinePayload.prompt, /参考素材：/u)
  assert.deepEqual(inlinePayload.images, hostedPayload.images)
  assert.deepEqual(inlinePayload.audios, hostedPayload.audios)
  assert.equal(getVideoPromptMode(), 'reference-guide')
  assert.equal(getScriptVideoSubmissionPrompt(guided.taskId, guidedEpisode.assets)?.prompt, guidedPreview.prompt)
})

test('黑屏尾帧回退至末镜稳定画面，按所选服务商协议提交同一张图', async (t) => {
  const priorBase = process.env.PUBLIC_BASE_URL
  const priorSigned = process.env.PUBLIC_MEDIA_SIGNED_URLS
  t.after(() => {
    if (priorBase === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = priorBase
    if (priorSigned === undefined) delete process.env.PUBLIC_MEDIA_SIGNED_URLS
    else process.env.PUBLIC_MEDIA_SIGNED_URLS = priorSigned
  })
  process.env.PUBLIC_BASE_URL = 'https://media.example.test'
  delete process.env.PUBLIC_MEDIA_SIGNED_URLS
  const source = { previousCardId: 'opening', previousTaskId: 91, videoUrl: '/static/videos/continuous.mp4',
    shotStartSeconds: 0.25, shotEndSeconds: 1 }
  const videos = path.join(root, 'static/videos')
  await fs.mkdir(videos, { recursive: true })
  execFileSync(ffmpegBin, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=480x854:r=24:d=1',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,0.75)'", '-c:v', 'libx264',
    path.join(videos, 'continuous.mp4')])
  const aicostModel = 'seedance2.5-ae-480p'
  const aicostId = db.insert(schema.aiServiceConfigs).values({ provider: 'aicost', name: 'continuation gateway', baseUrl,
    serviceType: 'video', apiKey: 'test-only', model: JSON.stringify([aicostModel]), isActive: true,
    createdAt: now, updatedAt: now }).returning().get().id
  const multi = { ...input, configId: aicostId, model: aicostModel, continuationSource: source }
  const onlyFrame = { ...input, model: 'doubao-seedance-2-5-260628', continuationSource: source,
    lightingRanges: [{ startShot: 1, endShot: 2, sceneName: '北廊', lighting: '廊下散射光', imageUrl: '/static/uploads/a.png' }],
    assets: [], card: { ...input.card, assetIds: [], shots: [{ duration: 2.5 }, { duration: 2.5 }],
      prompt: '全段 5 秒。继续原机位的动作。\n镜头 01（0–2.5秒）\n画面与动作：沿用原机位继续动作。\n镜头 02（2.5–5秒）\n画面与动作：动作结束。' } }
  const finalPrompt = await previewScriptVideoPrompt({ ...onlyFrame, selection: onlyFrame })
  assert.deepEqual(finalPrompt.images, [])
  const [multimodal, firstFrame] = await Promise.all([startScriptVideoGeneration(multi), startScriptVideoGeneration(onlyFrame)])
  assert.equal(multimodal.continuation?.mode, 'reference')
  assert.equal(firstFrame.continuation?.mode, 'first-frame')
  assert.deepEqual(firstFrame.lightingRanges, [{ startShot: 1, endShot: 2, sceneName: '北廊', lighting: '廊下散射光' }])
  const frame = multimodal.continuation!
  assert.equal(frame.imageUrl, firstFrame.continuation?.imageUrl)
  assert.equal(finalPrompt.firstFrame?.url, frame.imageUrl)
  assert.equal(frame.previousTaskId, source.previousTaskId)
  assert.equal((await sharp(path.join(root, frame.imageUrl)).metadata()).format, 'jpeg')
  assert.ok((await sharp(path.join(root, frame.imageUrl)).stats()).channels[0].mean > 30, 'uses an image before the black ending')
  const archive = await prepareScriptVideoContinuations([{ card: multi.card, source }], multi.assets, multi)
  assert.deepEqual(archive[multi.card.id], frame)
  const preview = await prepareScriptVideoDeliveryReferences([{ card: onlyFrame.card, source }], [], onlyFrame,
    { [onlyFrame.card.id]: onlyFrame.lightingRanges })
  assert.deepEqual(preview.lightingRanges[onlyFrame.card.id], firstFrame.lightingRanges)
  assert.deepEqual(preview.continuations[onlyFrame.card.id], firstFrame.continuation)
  const prop = { ...assets[0], kind: 'prop' }
  const guideCard = { ...onlyFrame.card, assetIds: [prop.id] }
  const guideOptions = { ...onlyFrame, promptMode: 'reference-guide' as const }
  const guide = await prepareScriptVideoContinuations([{ card: guideCard, source }], [prop], guideOptions)
  const followGlobal = await prepareScriptVideoContinuations([{ card: guideCard, source }], [prop], onlyFrame)
  assert.equal(guide[guideCard.id].mode, 'reference')
  assert.equal(followGlobal[guideCard.id].mode, 'first-frame')
  const archiveImages = await prepareScriptVideoArchiveImages([guideCard], [prop], guideOptions, onlyFrame.resolution)
  assert.deepEqual(Object.keys(archiveImages), [prop.image])
  assert.deepEqual(Object.keys(await prepareScriptVideoArchiveImages([guideCard], [prop], onlyFrame, onlyFrame.resolution)), [])
  assert.deepEqual((await Promise.all([finish(multimodal.taskId), finish(firstFrame.taskId)])).map(state => state.status), ['completed', 'completed'])
  assert.equal((await getScriptVideoGeneration(firstFrame.taskId)).finalShotRange, undefined)
  assert.equal((await getScriptVideoGeneration(firstFrame.taskId, { finalShotNumber: 1 })).finalShotRange, undefined)
  assert.deepEqual((await getScriptVideoGeneration(firstFrame.taskId, { finalShotNumber: 2 })).finalShotRange,
    { shotStartSeconds: 3, shotEndSeconds: 5 })
  assert.deepEqual((await getScriptVideoGeneration(firstFrame.taskId, { finalShotNumber: 'last' })).finalShotRange,
    { shotStartSeconds: 3, shotEndSeconds: 5 })
  const sent = aicostSubmissions.at(-1) as AicostJsonSubmission
  const native = submissions.at(-1)!
  assert.equal(sent.model, aicostModel)
  assert.equal(sent.prompt, buildScriptVideoDelivery(multi.card, multi.assets, { model: aicostModel, provider: 'aicost', continuation: frame }).prompt)
  assert.match(sent.prompt, /以@图片3作为本段首帧/u)
  assert.deepEqual(sent.images, ['/static/uploads/a.png', '/static/uploads/b.png', frame.imageUrl].map(url => 'https://media.example.test' + url))
  assert.equal(native.ratio, 'adaptive')
  assert.match(native.content[0].text!, /本次提交的首帧/u)
  assert.equal(native.content[0].text!, finalPrompt.prompt)
  assert.match(native.content[0].text!, /镜头1至2「北廊」：廊下散射光/u)
  assert.deepEqual(native.content.slice(1), [{ type: 'image_url', role: 'first_frame', image_url: { url: 'https://media.example.test' + frame.imageUrl } }])

  // A deliberately chosen lighting frame must accompany even a same-camera opening.
  const manual = { ...onlyFrame, continuationSource: { ...source, manualSeconds: 0.5 }, card: {
    ...onlyFrame.card, referenceFrameSettings: { lighting: { '1': { mode: 'manual' as const, videoUrl: source.videoUrl, seconds: 0.25 } } },
  } }
  const chosen = await previewScriptVideoPrompt({ ...manual, selection: onlyFrame })
  assert.equal(chosen.firstFrame, undefined)
  assert.equal(chosen.images.length, 2)
  assert.equal(chosen.images[1].url, onlyFrame.lightingRanges[0].imageUrl)
  assert.match(chosen.prompt, /从上一段成片手动选取的续接画面/u)
  const exportedManual = await prepareScriptVideoDeliveryReferences([{ card: manual.card, source: manual.continuationSource }],
    [], onlyFrame, { [manual.card.id]: manual.lightingRanges })
  assert.equal(exportedManual.continuations[manual.card.id].mode, 'reference')
  assert.deepEqual(exportedManual.lightingRanges[manual.card.id], manual.lightingRanges)
  const actualManual = await startScriptVideoGeneration(manual)
  assert.equal((await finish(actualManual.taskId)).status, 'completed')
  assert.deepEqual(actualManual.continuation, exportedManual.continuations[manual.card.id])
  assert.deepEqual(actualManual.lightingRanges, manual.lightingRanges)
  assert.deepEqual(submissions.at(-1)!.content.slice(1).map(item => item.role), ['reference_image', 'reference_image'])
})

test('供应商参考图不足时预览提示缺少的手选镜头，提交及导出均阻止静默降级', async () => {
  const sourceUrl = '/static/videos/earlier.mp4'
  const ranges = Array.from({ length: 11 }, (_, n) => ({ startShot: n + 1, endShot: n + 1,
    sceneName: '北廊', lighting: '廊下散射光', imageUrl: '/static/videos/light-' + n + '.jpg' }))
  const card = { ...input.card, assetIds: [], prompt: '北廊日景。', duration: ranges.length, shots: ranges.map(() => ({ duration: 1 })),
    referenceFrameSettings: { lighting: Object.fromEntries(ranges.map(range => [range.startShot,
      { mode: 'manual' as const, videoUrl: sourceUrl, seconds: range.startShot }])) } }
  // Seedance 2.0 allows nine images. No image should reach the provider.
  const options = { ...input, card, assets: [], lightingRanges: ranges }
  const preview = await previewScriptVideoPrompt({ ...options, selection: options })
  assert.ok(preview.warnings?.some(warning => /手选光线参考图.*镜头10.*镜头11/u.test(warning)))
  const rejected = /手选光线参考图.*镜头10.*镜头11/u
  await assert.rejects(startScriptVideoGeneration(options), rejected)
  await assert.rejects(prepareScriptVideoDeliveryReferences([{ card }], [], options), rejected)
  // Automatic ranges may fall back to their existing text to leave a slot for the manual choice.
  const onlyLast = { ...card, referenceFrameSettings: { lighting: { '11': card.referenceFrameSettings.lighting['11'] } } }
  const available = await prepareScriptVideoDeliveryReferences([{ card: onlyLast }], [], options)
  assert.equal(available.lightingRanges[card.id].at(-1)?.imageUrl, ranges[10].imageUrl)
})

test('同场换机位把本地影调帧传到 AICost 普通图片序列，返回实际提交快照', async t => {
  const priorBase = process.env.PUBLIC_BASE_URL
  delete process.env.PUBLIC_BASE_URL
  t.after(() => {
    if (priorBase === undefined) delete process.env.PUBLIC_BASE_URL
    else process.env.PUBLIC_BASE_URL = priorBase
  })
  const model = 'seedance2.5-ae-480p'
  const configId = db.insert(schema.aiServiceConfigs).values({ provider: 'aicost', name: 'lighting test', baseUrl,
    serviceType: 'video', apiKey: 'test-only', model: JSON.stringify([model]), isActive: true,
    createdAt: now, updatedAt: now }).returning().get().id
  const image = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#484555' } }).jpeg().toBuffer()
  await fs.mkdir(path.join(root, 'static/videos'), { recursive: true })
  const imageUrl = '/static/videos/lighting-court.jpg'
  await fs.writeFile(path.join(root, imageUrl), image)
  const lightingRanges = [{ startShot: 1, endShot: 1, sceneName: '北院', lighting: '廊下散射光', imageUrl }]
  const submitted = await startScriptVideoGeneration({ ...input, configId, model, lightingRanges })
  assert.deepEqual(submitted.lightingRanges, lightingRanges)
  assert.equal(submitted.continuation, undefined)
  assert.equal((await finish(submitted.taskId)).status, 'completed')
  const sent = aicostSubmissions.at(-1)
  assert.ok(sent instanceof FormData)
  const uploaded = sent.getAll('images') as File[]
  assert.deepEqual(await Promise.all(uploaded.map(async file => Buffer.from(await file.arrayBuffer()))), [png, png2, image])
  assert.match(String(sent.get('prompt')), /镜头1「北院」[^\n]+@图片3参考同场人物受光/u)
  assert.doesNotMatch(String(sent.get('prompt')), /作为本段首帧/u)
})

test('回顾和独立生成的人物参考随模型实际请求一起发送，台词保持原话', async () => {
  const recalled = { ...assets[1], id: 'recalled', name: '赵峰_微服便装', kind: 'character' }
  const catalog = [{ ...assets[0], kind: 'character', voiceMode: 'model' as const }, recalled]
  const card = {
    ...input.card,
    assetIds: ['a', 'recalled'],
    openingAssetIds: [],
    shots: [{ duration: 5, visualAssetIds: ['a'], speakerAssetIds: ['a'], dialogue: '侍卫：“赵峰，过来。”' }],
    prompt: [
      '前镜回顾：赵峰守在门外。',
      '独立生成：侍卫等候赵峰。',
      '镜头 01（0–5秒）',
      '画面与动作：侍卫抬手。',
      '对白／音效：侍卫：“赵峰，过来。”',
    ].join('\n'),
  }
  const submitted = await startScriptVideoGeneration({ ...input, assets: catalog, card })
  assert.equal((await finish(submitted.taskId)).status, 'completed')
  const sent = submissions.at(-1)!
  assert.match(sent.content[0].text!, /前镜回顾：@图片2赵峰守在门外。/u)
  assert.match(sent.content[0].text!, /独立生成：@图片1侍卫等候@图片2赵峰。/u)
  assert.match(sent.content[0].text!, /“赵峰，过来。”/u)
  assert.deepEqual(sent.content.slice(1).map(item => item.image_url?.url),
    [png, png2].map(data => 'data:image/png;base64,' + data.toString('base64')))
})
