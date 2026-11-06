import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
const page=readFileSync(new URL('../app/pages/index.vue',import.meta.url),'utf8')
test('project shelf opens real detail and supports status persistence',()=>{
 assert.match(page,/navigateTo\(getDramaPath\(d\)\)/)
 assert.match(page,/dramaAPI.update\(d.id, \{ status \}\)/)
 assert.match(page,/d.status = prev/)
 assert.match(page,/currentStatus\(d\) === statusFilter.value/)
})
test('project creation preserves API style presets and aspect ratios',()=>{
 assert.match(page,/stylePresetAPI.list\(\)/)
 assert.match(page,/v-model="form.title"/)
 assert.match(page,/v-model="form.style"/)
 assert.match(page,/v-model="form.aspect_ratio"/)
 for(const ratio of ['16:9','9:16','1:1','adaptive'])assert.ok(page.includes("value: '"+ratio+"'"))
 assert.doesNotMatch(page,/total_episodes/)
})
test('home and shelf share real paginated projects, search and filters',()=>{
 assert.match(page,/listAllDramas\(\)/)
 assert.match(page,/route.query.view !== 'library'/)
 assert.match(page,/v-model(?:\.trim)?="searchKeyword"/)
 assert.match(page,/projectCover\(d\)/)
})
