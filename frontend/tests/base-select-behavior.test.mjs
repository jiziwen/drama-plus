import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../app/components/BaseSelect.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
function setup(options, value = '') {
  const events = [], props = { options, modelValue: value, searchable: false, disabled: false, placeholder: '' }
  const context = {
    defineProps: () => props, defineEmits: () => (name, value) => events.push([name, value]),
    ref: value => ({ value }), computed: get => ({ get value() { return get() } }),
    watch() {}, nextTick: async callback => callback?.(), useI18n: () => ({ t: value => value }),
  }
  runInNewContext(script + '\nglobalThis.select = { pick, moveHighlight, onTriggerKeydown, onSearchKeydown, onOptionsKeydown, triggerEl, getGlobalIdx, searchQuery, highlightedIdx, normalizedGroups, selectedLabel, isOpen }', context)
  return { ...context.select, props, events }
}

test('disabled models and disabled selectors cannot submit a selection', () => {
  const select = setup([{ label: 'Unavailable', value: '7/model', disabled: true }, { label: 'Available', value: '8/model' }], '7/model')
  assert.equal(select.selectedLabel.value, 'Unavailable')
  select.pick(select.normalizedGroups.value[0].options[0])
  select.props.disabled = true
  select.pick(select.normalizedGroups.value[0].options[1])
  select.onTriggerKeydown({ key: 'ArrowDown', preventDefault() {} })
  assert.deepEqual(select.events, [])
  assert.equal(select.isOpen.value, false)
})

test('search and keyboard navigation use filtered group offsets and skip disabled options', () => {
  const select = setup([
    { label: 'First', options: [{ label: 'Other', value: 1 }, { label: 'Target unavailable', value: 2, disabled: true }] },
    { label: 'Second', options: [{ label: 'Target ready', value: 3 }, { label: 'Target final', value: 4 }] },
  ])
  select.searchQuery.value = 'target'
  assert.equal(select.getGlobalIdx(1, 0), 1)
  select.moveHighlight('Home')
  assert.equal(select.highlightedIdx.value, 1)
  select.moveHighlight('ArrowDown')
  assert.equal(select.highlightedIdx.value, 2)
  select.moveHighlight('ArrowUp')
  assert.equal(select.highlightedIdx.value, 1)
})

test('numeric project IDs and empty inheritance values retain their exact types', () => {
  const select = setup([{ value: '', label: 'Follow default' }, { value: 5, label: 'Project' }], 5)
  select.pick(select.normalizedGroups.value[0].options[1])
  select.pick(select.normalizedGroups.value[0].options[0])
  assert.deepEqual(select.events, [['update:modelValue', 5], ['update:modelValue', '']])
  assert.equal(select.props.modelValue, 5)
})

test('Escape closes a nested selector and restores focus without closing its dialog', () => {
  const select = setup([{ value: 5, label: 'Project' }], 5)
  let focused = 0
  select.triggerEl.value = { focus() { focused++ } }
  for (const handler of [select.onSearchKeydown, select.onOptionsKeydown, select.onTriggerKeydown]) {
    select.isOpen.value = true
    let stopped = false
    handler({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true } })
    assert.equal(select.isOpen.value, false)
    assert.equal(stopped, true)
  }
  assert.equal(focused, 3)
})
