import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
process.env.SQLITE_PATH = path.join(await mkdtemp(path.join(os.tmpdir(), 'huobao-comfy-unit-')), 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const { buildComfyWorkflow, validateComfySettings, parseComfyHistory, submitComfyWorkflow, pollComfyWorkflow, checkComfyWorkflow } = await import('../src/services/comfyui.js')

const config = { baseUrl: 'http://127.0.0.1:8188', apiKey: '', model: 'wf-image' }

test('Work-Fisher image chooses the correct branch and keeps text as data', () => {
  const text = 'quoted "prompt"\n{{seed}} 中文'
  const original = buildComfyWorkflow(config, 'image', { prompt: text, size: '1920x1080', seed: 42 })
  assert.equal(original.workflow['248'].inputs.text, text)
  assert.equal(original.workflow['235'].inputs.seed, 42)
  assert.equal(original.outputNode, '239')
  assert.deepEqual([original.width, original.height], [1920, 1080])
  const refs = buildComfyWorkflow(config, 'image', { prompt: 'edit' }, ['huobao/a.png', 'huobao/b.png'])
  assert.equal(refs.outputNode, '212')
  assert.deepEqual(refs.workflow['206'].inputs['images.image_1'], ['215', 0])
  assert.equal(refs.workflow[refs.workflow['206'].inputs['images.image_2'][0]].inputs.image, 'huobao/b.png')
  assert.equal(refs.workflow['215'].inputs.image, 'huobao/a.png')
  assert.equal(buildComfyWorkflow(config, 'image', { prompt: 'new' }).workflow['248'].inputs.text, 'new')
  assert.throws(() => buildComfyWorkflow({ ...config, model: 'wf-z-image' }, 'image', { prompt: 'x' }, ['a.png']), /不支持参考图/)
  assert.throws(() => buildComfyWorkflow(config, 'image', { prompt: 'x' }, Array(7).fill('a.png')), /最多支持/)
})

test('H3 preserves source model and sampler and aligns video frames to 17k+5', () => {
  const built = buildComfyWorkflow({ ...config, model: 'wf-minimax-h3' }, 'video', { prompt: 'pan', duration: 5, aspectRatio: '9:16', seed: 0 }, ['a.png'])
  assert.equal(built.workflow['157'].inputs.unet_name, 'minimax_h3_fl2va_int8_convrot.safetensors')
  assert.deepEqual(built.workflow['124'].inputs.steps, ['163', 0])
  assert.equal(built.workflow['163'].inputs.value, 12)
  assert.equal(built.workflow['129'].inputs.noise_seed, 0)
  assert.deepEqual(built.workflow['136'].inputs.length, ['131', 1])
  assert.equal(built.workflow['132'].inputs.value, 5)
  assert.equal(built.duration, 5.167)
  assert.deepEqual(built.workflow['136'].inputs['ref_images.ref_image_0'], ['137', 0])
  assert.ok(built.height > built.width)
  assert.equal(built.workflow['156'].inputs.format, 'video/h265-mp4')
  assert.deepEqual(built.workflow['156'].inputs.images, ['287', 0])
  assert.deepEqual(built.workflow['287'].inputs.anything, ['286', 0])
})

test('saved image sizes remain fixed while video sizes follow the project ratio at the selected pixel budget', () => {
  const comfyui = validateComfySettings({ width: 1536, height: 864, maxPixels: 213000 })
  const image = buildComfyWorkflow({ ...config, comfyui }, 'image', { prompt: '中文', size: '512x512' })
  assert.equal(image.width, 1536)
  assert.equal(image.height, 864)
  assert.equal(image.workflow['251'].inputs.value, 1536)
  assert.equal(image.workflow['252'].inputs.value, 864)
  const reference = buildComfyWorkflow({ ...config, comfyui }, 'image', { prompt: '中文' }, ['a.png'])
  assert.deepEqual([reference.width, reference.height], [1536, 864])
  assert.deepEqual(reference.workflow['209'].inputs.width, ['213', 0])
  const video = buildComfyWorkflow({ ...config, model: 'wf-minimax-h3', comfyui: { width: 480, height: 832 } }, 'video', { prompt: '中文', aspectRatio: '16:9' })
  assert.deepEqual([video.width, video.height], [832, 480])
  assert.deepEqual(video.workflow['136'].inputs.width, ['115', 0])
  for (const [aspectRatio, expected] of [['9:16', [480, 832]], ['16:9', [832, 480]], ['1:1', [640, 640]], ['4:3', [736, 544]]] as const) {
    const result = buildComfyWorkflow({ ...config, model: 'wf-minimax-h3', comfyui: { width: 832, height: 480 } }, 'video', { prompt: '中文', aspectRatio })
    assert.deepEqual([result.width, result.height], expected)
  }
  const auto = buildComfyWorkflow({ ...config, model: 'wf-minimax-h3' }, 'video', { prompt: '中文', aspectRatio: '16:9' })
  assert.deepEqual([auto.width, auto.height], [1056, 608])
  for (const invalid of [{ width: 1280 }, { height: 736 }, { width: 1280, height: 720 }, { width: 0, height: 32 }, { width: 8192, height: 32 }, { width: '1024', height: 1024 }]) {
    assert.throws(() => validateComfySettings(invalid), /32.*4096/)
  }
})

test('custom workflow validation rejects canvas JSON, invalid nodes and missing output', () => {
  assert.equal(validateComfySettings({ characterClarity: true }).characterClarity, true)
  assert.equal(validateComfySettings({ characterClarity: false }).characterClarity, false)
  for (const value of ['true', 1, null, {}]) assert.throws(() => validateComfySettings({ characterClarity: value }), /characterClarity.*布尔/)
  assert.throws(() => validateComfySettings({ workflow: { nodes: [] } }), /API 格式/)
  assert.throws(() => validateComfySettings({ timeoutMinutes: -1 }), /timeoutMinutes/)
  assert.throws(() => validateComfySettings({ workflow: { a: {} }, outputNode: 'a' }), /class_type/)
  const workflow = { a: { class_type: 'SaveImage', inputs: { prompt: '{{prompt}}', width: '{{width}}' } } }
  assert.throws(() => validateComfySettings({ workflow, outputNode: 'bad' }), /outputNode/)
  const comfyui = validateComfySettings({ workflow, outputNode: 'a', maxPixels: 262144 })
  const built = buildComfyWorkflow({ ...config, model: 'my-workflow', comfyui }, 'image', { prompt: 'portrait', size: '512x512' })
  assert.equal(built.workflow.a.inputs.prompt, 'portrait')
  assert.equal(built.workflow.a.inputs.width, 512)
})

test('history is task-specific, handles explicit errors and selects only the configured final output', () => {
  assert.equal(parseComfyHistory(config, {}, 'task', '9', 'image').status, 'processing')
  const result = parseComfyHistory(config, { task: { status: { completed: true }, outputs: {
    preview: { images: [{ filename: 'wrong.png' }] },
    '9': { gifs: [{ filename: 'movie-audio.mp4', subfolder: '中文 & / folder', type: 'output' }] },
  } } }, 'task', '9', 'video')
  assert.equal(result.status, 'completed')
  const url = new URL(result.url!)
  assert.equal(url.searchParams.get('subfolder'), '中文 & / folder')
  assert.equal(url.searchParams.get('filename'), 'movie-audio.mp4')
  const failure = parseComfyHistory(config, { task: { status: { status_str: 'error', messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]] } } }, 'task', '9', 'video')
  assert.equal(failure.status, 'failed')
  assert.match(failure.error!, /CUDA out of memory/)
  assert.equal(parseComfyHistory(config, { task: { status: { completed: true }, outputs: {} } }, 'task', '9', 'video').status, 'failed')
})

test('HTTP flow uploads references, persists the ID before submitting, polls without resubmission and surfaces node validation', async () => {
  const calls: string[] = []
  let submitted: any, savedId = '', reject = false
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    calls.push(`${req.method} ${req.url}`)
    assert.equal(req.headers.authorization, 'Bearer local-test')
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/upload/image') {
      assert.match(body, /name="image"/)
      res.end(JSON.stringify({ name: 'uploaded.png', subfolder: 'huobao' }))
    } else if (req.url === '/prompt') {
      submitted = JSON.parse(body)
      assert.equal(savedId, submitted.prompt_id)
      if (reject) { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid', node_errors: { '206': { errors: ['missing node'] } } })) }
      else res.end(JSON.stringify({ prompt_id: submitted.prompt_id }))
    } else if (req.url?.startsWith('/history/')) {
      res.end(JSON.stringify({ [savedId]: { status: { completed: true }, outputs: { '212': { images: [{ filename: 'result.png', type: 'output' }] } } } }))
    } else res.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const local = { ...config, apiKey: 'local-test', baseUrl: `http://127.0.0.1:${address.port}` }
  try {
    await assert.rejects(
      submitComfyWorkflow(local, 'image', { prompt: 'edit' }, ['static/images/huobao_missing_reference_unit_test.png'], async () => { assert.fail('missing reference must not prepare a task') }),
      { message: '参考图文件无法读取，请重新上传或选择历史图片' },
    )
    assert.equal(calls.filter(c => c === 'POST /prompt').length, 0)
    assert.equal(calls.filter(c => c === 'POST /upload/image').length, 0)
    const id = await submitComfyWorkflow(local, 'image', { prompt: 'edit' }, ['data:image/png;base64,aGVsbG8='], async id => { savedId = id })
    assert.equal(submitted.prompt['206'].inputs['images.image_1'][0], '215')
    assert.equal(submitted.prompt['215'].inputs.image, 'huobao/uploaded.png')
    assert.ok(submitted.extra_data.extra_pnginfo.workflow.nodes.some((n: any) => n.id === 231))
    assert.equal((await pollComfyWorkflow(local, id, '212', 'image')).status, 'completed')
    assert.equal(calls.filter(c => c === 'POST /prompt').length, 1)
    reject = true
    await assert.rejects(submitComfyWorkflow(local, 'image', { prompt: 'x' }, [], async id => { savedId = id }), /missing node/)
    await assert.rejects(checkComfyWorkflow(local, 'image'), /缺少/)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
