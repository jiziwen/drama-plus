import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reactive } from 'vue'
import { mergeScriptVideoProject } from '../app/utils/scriptVideoStateMerge'
import type { ScriptVideoReferenceSettings } from '../../backend/src/services/script-video-reference-settings'

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

test('参考帧按单张合并，双端的不同参考图不会互相覆盖，同一帧选择保持完整', () => {
  const withSettings = (settings?: ScriptVideoReferenceSettings) => {
    const project = base()
    return Object.assign(project, { episodes: project.episodes.map(episode => ({ ...episode,
      cards: episode.cards.map(card => ({ ...card, ...(settings && { referenceFrameSettings: settings }) })),
    })) })
  }
  const manual = { mode: 'manual' as const, videoUrl: '/static/videos/a.mp4', seconds: 1 }
  const local = withSettings({ tail: { mode: 'off' } })
  const remote = withSettings({ lighting: { '1': manual } })
  const first = mergeScriptVideoProject(withSettings(), local, remote)
  assert.deepEqual(first.conflicts, [])
  assert.deepEqual(first.project.episodes[0]!.cards[0]!.referenceFrameSettings, { tail: { mode: 'off' }, lighting: { '1': manual } })

  const changed = mergeScriptVideoProject(withSettings({ tail: manual }), local,
    withSettings({ tail: { ...manual, videoUrl: '/static/videos/b.mp4', seconds: 2 } }))
  assert.ok(changed.conflicts.includes('episodes.e1.cards.a.referenceFrameSettings.tail'))
  assert.deepEqual(changed.project.episodes[0]!.cards[0]!.referenceFrameSettings, { tail: { mode: 'off' } })
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

test('合并跨页面首次新增的自定义风格，单个风格和所选风格按完整快照合并', () => {
  const ink = { id: 'custom-00000000-0000-4000-8000-000000000001', name: '水墨', prefix: '淡墨' }
  const clay = { id: 'custom-00000000-0000-4000-8000-000000000002', name: '黏土', prefix: '手作纹理' }
  const settings = (preset: typeof ink) => ({ stylePreset: preset, customStylePresets: { [preset.id]: preset } })
  const saved: ReturnType<typeof base> & { settings?: ReturnType<typeof settings> } = base()
  const both = mergeScriptVideoProject(saved, { ...saved, settings: settings(ink) }, { ...saved, settings: settings(clay) })
  assert.deepEqual(both.project.settings?.customStylePresets, { [ink.id]: ink, [clay.id]: clay })
  assert.deepEqual(both.project.settings?.stylePreset, ink)
  const renamed = { ...ink, name: '工笔水墨' }, repainted = { ...ink, prefix: '泼墨' }
  const conflict = mergeScriptVideoProject(
    { ...saved, settings: settings(ink) }, { ...saved, settings: settings(renamed) }, { ...saved, settings: settings(repainted) },
  )
  assert.deepEqual(conflict.project.settings, settings(renamed))
  assert.deepEqual(conflict.conflicts, ['settings.stylePreset', `settings.customStylePresets.${ink.id}`])
})

test('deletion concurrent with a content change is surfaced without discarding local intent', () => {
  const b=base(), l=structuredClone(b), r=structuredClone(b)
  l.episodes[0]!.cards=[]
  r.episodes[0]!.cards[0]!.prompt='远端更改'
  const result=mergeScriptVideoProject(b,l,r)
  assert.deepEqual(result.conflicts,['episodes.e1.cards.a'])
  assert.deepEqual(result.project.episodes[0]!.cards,[])
})

test('两个页面分别设置或清除不同片段的分辨率时保留双方修改', () => {
  const withResolutions = (videoResolutions?: Record<string, string>) => {
    const project = base()
    return { ...project, episodes: project.episodes.map(episode => ({
      ...episode, ...(episode.id === 'e1' && videoResolutions && { videoResolutions }),
    })) }
  }
  const both = mergeScriptVideoProject(withResolutions(), withResolutions({ a: '480P' }), withResolutions({ b: '1080P' }))
  assert.deepEqual(both.conflicts, [])
  assert.deepEqual(both.project.episodes[0]!.videoResolutions, { a: '480P', b: '1080P' })

  const cleared = mergeScriptVideoProject(withResolutions({ a: '480P' }), withResolutions(), withResolutions({ a: '480P', b: '720P' }))
  assert.deepEqual(cleared.conflicts, [])
  assert.deepEqual(cleared.project.episodes[0]!.videoResolutions, { b: '720P' })
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
