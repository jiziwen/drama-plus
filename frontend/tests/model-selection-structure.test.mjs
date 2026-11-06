import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
const read=p=>readFileSync(new URL('../app/'+p,import.meta.url),'utf8')
const page=read('views/drama/episode.vue')
test('generation settings retain all three model selectors',()=>{
 for(const model of ['chatModel','imageModel','videoModel'])assert.ok(page.includes('v-model="'+model+'"'))
 assert.match(page,/class="studio-model-disclosure"/)
 assert.match(page,/filter\(c => c.is_active\)/)
 assert.match(page,/collectModelOptions\(videoConfigs.value, lockedVideoConfigId.value\)/)
})
test('model popover retains config ownership and shared menu keyboard behavior',()=>{
 const component=read('components/ModelSelect.vue')
 assert.match(component,/<AppMenu v-model:open="isOpen"/)
 assert.match(component,/<AppMenuItem/)
 assert.match(component,/pick\(o.key \|\| o.model\)/)
 assert.match(component,/emit\('update:modelValue', model\)/)
 assert.match(component,/showConfig/)
})
test('generation still sends resolved text, asset and shot model selections',()=>{
 assert.match(page,/runAgent\('script_rewriter'[\s\S]*?chatModelOverride\(\), chatConfigId\(\)/)
 assert.match(page,/resolveAssetModel\(item, mode/)
 assert.match(page,/api.generateImage\(id, epId.value, selection.model, selection.configId, chatModelOverride\(\), chatConfigId\(\), options\)/)
 assert.match(page,/const selection = shotVideoSelection\(sb\)/)
})
