import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkFisher, compileSourceGroup, sourceGroupNodes, workFisherModes, workFisherSource } from '../src/services/work-fisher.js'

const connection = { model: 'wf-image', baseUrl: 'http://127.0.0.1:8188', apiKey: '' }
const virtual = ['Note', 'MarkdownNote', 'Reroute', 'Fast Groups Bypasser (rgthree)', '忽略多组孤海']
for (const mode of Object.values(workFisherModes)) {
  test(`${mode.group}: every executable source node, widget and resolved edge is preserved`, () => {
    const graph = compileSourceGroup(mode.group)
    const selected = sourceGroupNodes(mode.group).filter(n => !virtual.includes(n.type))
    assert.deepEqual(Object.keys(graph).sort(), selected.map(n => String(n.id)).sort())
    const resolve = (linkId: number): any[] => {
      const link = workFisherSource.links.find((l: any[]) => l[0] === linkId)
      assert.ok(link, `missing source link ${linkId}`)
      const parent = workFisherSource.nodes.find((n: any) => n.id === link[1])
      return parent.type === 'Reroute' ? resolve(parent.inputs[0].link) : [String(parent.id), link[2]]
    }
    for (const node of selected) {
      assert.equal(graph[node.id].class_type, node.type)
      for (const input of node.inputs || []) {
        if (input.link != null) assert.deepEqual(graph[node.id].inputs[input.name], resolve(input.link), `${node.id}.${input.name}`)
        else if (input.widget && Object.hasOwn(node.widgets_values_named || {}, input.widget.name)) {
          assert.deepEqual(graph[node.id].inputs[input.name], node.widgets_values_named[input.widget.name], `${node.id}.${input.name}`)
        }
      }
    }
  })
}

test('character generation reaches the original SeedVR output, without an implicit 1MP cap', () => {
  const built = buildWorkFisher(connection, 'image', { prompt: '中文角色', size: '1920x1080' }, [], 42)
  assert.deepEqual([built.width, built.height], [1920, 1080])
  assert.equal(built.outputNode, '239')
  const path = [['239', 'images', '281'], ['281', 'anything', '280'], ['280', 'anything', '231'], ['231', 'image', '234'], ['234', 'image', '236']]
  for (const [node, input, upstream] of path) assert.deepEqual(built.workflow[node].inputs[input], [upstream, 0])
  assert.deepEqual(built.workflow['231'].inputs.resolution, ['237', 0])
  assert.equal(built.workflow['237'].inputs.value, 2560)
  assert.equal(built.workflow['233'].inputs.model, 'seedvr2_ema_7b-Q8_0.gguf')
  assert.equal(built.workflow['230'].inputs.encode_tiled, true)
  assert.equal(built.workflow['234'].inputs.megapixels, 0.30000000000000004)
  const canvas = built.canvasWorkflow
  assert.equal(canvas.nodes.find((n: any) => n.id === 231).mode, 0)
  assert.equal(canvas.nodes.find((n: any) => n.id === 251).widgets_values_named.value, 1920)
  assert.equal(canvas.nodes.find((n: any) => n.id === 248).widgets_values_named.text, '中文角色')
  assert.equal(canvas.nodes.find((n: any) => n.id === 261).mode, 4)
})

test('automatic scene selection uses the original separate scene group', () => {
  const built = buildWorkFisher(connection, 'image', { prompt: '雨夜', assetType: 'scene' }, [], 42)
  assert.equal(built.outputNode, '267')
  assert.equal(built.workflow['277'].inputs.text, '雨夜')
  assert.equal(built.workflow['261'].inputs.seed, 42)
  assert.ok(!built.workflow['235'])
  assert.deepEqual(built.workflow['267'].inputs.images, ['283', 0])
  assert.deepEqual([built.width, built.height], [1920, 1080])
})

test('opt-in character clarity changes only the two style strengths and exports identical overrides to the canvas', () => {
  const beforeSource = JSON.stringify(workFisherSource)
  const params = { prompt: '项目原三视图提示词：正脸特写、正面、侧面、背面', size: '1920x1080', assetType: 'character' as const }
  const original = buildWorkFisher(connection, 'image', params, [], 42)
  const disabled = buildWorkFisher({ ...connection, comfyui: { characterClarity: false } }, 'image', params, [], 42)
  const enabled = buildWorkFisher({ ...connection, comfyui: { characterClarity: true } }, 'image', params, [], 42)
  assert.deepEqual(disabled.workflow, original.workflow)
  const expected = structuredClone(original.workflow)
  expected['240'].inputs.strength_model = 0
  expected['249'].inputs.strength_model = 0
  assert.deepEqual(enabled.workflow, expected)
  assert.equal(enabled.outputNode, '239')
  for (const id of [240, 249]) {
    const node = enabled.canvasWorkflow.nodes.find((n: any) => n.id === id)
    assert.equal(node.widgets_values_named.strength_model, 0)
    assert.equal(node.widgets_values[1], 0)
  }
  assert.equal(JSON.stringify(workFisherSource), beforeSource)
  for (const assetType of ['scene', 'prop'] as const) {
    const base = buildWorkFisher(connection, 'image', { ...params, assetType }, [], 42)
    const clear = buildWorkFisher({ ...connection, comfyui: { characterClarity: true } }, 'image', { ...params, assetType }, [], 42)
    assert.deepEqual(clear.workflow, base.workflow)
  }
  const editBase = buildWorkFisher(connection, 'image', params, ['main.png'], 42)
  const editClear = buildWorkFisher({ ...connection, comfyui: { characterClarity: true } }, 'image', params, ['main.png'], 42)
  assert.deepEqual(editClear.workflow, editBase.workflow)
})

test('three-view switch and 1024 reference encoding survive; only caller references enter the request', () => {
  const built = buildWorkFisher(connection, 'image', { prompt: '三视图' }, ['a.png', 'b.png'], 42)
  assert.equal(built.workflow['206'].inputs.resolution, 1024)
  assert.deepEqual(built.workflow['211'].inputs.latent_image, ['207', 0])
  assert.equal(built.workflow['207'].inputs.switch, true)
  assert.deepEqual(built.workflow['207'].inputs.on_false, ['206', 2])
  assert.deepEqual(built.workflow['207'].inputs.on_true, ['209', 0])
  assert.deepEqual([built.width, built.height], [1920, 1088])
  assert.deepEqual(Object.values(built.workflow).filter(n => n.class_type === 'LoadImage').map(n => n.inputs.image), ['a.png', 'b.png'])
  const ids = new Set(built.canvasWorkflow.nodes.map((n: any) => String(n.id)))
  for (const link of built.canvasWorkflow.links) { assert.ok(ids.has(String(link[1]))); assert.ok(ids.has(String(link[3]))) }
  assert.throws(() => buildWorkFisher({ ...connection, model: 'wf-qwen-image' }, 'image', { prompt: '' }, [], 42), /需要至少一张/)
})

test('video retains the original selector, duration expression, cleanup, encoding and all reference positions', () => {
  const refs = Array.from({ length: 6 }, (_, i) => `${i}.png`)
  const built = buildWorkFisher({ ...connection, model: 'wf-minimax-h3' }, 'video', { prompt: '镜头', duration: 2 }, refs, 42)
  assert.deepEqual([built.width, built.height], [1056, 608])
  assert.equal(built.workflow['115'].inputs.megapixels, 0.6)
  assert.equal(built.workflow['156'].inputs.pix_fmt, 'yuv420p10le')
  assert.equal(built.workflow['156'].inputs.crf, 22)
  assert.equal(built.workflow['156'].inputs.save_metadata, true)
  assert.equal(built.duration, 2.333)
  for (let i = 0; i < refs.length; i++) assert.equal(built.workflow[built.workflow['136'].inputs[`ref_images.ref_image_${i}`][0]].inputs.image, refs[i])
  const textOnly = buildWorkFisher({ ...connection, model: 'wf-minimax-h3' }, 'video', { prompt: '' }, [], 42)
  assert.equal(Object.values(textOnly.workflow).filter(n => n.class_type === 'LoadImage').length, 0)
  assert.throws(() => buildWorkFisher({ ...connection, comfyui: { outputNode: '241' } }, 'image', { prompt: '' }, [], 42), /最终输出节点必须为 239/)
})

test('H3 translates bound project references to native one-based picture markers', () => {
  const prompt = '@图片1白墙，@图片2阿禾说：“等一下。” @图片1仍在画面中。<Picture 2> @图片3 @图片10 @图片0 @图片01 @原名'
  const expected = '<Picture 1>白墙，<Picture 2>阿禾说：“等一下。” <Picture 1>仍在画面中。<Picture 2> @图片3 @图片10 @图片0 @图片01 @原名'
  const config = { ...connection, model: 'wf-minimax-h3' }
  const built = buildWorkFisher(config, 'video', { prompt }, ['scene.png', 'character.png'], 42)
  assert.equal(built.workflow['138'].inputs.value, expected)
  assert.equal(built.canvasWorkflow.nodes.find((node: any) => node.id === 138).widgets_values_named.value, expected)
  const noReferences = buildWorkFisher(config, 'video', { prompt }, [], 42)
  assert.equal(noReferences.workflow['138'].inputs.value, prompt)
  const image = buildWorkFisher(connection, 'image', { prompt }, ['scene.png'], 42)
  assert.equal(image.workflow['214'].inputs.prompt, prompt)
})
