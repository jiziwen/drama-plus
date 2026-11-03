import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const source = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))

function setup() {
  const agentRequests = [], promptRequests = [], errors = []
  const shot = { id: 21, duration: 7.5, video_model: 'shot-specific', video_config_id: 99 }
  const context = {
    chars: { value: [{ id: 1, name: '苏晚' }] }, scenes: { value: [{ id: 2, location: '冷宫', time: '夜' }] },
    propItems: { value: [{ id: 3, name: '灯' }] },
    effectiveVideoModelLabel: { value: 'Work-Fisher H3' }, selectedVideoConfig: { value: { id: 12, model: ['wf-minimax-h3'] } },
    videoModel: { value: 'comfyui:12/wf-minimax-h3' }, selectedSb: { value: shot },
    bareModelName: key => key.slice(key.indexOf('/') + 1), configModels: config => config?.model || [],
    dramaId: 4, epId: { value: 5 }, onBreakdownDone() {}, chatModelOverride: () => 'text-model', chatConfigId: () => 8,
    runAgent: (...args) => agentRequests.push(args),
    videoPromptGeneratingIds: { value: [] }, sbs: { value: [shot] },
    shotVideoConfig: () => ({ id: 99, name: 'shot config', provider: 'test' }), shotVideoModelLabel: () => 'shot-specific',
    getStoryboardCharacters: () => [{ name: '苏晚' }], getStoryboardProps: () => [{ name: '灯' }], getSceneName: () => '冷宫',
    api: { post: async (path, body) => { promptRequests.push({ path, body }) } },
    t: key => key, toast: { success() {} }, toastError: error => errors.push(error), refresh: async () => {},
  }
  runInNewContext(section('function doBreakdown()', '/** 拆分完成后') + section('async function genVideoPrompt(', 'function sleep('), context)
  return { context, shot, agentRequests, promptRequests, errors }
}

test('breakdown reads and saves directly, with compact storytelling guidance and the existing model label', () => {
  const { context, agentRequests } = setup()
  context.doBreakdown()
  assert.equal(agentRequests.length, 1)
  const [type, message, dramaId, episodeId, callback, textModel, textConfigId] = agentRequests[0]
  assert.equal(type, 'storyboard_breaker')
  assert.equal(dramaId, 4)
  assert.equal(episodeId, 5)
  assert.equal(callback, context.onBreakdownDone)
  assert.equal(textModel, 'text-model')
  assert.equal(textConfigId, 8)
  assert.equal(agentRequests[0].length, 7)
  assert.ok(message.indexOf('read_storyboard_context') < message.indexOf('save_storyboards'))
  assert.match(message, /合并重复反应与过渡/)
  assert.match(message, /本次视频模型：Work-Fisher H3/)
  assert.doesNotMatch(message, /plan_storyboard_timing|beat_id|budget_seconds|时长预算/)
  assert.match(message, /苏晚\(ID:1\)/)
  assert.doesNotMatch(message, /(?:60|150)\s*秒|8\s*[-–]\s*15|按\s*3\s*秒/)
})

test('breakdown keeps the existing text model request shape without sending timing configuration', () => {
  const { context, agentRequests } = setup()
  context.videoModel.value = ''
  context.doBreakdown()
  assert.equal(agentRequests[0].length, 7)
  assert.equal(agentRequests[0][5], 'text-model')
  assert.equal(agentRequests[0][6], 8)
})

test('regenerating one video prompt preserves its duration and requests a continuous variable timeline without replanning', async () => {
  const { context, shot, promptRequests, errors } = setup()
  const original = structuredClone(shot)
  await context.genVideoPrompt(shot)
  assert.deepEqual(shot, original)
  assert.equal(promptRequests.length, 1)
  assert.equal(promptRequests[0].path, '/agent/prompt_generator/chat')
  const body = promptRequests[0].body
  assert.equal(body.model, 'text-model')
  assert.equal(body.config_id, 8)
  assert.match(body.message, /时长 7\.5s/)
  assert.match(body.message, /视频模型:shot-specific/)
  assert.match(body.message, /贴合已有 duration/)
  assert.match(body.message, /参数只传 storyboard_id 和 video_prompt 两个键/)
  assert.doesNotMatch(body.message, /plan_storyboard_timing|beat_id|budget_seconds/)
  assert.doesNotMatch(body.message, /按\s*3\s*秒|8\s*[-–]\s*15/)
  assert.deepEqual(errors, [])
  assert.equal(context.videoPromptGeneratingIds.value.length, 0)
})
