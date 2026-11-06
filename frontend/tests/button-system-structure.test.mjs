import {readFileSync} from 'node:fs'
import {test} from 'node:test'
import assert from 'node:assert/strict'
const read=p=>readFileSync(new URL('../app/'+p,import.meta.url),'utf8')
test('button primitives retain disabled, focus and destructive action feedback',()=>{
 const css=read('assets/studio.css')+'\n'+read('assets/soft-studio.css')
 assert.match(css,/--button-height:\s*36px/)
 assert.match(css,/--button-height-sm:\s*30px/)
 assert.match(css,/--button-focus:/)
 assert.match(css,/:focus-visible/)
 assert.match(css,/\.btn:disabled/)
 assert.match(css,/\.btn-danger/)
})
test('custom menus retain keyboard focus hooks',()=>{
 const component=read('components/BaseSelect.vue')
 assert.match(component,/\.base-select-trigger:focus-visible/)
 assert.match(component,/role="menuitem"/)
})
