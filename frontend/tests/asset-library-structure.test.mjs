import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
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
 assert.match(gallery,/await dramaAPI.get\(id\)/)
 for(const type of ['characters','scenes','props'])assert.ok(gallery.includes("key:'"+type+"'"))
 assert.match(gallery,/\?tab=assets/)
 assert.match(gallery,/thumbFallback/)
 assert.match(detail,/route.query.tab === 'assets'/)
 assert.match(detail,/definePageMeta\(\{ key: route => route.params.id/)
})
