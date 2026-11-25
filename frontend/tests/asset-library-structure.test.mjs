import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
const read=p=>readFileSync(new URL('../app/'+p,import.meta.url),'utf8')
const detail=read('views/drama/detail.vue'),gallery=read('pages/assets.vue')
test('episode deletion keeps explicit confirmation and the original API',()=>{
 assert.match(detail,/@click="episodeToDelete = ep"/)
 assert.match(detail,/<ConfirmDialog/)
 assert.match(detail,/await episodeAPI.del\(ep.id\)/)
 assert.match(detail,/t\('detail.epDelete.message'/)
})
test('project status stays manual and rolls back failed saves',()=>{
 assert.match(detail,/function epStatus\(ep\) \{ return ep.status \|\| 'draft' \}/)
 assert.match(detail,/episodeAPI.update\(ep.id, \{ status \}\)/)
 assert.match(detail,/ep.status = prev/)
})
test('gallery uses persisted project detail and links to the full asset manager',()=>{
 assert.match(gallery,/listAllDramas\(\)/)
 assert.match(gallery,/await galleryAssetAPI.list\(id\)/)
 for(const type of ['characters','scenes','props'])assert.ok(gallery.includes("key: '"+type+"'"))
 assert.match(gallery,/\?tab=assets/)
 assert.match(gallery,/thumbFallback/)
 assert.match(detail,/route.query.tab === 'assets'/)
 assert.match(detail,/definePageMeta\(\{ key: route => route.params.id/)
})

test('画廊将取图中断显示为待取回，并提供原任务的取图按钮', () => {
  const start = gallery.indexOf('function assetStatus(')
  const end = gallery.indexOf('function messageOf(', start)
  const script = gallery.slice(start, end).replace('asset: GalleryAsset', 'asset')
  const assetStatus = runInNewContext(script + '\nassetStatus', {
    isRecovering: () => false,
    isGenerating: asset => asset.task?.status === 'processing',
  })
  assert.equal(assetStatus({ task: { status: 'processing', stage: 'downloading' } }), '已生成，取图中')
  assert.equal(assetStatus({ task: { status: 'delivery_pending', canRetryDelivery: true } }), '已生成，待取回')
  assert.equal(assetStatus({ task: { status: 'failed' } }), '生成失败')
  assert.match(gallery, /@click="retryImageDelivery\(asset\)"/)
  assert.match(gallery, /await taskAPI\.recover\(task\.id\)/)
})
