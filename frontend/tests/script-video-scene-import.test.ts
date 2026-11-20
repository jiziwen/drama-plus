import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { readEpisodeFile, groupImportedEpisodes } from '../app/utils/scriptVideoPreviewEpisodes'
import { readScriptVideoZip } from '../app/utils/scriptVideoPreviewAssets'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const parsed = ts.createSourceFile('script-to-video.ts', parse(page).descriptor.scriptSetup!.content, ts.ScriptTarget.Latest)
const handlers = parsed.statements.filter(node => ts.isFunctionDeclaration(node) &&
  ['previewId', 'makeEpisode', 'importScript'].includes(node.name?.text || ''))
assert.equal(handlers.length, 3)
const {outputText} = ts.transpileModule(handlers.map(node => node.getText(parsed)).join('\n'), {
  compilerOptions: {target: ts.ScriptTarget.ES2022},
})
const firstChapter = '\n**场次**：1-01\n**3D场景**：无\n**【本场预计时长】**：120秒\n顾凌天站在院落北侧。'
const secondChapter = '顾凌天收起手枪。侍卫从院门退下。'
const sixthChapter = '\n**场次**：6-01\n**3D场景**：无\n**【本场预计时长】**：38秒\n众人移步书房。'
function file(name: string, body: string) {
  const entry = new File([body], name, {type: 'text/plain'})
  Object.defineProperty(entry, 'webkitRelativePath', {value: '卷一/' + name})
  return entry
}
function blank(confirmed = false) {
  return {
    id:'existing-episode', number:1, title:'未命名分集', script:confirmed ? '已经确认的原稿。' : '',
    confirmedScript:confirmed ? '已经确认的原稿。' : '', confirmed, outlineConfirmed:false, cards:[], busy:false,
    tasks:[{id:'old-job', cardId:'old-card', code:'SUBMISSION_UNKNOWN'}], selectedCardId:'',
    modelConfigId:3, modelName:'wf-minimax-h3', modelKey:'config:3:wf-minimax-h3', aspectRatio:'9:16', resolution:'1080P',
  }
}
async function importInto(episode: ReturnType<typeof blank>, files: File[], ownsEpisode = true) {
  const project = {id:'p', title:'剧集', episodeId:episode.id, episodes:[episode]}
  const reports: Record<string, {summary:string;details:string[];errors:string[]}> = {}
  const actions: string[] = []
  const context = {
    nextPreviewId: 0, currentProject:{value: project}, projects:{value:[project]}, importing:{value:false},
    episodeReports:{value:reports}, readEpisodeFile, groupImportedEpisodes, readScriptVideoZip, alive:true,
    episodeNavigationBusy: {value:false},
    episodeLock: {owns: (projectId: string, episodeId: string) => ownsEpisode && projectId === project.id && episodeId === episode.id},
    saveProjectNow: async (projectId: string) => { actions.push(`save:${projectId}`) },
    selectEpisode: async (episodeId: string) => { actions.push(`select:${episodeId}`) },
    toast:{info() {}, success() {}, error(message: string) { assert.fail(message) }},
  }
  const event = {target:{files, value:'selected'}}
  const importScript = runInNewContext(outputText + '\nimportScript', context)
  await importScript(event)
  assert.equal(context.importing.value, false)
  assert.equal(event.target.value, '')
  return {project, report:reports.p, actions}
}

test('批量导入把续章归入上一场，复用首个空白分集并保留模型与未决视频任务', async () => {
  const placeholder = blank()
  const oldTasks = placeholder.tasks
  const {project, report, actions} = await importInto(placeholder, [
    file('第3章.txt', sixthChapter), file('第2章.txt', secondChapter), file('第1章.txt', firstChapter),
  ])
  assert.deepEqual(Array.from(project.episodes, ep => ep.number), [1, 6])
  const [first, sixth] = project.episodes as any[]
  assert.equal(first, placeholder)
  assert.deepEqual(actions, ['save:p', `select:${placeholder.id}`])
  assert.equal(first.tasks, oldTasks)
  assert.deepEqual(first.tasks, [{id:'old-job',cardId:'old-card',code:'SUBMISSION_UNKNOWN'}])
  assert.deepEqual([first.modelConfigId, first.modelName, first.aspectRatio, first.resolution], [3, 'wf-minimax-h3','9:16','1080P'])
  assert.ok(first.script.includes(firstChapter))
  assert.ok(first.script.includes(secondChapter))
  assert.ok(!first.script.includes(sixthChapter))
  assert.deepEqual(Array.from(first.sourceChapters, (chapter:any) => [chapter.sourcePath, chapter.script]), [
    ['卷一/第1章.txt',firstChapter], ['卷一/第2章.txt',secondChapter],
  ])
  assert.deepEqual(Array.from(first.sceneEstimates, (item:any) => [item.sceneId, item.seconds]), [['1-01',120]])
  assert.equal(first.expectedDuration, 120)
  assert.equal(sixth.expectedDuration, 38)
  assert.match(report.summary, /3 份来源剧本按场次归为 2 集/)
  assert.doesNotMatch(report.summary, /120\s*秒/)
  assert.ok(report.details.some(detail => detail.includes('原文标注 120 秒（仅供查阅）')))
  assert.deepEqual(Array.from(report.errors), [])
})

test('已有同号正式分集保留原稿与任务，导入结果明确告知另建的新编号', async () => {
  const existing = blank(true)
  const {project,report} = await importInto(existing, [file('第1章.txt', firstChapter),file('第2章.txt', secondChapter)])
  assert.equal(existing.confirmedScript, '已经确认的原稿。')
  assert.equal(existing.confirmed, true)
  assert.equal(existing.tasks[0].code, 'SUBMISSION_UNKNOWN')
  assert.deepEqual(Array.from(project.episodes, item => item.number), [1,2])
  assert.notEqual(existing.id, project.episodes[1].id)
  assert.match(project.episodes[1].script, /顾凌天收起手枪/)
  assert.ok(report.details.some(text => text.includes('原第 1 集已存在，另建分集')))
})

test('未取得空白分集的占用时保留该分集，新建后保存并进入导入结果', async () => {
  const placeholder = blank()
  const {project, actions} = await importInto(placeholder, [file('第1章.txt', firstChapter)], false)
  assert.equal(project.episodes[0], placeholder)
  assert.equal(placeholder.script, '')
  assert.equal(placeholder.tasks[0].id, 'old-job')
  const added = project.episodes[1]!
  assert.equal(added.number, 2)
  assert.match(added.script, /顾凌天站在院落北侧/)
  assert.deepEqual(actions, ['save:p', `select:${added.id}`])
})
