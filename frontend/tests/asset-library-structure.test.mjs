import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {runInNewContext} from 'node:vm'
import {thumbOf} from '../app/composables/useMedia.ts'
const read=p=>readFileSync(new URL('../app/'+p,import.meta.url),'utf8')
const detail=read('views/drama/detail.vue'),gallery=read('pages/assets.vue')

test('stored image display resolves a thumbnail without rewriting the original path', () => {
  const path = 'static/uploads/一 张.PNG'
  const thumbnail = '/api/v1/storage/thumbnail?path=' + encodeURIComponent(path)
  assert.equal(thumbOf('/static/uploads/一%20张.PNG?v=4'), thumbnail)
  assert.equal(thumbOf(path), thumbnail)
  assert.equal(thumbOf(thumbnail), thumbnail)
  assert.equal(thumbOf('/static/uploads/existing_thumb.webp'), '/static/uploads/existing_thumb.webp')
  assert.equal(thumbOf('https://external.example/static/uploads/example.png'), 'https://external.example/static/uploads/example.png')
})
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
 assert.match(gallery, /:src="thumbOf\(imageOf\(asset\)\)"[^>]*loading="lazy"/)
 assert.match(gallery, /imagePreview\?\.open\(imageOf\(asset\), asset\.name/)
 assert.match(detail,/route.query.tab === 'assets'/)
 assert.match(detail,/definePageMeta\(\{ key: route => route.params.id/)
})

test('novel and downmarket cards defer originals until the reader opens them', () => {
  const novel = read('pages/novel-to-script.vue')
  const downmarket = read('components/DownmarketDramaAsset.vue')
  for (const page of [novel, downmarket]) {
    assert.match(page, /:src="thumbOf\(asset\.image\)"[^>]*loading="lazy"/)
  }
  assert.match(novel, /:href="asset\.image" target="_blank"/)
  assert.match(downmarket, /v-if="previewOpen && asset\.image" :src="asset\.image"/)
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
