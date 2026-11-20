import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactive } from 'vue'
import { mergeScriptVideoProject } from '../app/utils/scriptVideoStateMerge'

const base = () => ({
  id:'p', revision:1, title:'剧目', episodeId:'e1', assets:[],
  episodes:[
    { id:'e1', title:'第一集', selectedCardId:'a', busy:false, tasks:[], cards:[{id:'a',prompt:'原提示词',version:1,status:'draft',videoUrl:undefined,shots:[],assetIds:[]}] },
    { id:'e2', title:'第二集', selectedCardId:'b', busy:false, tasks:[], cards:[{id:'b',prompt:'原文二',version:1,status:'draft',shots:[],assetIds:[]}] },
  ],
})

test('merges server video completion with local prompt edit and keeps remote metadata', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.episodes[0]!.cards[0]!.prompt='手工修改'
  r.revision=2; r.episodes[0]!.cards[0]!.status='ready'; r.episodes[0]!.cards[0]!.version=2; r.episodes[0]!.cards[0]!.videoUrl='/static/video.mp4'
  r.episodes[0]!.tasks=[{id:'t',status:'completed'}] as never[]
  const result=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(result.conflicts,[])
  assert.equal(result.project.episodes[0]!.cards[0]!.prompt,'手工修改')
  assert.equal(result.project.episodes[0]!.cards[0]!.status,'ready')
  assert.equal(result.project.episodes[0]!.cards[0]!.version,2)
  assert.equal(result.project.episodes[0]!.cards[0]!.videoUrl,'/static/video.mp4')
  assert.equal(result.project.episodes[0]!.tasks.length,1)
  assert.equal(result.project.revision,2)
})

test('merges AI update in one episode and local edits in another', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.episodes[1]!.cards[0]!.prompt='第二集本地修改'
  r.episodes[0]!.cards=[{id:'new',prompt:'AI 分镜',version:1,status:'draft',videoUrl:undefined,shots:[],assetIds:[]}]
  const merged=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(merged.conflicts,[])
  assert.equal(merged.project.episodes[0]!.cards[0]!.id,'new')
  assert.equal(merged.project.episodes[0]!.selectedCardId,'new')
  assert.equal(merged.project.episodes[1]!.cards[0]!.prompt,'第二集本地修改')
})

test('same field conflict is explicit and retains the local draft', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.episodes[0]!.cards[0]!.prompt='本地'
  r.episodes[0]!.cards[0]!.prompt='远端'
  const merged=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(merged.conflicts,['episodes.e1.cards.a.prompt'])
  assert.equal(merged.project.episodes[0]!.cards[0]!.prompt,'本地')
})

test('preserves local selections, busy state, additions and deletions', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.episodeId='e2'; l.episodes[0]!.busy=true; l.episodes[0]!.selectedCardId='local'
  l.episodes[0]!.cards=[]
  l.episodes[1]!.cards.push({id:'local',prompt:'新草稿',version:1,status:'draft',videoUrl:undefined,shots:[],assetIds:[]})
  r.episodeId='e1'; r.episodes[0]!.cards[0]!.status='ready'; r.episodes[0]!.cards[0]!.videoUrl='/static/video.mp4'
  const merged=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(merged.conflicts,[])
  assert.equal(merged.project.episodeId,'e2')
  assert.equal(merged.project.episodes[0]!.busy,true)
  assert.equal(merged.project.episodes[0]!.selectedCardId,'local')
  assert.deepEqual(merged.project.episodes[0]!.cards,[])
  assert.equal(merged.project.episodes[1]!.cards[1]!.id,'local')
})

test('deletion concurrent with a content change is surfaced without discarding local intent', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.episodes[0]!.cards=[]
  r.episodes[0]!.cards[0]!.prompt='远端更改'
  const result=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(result.conflicts,['episodes.e1.cards.a'])
  assert.deepEqual(result.project.episodes[0]!.cards,[])
})

test('independent new assets and episodes are retained without mutating inputs', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.assets.push({id:'a1',name:'本地'} as never)
  r.assets.push({id:'a2',name:'远端'} as never)
  l.episodes.push({id:'e3',title:'本地分集',cards:[],tasks:[],busy:false,selectedCardId:''})
  r.episodes.push({id:'e4',title:'远端分集',cards:[],tasks:[],busy:false,selectedCardId:''})
  const before=JSON.stringify([b,l,r]), result=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(result.conflicts,[])
  assert.deepEqual(new Set(result.project.assets.map((a:any)=>a.id)),new Set(['a1','a2']))
  assert.deepEqual(new Set(result.project.episodes.map(e=>e.id)),new Set(['e1','e2','e3','e4']))
  assert.equal(JSON.stringify([b,l,r]),before)
})


test('merges real Vue reactive projects including a proxy assetIds array', () => {
  const b = base(), l = reactive(structuredClone(b)), r = structuredClone(b)
  l.episodes[0]!.cards[0]!.assetIds.push('asset-1' as never)
  r.revision = 2
  const merged = mergeScriptVideoProject(b, l, r)
  assert.deepEqual(merged.conflicts, [])
  assert.deepEqual(merged.project.episodes[0]!.cards[0]!.assetIds, ['asset-1'])
  assert.equal(merged.project.revision, 2)
  assert.deepEqual(b.episodes[0]!.cards[0]!.assetIds, [])
})
