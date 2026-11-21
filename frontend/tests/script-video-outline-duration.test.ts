import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { getScriptVideoOutlineDurationIssues } from '../../backend/src/services/script-video-types'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const setupScript = parse(page).descriptor.scriptSetup!.content
const tree = ts.createSourceFile('script-to-video.ts', setupScript, ts.ScriptTarget.Latest)
const runHandlers = ['confirmOutline', 'runAI', 'monitorAIJob', 'textRequestOptions',
  'beginTextRun', 'finishTextRun', 'submitTextRun', 'monitorTextRun']
const handlers = tree.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return runHandlers.includes(node.name?.text || '')
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'defaultAgentPrompt')
})
assert.equal(handlers.length, runHandlers.length + 1)
const { outputText } = ts.transpileModule(handlers.map(node => node.getText(tree)).join('\n'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
})

async function confirm(durations: number[], versioned: boolean) {
  const episode = {
    id: 'episode-1', number: 1, script: '【本场预计时长】：120秒\n守卫开门。', expectedDuration: 120, outlineConfirmed: false, busy: false,
    cards: durations.map(duration => ({duration})),
    ...(versioned ? {outlineDurationPolicy: '30-except-tail-v1'} : {}),
  }
  const project = {id: 'project-1', episodes: [episode]}
  const requests: string[] = [], errors: string[] = [], prompts: string[] = []
  const context = {
    currentEpisode: {value: episode}, currentProject: {value: project}, projects: {value: [project]},
    getScriptVideoOutlineDurationIssues,
    textRuns: {value: {}}, reactive: (run: object) => run, AbortController, AbortSignal,
    busy: {value: false}, aiErrors: {value: {}}, aiProgress: {value: {}}, alive: true, requestController: new AbortController(),
    storyboardAction: {value: {body: {}}},
    textOptions: {value: []}, saveProjectNow: async () => {},
    waitScriptVideoJob: async () => ({result: {}}), refreshProject: async (pid: string, eid: string) => { requests.push('GET /projects/' + pid + '/episodes/' + eid) },
    scriptVideoRequest: async (path: string, method = 'GET', options?: {systemPrompt: string}) => {
      requests.push(method + ' ' + path)
      if (options) prompts.push(options.systemPrompt)
      return method === 'POST' ? {id: 'test-job'} : project
    },
    toast: {success: () => {}, error: (message: string) => errors.push(message)},
  }
  await runInNewContext(outputText + '\nconfirmOutline()', context)
  return {episode, requests, errors, prompts}
}

test('多个短前段属于可编辑的编排选择，允许确认并生成正文', async () => {
  const result = await confirm([24, 22, 26, 24, 24], true)
  assert.equal(result.episode.outlineConfirmed, true)
  assert.deepEqual(result.requests, ['POST /projects/project-1/episodes/episode-1/storyboard', 'GET /projects/project-1/episodes/episode-1'])
  assert.deepEqual(result.errors, [])
})

test('确认大纲后使用两分钟内保留主干、跨段后仍说不完自动延长的编排规则', async () => {
  for (const durations of [[30, 30, 30, 28], [30, 11], [30, 30, 30, 30, 30, 30, 29]]) {
    const result = await confirm(durations, true)
    assert.equal(result.episode.outlineConfirmed, true)
    assert.deepEqual(result.requests, ['POST /projects/project-1/episodes/episode-1/storyboard', 'GET /projects/project-1/episodes/episode-1'])
    assert.deepEqual(result.errors, [])
    assert.equal(result.prompts.length, 1)
    assert.match(result.prompts[0], /主干剧情优先排进 120 秒以内，通常安排 4 段/)
    assert.match(result.prompts[0], /删减次要动作/)
    assert.match(result.prompts[0], /按自然语速逐字保留原台词/)
    assert.match(result.prompts[0], /在自然停顿处跨段承接。全篇仍说不完时自动延长/)
    assert.match(result.prompts[0], /非尾段精确 30 秒，尾段按剧情收束/)
    assert.match(result.prompts[0], /原文中的预计时长不参与估算/)
  }
})

test('尾段为0或超过30秒时不确认、不发起生成请求', async () => {
  for (const tail of [0, 30.1]) {
    const result = await confirm([30, tail], true)
    assert.equal(result.episode.outlineConfirmed, false)
    assert.deepEqual(result.requests, [])
    assert.match(result.errors.join(' '), /第2段/)
  }
})

test('无新版时长标记的旧大纲可沿用原有短片段', async () => {
  const result = await confirm([24, 22, 26, 24, 24], false)
  assert.equal(result.episode.outlineConfirmed, true)
  assert.equal(result.requests[0], 'POST /projects/project-1/episodes/episode-1/storyboard')
  assert.deepEqual(result.errors, [])
})
