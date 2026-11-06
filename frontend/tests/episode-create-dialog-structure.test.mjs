import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
const page=readFileSync(new URL('../app/views/drama/detail.vue',import.meta.url),'utf8')
test('episode creation retains title and resolution without requiring service selection',()=>{
 assert.match(page,/v-model="newEpisodeTitle"/)
 assert.match(page,/v-model="newEpisodeResolution"/)
 assert.match(page,/newEpisodeResolution = ref\('720p'\)/)
 assert.match(page,/value: '720p'/)
 assert.match(page,/value: '480p'/)
 const body=page.match(/await episodeAPI.create\(\{([\s\S]*?)\}\)/)[1]
 for(const field of ['drama_id: dramaId','title: newEpisodeTitle.value','resolution: newEpisodeResolution.value'])assert.ok(body.includes(field))
 assert.doesNotMatch(body,/image_config_id|video_config_id|aiConfigAPI/)
})
test('episode resolution is editable with rollback on failure',()=>{
 assert.match(page,/episodeAPI.update\(ep.id, \{ resolution \}\)/)
 assert.match(page,/ep.resolution = prev/)
 assert.match(page,/epResMenuId/)
})
