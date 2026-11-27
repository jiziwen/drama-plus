import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const source = readFileSync(new URL('../app/views/drama/episode.vue', import.meta.url), 'utf8')
const functions = source.slice(source.indexOf('function configModels('), source.indexOf('// 复合键'))
const scope = {}
runInNewContext(`${functions}\nglobalThis.collect = collectModelOptions`, scope)

test('legacy selector puts the exact global model first without collapsing same-provider configurations', () => {
  const configs = [
    { id: 1, provider: 'openai', name: 'one', is_active: true, priority: 10, model: ['shared', 'a'] },
    { id: 2, provider: 'openai', name: 'two', is_active: true, priority: 0, model: ['shared', 'b'], global_default_model: 'b', global_default_eligible: true },
  ]
  const options = scope.collect(configs)
  assert.deepEqual([options[0].configId, options[0].model], [2, 'b'])
  const shared = options.filter(option => option.model === 'shared')
  assert.equal(shared.length, 2)
  assert.notEqual(shared[0].key, shared[1].key)
  const locked = scope.collect(configs, 1)
  assert.deepEqual([locked[0].configId, locked[0].model], [1, 'shared'])
  const sameConfigPin = scope.collect(configs, 2)
  assert.deepEqual([sameConfigPin[0].configId, sameConfigPin[0].model], [2, 'b'])
  configs[1].global_default_model = null
  configs[0].global_default_model = 'a'
  const changed = scope.collect(configs)
  assert.deepEqual([changed[0].configId, changed[0].model], [1, 'a'])
})

test('legacy explicit provider/model keeps its former priority owner after migration', () => {
  const configs = [
    { id: 1, provider: 'openai', name: 'one', is_active: true, priority: 10, model: ['shared'] },
    { id: 2, provider: 'openai', name: 'two', is_active: true, priority: 0, model: ['shared'], global_default_model: 'shared' },
  ]
  const start = source.indexOf('function pruneStaleModel(')
  const end = source.indexOf('pruneStaleModel(chatModel', start)
  const model = { value: 'openai/shared' }, options = { value: scope.collect(configs) }
  const context = { watch: (value, fn) => fn(value.value), model, options }
  runInNewContext(`${source.slice(start, end)}\npruneStaleModel(model, options)`, context)
  assert.equal(model.value, 'openai:1/shared')
})
