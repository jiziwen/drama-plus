import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { eq } from 'drizzle-orm'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huobao-comfyui-'))
process.env.SQLITE_PATH = path.join(root, 'test.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.MYSQL_AUTO_IMPORT = 'false'
process.env.FFMPEG_BIN = '/usr/bin/false'
process.env.FFPROBE_BIN = '/usr/bin/false'
const { db, schema } = await import('../src/db/index.js')
const { generateImage, generateVideo, resumeInterruptedTasks, recoverVideoTask } = await import('../src/services/generation.js')
const { default: configsRoute } = await import('../src/routes/aiConfigs.js')
const { default: tasksRoute } = await import('../src/routes/tasks.js')
let submits = 0, uploads = 0
const taskOutputs = new Map<string, string>()
const submittedVideoPrompts = new Map<string, string>()
const submittedVideoSizes = new Map<string, number[]>()
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64')
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
const server = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer local-key')
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk)
  if (req.url === '/upload/image') { uploads++; res.end('{"name":"ref.png","subfolder":"huobao"}'); return }
  if (req.url === '/prompt') {
    submits++
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const output = body.prompt['239'] ? '239' : Object.keys(body.prompt).find(id => ['SaveImage', 'VHS_VideoCombine'].includes(body.prompt[id].class_type))!
    taskOutputs.set(body.prompt_id, output)
    if (output === '156') submittedVideoPrompts.set(body.prompt_id, body.prompt['138'].inputs.value)
    if (output === '156') {
      const selector = body.prompt['115'].inputs
      const [w, h] = selector.aspect_ratio.split(' ')[0].split(':').map(Number)
      const scale = Math.sqrt(selector.megapixels * 1048576 / (w * h))
      submittedVideoSizes.set(body.prompt_id, [Math.round(w * scale / 32) * 32, Math.round(h * scale / 32) * 32])
    }
    res.end(JSON.stringify({ prompt_id: body.prompt_id })); return
  }
  if (req.url?.startsWith('/history/')) {
    const id = req.url.split('/').pop()!, output = taskOutputs.get(id) || '241'
    res.end(JSON.stringify({ [id]: { status: { completed: true }, outputs: { [output]: output === '156' ? { gifs: [{ filename: 'clip.mp4' }] } : { images: [{ filename: 'image.png' }] } } } })); return
  }
  res.end(req.url?.includes('clip.mp4') ? mp4 : png)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as any).port}`
const ts = new Date().toISOString()
const configIds: Record<string, number> = {}
for (const type of ['image', 'video']) {
  const row = db.insert(schema.aiServiceConfigs).values({ serviceType: type, provider: 'comfyui', name: type, baseUrl: base, apiKey: 'local-key',
    model: JSON.stringify(type === 'image' ? ['wf-image', 'wf-qwen-image'] : ['wf-minimax-h3']), settings: '{"comfyui":{"timeoutMinutes":1}}', createdAt: ts, updatedAt: ts }).returning().get()
  configIds[type] = row.id
}
const row = (id: number) => db.select().from(schema.sysTask).where(eq(schema.sysTask.id, id)).get()!
async function waitFor(id: number) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const task = row(id)
    if (task.status !== 'processing') { assert.equal(task.status, 'completed', task.errorMsg || 'failed'); return task }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('task did not finish')
}

test('ComfyUI image and reference video complete through sys_task and write back assets', async () => {
  const char = db.insert(schema.characters).values({ dramaId: 1, name: 'test', createdAt: ts, updatedAt: ts }).returning().get()
  const sb = db.insert(schema.storyboards).values({ episodeId: 1, storyboardNumber: 1, createdAt: ts, updatedAt: ts }).returning().get()
  const imageId = await generateImage({ prompt: 'portrait', characterId: char.id, configId: configIds.image })
  const image = await waitFor(imageId)
  assert.match(image.localPath!, /\.png$/)
  assert.ok(image.taskId)
  assert.equal(db.select().from(schema.characters).where(eq(schema.characters.id, char.id)).get()!.imageUrl, image.localPath)
  const videoId = await generateVideo({ prompt: 'move gently', storyboardId: sb.id, duration: 2, referenceImageUrls: [image.localPath!], configId: configIds.video })
  const video = await waitFor(videoId)
  assert.match(video.localPath!, /\.mp4$/)
  assert.equal(uploads, 1)
  assert.equal(submits, 2)
  const board = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, sb.id)).get()!
  assert.equal(board.videoUrl, video.localPath)
  assert.equal(board.duration, 2.333)
})

test('persisted image and video IDs resume without resubmitting a workflow', async () => {
  const image = db.insert(schema.sysTask).values({ type: 'image', provider: 'comfyui', configId: configIds.image, configBaseUrl: base, taskId: 'restart-image',
    status: 'processing', params: '{"comfyui":{"outputNode":"241"}}', createdAt: ts, updatedAt: ts }).returning().get()
  const video = db.insert(schema.sysTask).values({ type: 'video', provider: 'comfyui', configId: configIds.video, configBaseUrl: base, taskId: 'restart-video',
    status: 'failed', params: '{"comfyui":{"outputNode":"156","duration":2}}', createdAt: ts, updatedAt: ts }).returning().get()
  taskOutputs.set('restart-video', '156')
  const before = submits
  await resumeInterruptedTasks()
  await recoverVideoTask(video.id)
  await Promise.all([waitFor(image.id), waitFor(video.id)])
  assert.equal(submits, before)
})

test('three-view mode requires explicit reference input and never implicitly uses the current image', async () => {
  const char = db.insert(schema.characters).values({ dramaId: 1, name: '三视图参考', imageUrl: `data:image/png;base64,${png.toString('base64')}`, createdAt: ts, updatedAt: ts }).returning().get()
  const before = uploads
  await assert.rejects(generateImage({ prompt: '中文三视图', characterId: char.id, model: 'wf-qwen-image', configId: configIds.image }), /参考图/)
  const id = await generateImage({ prompt: '中文三视图', characterId: char.id, model: 'wf-qwen-image', referenceImages: [char.imageUrl!], configId: configIds.image })
  const task = await waitFor(id)
  assert.equal(uploads, before + 1)
  assert.equal(JSON.parse(task.params!).comfyui.outputNode, '212')
  assert.equal(JSON.parse(task.params!).comfyui.width, 1920)
  const missing = db.insert(schema.characters).values({ dramaId: 1, name: '缺少参考', createdAt: ts, updatedAt: ts }).returning().get()
  await assert.rejects(generateImage({ prompt: '', characterId: missing.id, model: 'wf-qwen-image', configId: configIds.image }), /参考图/)
})

test('five batch video requests preserve legacy English style and finish without a translation call', async () => {
  db.update(schema.aiServiceConfigs).set({ settings: '{"comfyui":{"width":832,"height":480,"timeoutMinutes":1}}' }).where(eq(schema.aiServiceConfigs.id, configIds.video)).run()
  const style = 'high-quality 3D CG animation still, modern game-engine cinematic render, semi-realistic stylized characters'
  db.insert(schema.stylePresets).values({ name: '既有英文风格', value: 'legacy-test', prompt: style, createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.dramas).values({ id: 33, title: '风格兼容验证', style: 'legacy-test', createdAt: ts, updatedAt: ts }).run()
  db.insert(schema.episodes).values({ id: 33, dramaId: 33, episodeNumber: 1, title: '兼容验证', videoConfigId: configIds.video, createdAt: ts, updatedAt: ts }).run()
  const boards = Array.from({ length: 7 }, (_, i) => db.insert(schema.storyboards).values({
    episodeId: 33, storyboardNumber: i + 1, videoPrompt: 'high-quality，柔和光线下，小猫慢慢抬头，镜头缓缓推近。', duration: 2,
    videoUrl: i < 2 ? `static/videos/existing-${i}.mp4` : null, createdAt: ts, updatedAt: ts,
  }).returning().get())
  const before = submits
  const responses = await Promise.all(boards.filter(board => !board.videoUrl).map(board => tasksRoute.request('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'video', storyboard_id: board.id, drama_id: 33, prompt: board.videoPrompt, duration: 2, aspect_ratio: '9:16' }),
  })))
  const payloads = await Promise.all(responses.map(response => response.json() as Promise<any>))
  responses.forEach((response, i) => assert.equal(response.status, 201, JSON.stringify(payloads[i])))
  const finished = await Promise.all(payloads.map(payload => waitFor(payload.data.id)))
  assert.equal(submits - before, 5)
  for (const task of finished) {
    assert.equal(task.prompt, `${style}，\n${boards[2].videoPrompt}`)
    assert.equal(submittedVideoPrompts.get(task.taskId!), task.prompt)
    assert.deepEqual(submittedVideoSizes.get(task.taskId!), [480, 832])
    assert.deepEqual([JSON.parse(task.params!).comfyui.width, JSON.parse(task.params!).comfyui.height], [480, 832])
  }
  for (const board of boards.slice(0, 2)) {
    assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, board.id)).get()!.videoUrl, board.videoUrl)
  }
  assert.equal(db.select().from(schema.apiCallLogs).where(eq(schema.apiCallLogs.category, 'text')).all().length, 0)
})

test('H3 scene references retain the selected project style and use their actual picture index', async () => {
  const style = db.select().from(schema.stylePresets).where(eq(schema.stylePresets.value, '3d')).get()!.prompt
  const drama = db.insert(schema.dramas).values({ title: '参考图风格验证', style: '3d', createdAt: ts, updatedAt: ts }).returning().get()
  const episode = db.insert(schema.episodes).values({ dramaId: drama.id, episodeNumber: 1, title: '参考图验证', videoConfigId: configIds.video, createdAt: ts, updatedAt: ts }).returning().get()
  const sceneUrl = 'static/uploads/scene.png'
  await fs.mkdir(path.join(root, 'static', 'uploads'), { recursive: true })
  await fs.writeFile(path.join(root, sceneUrl), png)
  const scene = db.insert(schema.scenes).values({ dramaId: drama.id, location: '墙边小路', time: '午后', prompt: '', imageUrl: sceneUrl, createdAt: ts, updatedAt: ts }).returning().get()
  const board = db.insert(schema.storyboards).values({ episodeId: episode.id, storyboardNumber: 1, sceneId: scene.id, createdAt: ts, updatedAt: ts }).returning().get()
  const prompt = '镜头沿 @图片2墙边小路向前。'
  const response = await tasksRoute.request('/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'video', storyboard_id: board.id, prompt, duration: 2,
      reference_image_urls: [`data:image/png;base64,${png.toString('base64')}`, `/${sceneUrl}`] }),
  })
  const payload = await response.json() as any
  assert.equal(response.status, 201, JSON.stringify(payload))
  const task = await waitFor(payload.data.id)
  const submitted = submittedVideoPrompts.get(task.taskId!)!
  assert.equal(submitted, `${style}，\n镜头沿 <Picture 2>墙边小路向前。`)
  assert.equal(db.select().from(schema.storyboards).where(eq(schema.storyboards.id, board.id)).get()!.videoPrompt, null)
})

test('configuration updates round-trip workflow options and reject canvas format', async () => {
  db.update(schema.aiServiceConfigs).set({ settings: '{"temperature":0.7}' }).where(eq(schema.aiServiceConfigs.id, configIds.image)).run()
  const update = await configsRoute.request(`/${configIds.image}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temperature: null, comfyui: { maxPixels: 262144, timeoutMinutes: 30 } }) })
  assert.equal(update.status, 200)
  const result = await (await configsRoute.request(`/${configIds.image}`)).json() as any
  assert.deepEqual(result.data.comfyui, { maxPixels: 262144, timeoutMinutes: 30 })
  assert.equal(result.data.temperature, null)
  const invalid = await configsRoute.request(`/${configIds.image}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comfyui: { workflow: { nodes: [] } } }) })
  assert.equal(invalid.status, 400)
})

after(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
