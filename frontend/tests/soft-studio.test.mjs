import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {projectCover,projectCounts} from '../app/utils/projectPresentation.ts'
import {dramaAPI,listAllDramas} from '../app/composables/useApi.ts'
const read=p=>readFileSync(new URL('../app/'+p,import.meta.url),'utf8')
test('project collection follows every API page without dropping later projects',async()=>{
 const original=dramaAPI.list,calls=[]
 try {
  dramaAPI.list=async(page=1)=>{calls.push(page);return {items:[{id:page}],pagination:{total_pages:3}}}
  assert.deepEqual((await listAllDramas()).map(p=>p.id),[1,2,3])
  assert.deepEqual(calls,[1,2,3])
 } finally { dramaAPI.list=original }
})
test('project cover resolves persisted assets and keeps empty projects empty',()=>{
 assert.equal(projectCover({}), '')
 assert.equal(projectCover({characters:[{image_url:'static/cat.webp'}]}),'/static/cat.webp')
 assert.equal(projectCover({characters:[{}],scenes:[{imageUrl:'https://example.com/scene.webp'}]}),'https://example.com/scene.webp')
 assert.equal(projectCover({props:[{localPath:'/static/prop.webp'}]}),'/static/prop.webp')
})
test('workspace totals reflect real collections including empty projects',()=>{
 assert.deepEqual(projectCounts([]),[0,0,0,0])
 assert.deepEqual(projectCounts([{}, {episodes:[{},{}],characters:[{}],scenes:[{},{},{}]}]),[2,2,1,3])
})
test('approved pastel theme includes light, dark, keyboard and reduced motion states',()=>{
 const css=read('assets/soft-studio.css')
 for(const token of ['soft-lime','soft-lavender','soft-pink','soft-cream'])assert.ok(css.includes('--'+token+':'))
 assert.ok(css.includes('data-theme="dark"'))
 assert.ok(css.includes(':focus-visible'))
 assert.ok(css.includes('prefers-reduced-motion:reduce'))
})
test('production navigation and shot editor retain keyboard and dialog semantics',()=>{
 const page=read('views/drama/episode.vue')
 assert.match(page,/aria-label="制作阶段"/)
 assert.match(page,/:aria-current="activeMainStage/)
 assert.match(page,/aria-label="镜头工作间"/)
 assert.match(page,/@keydown.esc.stop="closeShotEditor"/)
 assert.match(page,/@keydown.tab="trapShotFocus"/)
 assert.doesNotMatch(page,/class="sidebar|startColumnDrag|sidebarCollapsed/)
})
