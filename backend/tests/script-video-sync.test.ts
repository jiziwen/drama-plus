import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyScriptVideoChanges, diffScriptVideoChanges, validateScriptVideoChanges } from '../src/services/script-video-sync.js'

function fixture() {
  return {
    id: 'project', title: '七天', revision: 1, episodeId: 'one', settings: { systemPrompt: '原文', combatEnabled: true },
    assets: [{ id: 'actor', name: '角色', kind: 'character', image: '/static/uploads/one.png' }],
    episodes: ['one', 'two'].map(id => ({ id, title: id, script: '原剧本', confirmedScript: '', cards: [
      { id: `card-${id}`, prompt: '原提示词', summary: '原概述', version: 1, status: 'draft', shots: [] },
    ], tasks: [] as any[] })),
  }
}

test('stale pages save only actual fields and episodes, with the later write winning the same field', () => {
  const base = fixture(), a = structuredClone(base), b = structuredClone(base)
  a.episodes[0]!.cards[0]!.prompt = '甲改提示词'
  b.episodes[1]!.script = '乙改另一集'
  b.episodes[0]!.cards[0]!.summary = '乙改同卡的概述'
  const first = applyScriptVideoChanges(base, diffScriptVideoChanges(base, a))
  const second = applyScriptVideoChanges(first, diffScriptVideoChanges(base, b))
  assert.equal(second.episodes[0]!.cards[0]!.prompt, '甲改提示词')
  assert.equal(second.episodes[0]!.cards[0]!.summary, '乙改同卡的概述')
  assert.equal(second.episodes[1]!.script, '乙改另一集')
  b.episodes[0]!.cards[0]!.prompt = '最后保存生效'
  assert.equal(applyScriptVideoChanges(second, diffScriptVideoChanges(base, b)).episodes[0]!.cards[0]!.prompt, '最后保存生效')
})

test('project settings are independently updated without resubmitting task or playback metadata', () => {
  const base = fixture(), a = structuredClone(base), b = structuredClone(base)
  a.settings.systemPrompt = '甲规则'
  b.settings.combatEnabled = false
  b.revision = 999
  b.episodes[0]!.cards[0]!.status = 'ready'
  b.episodes[0]!.cards[0]!.version = 999
  b.episodes[0]!.tasks.push({ id: 'forged', status: 'completed' })
  const changes = diffScriptVideoChanges(base, b)
  assert.deepEqual(changes, [{ target: 'project', fields: { 'settings.combatEnabled': false }, unset: [] }])
  const result = applyScriptVideoChanges(applyScriptVideoChanges(base, diffScriptVideoChanges(base, a)), changes)
  assert.deepEqual(result.settings, { systemPrompt: '甲规则', combatEnabled: false })
  assert.equal(result.episodes[0]!.cards[0]!.version, 1)
})

test('custom style edits replace one preset per ID and preserve changes to other presets', () => {
  const base = fixture()
  const first = { id: 'custom-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: '黑白风格', prefix: '黑白光影' }
  const second = { id: 'custom-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: '水墨风格', prefix: '水墨淡彩' }
  const a = { ...base, settings: { ...base.settings, customStylePresets: { [first.id]: first }, stylePreset: first } }
  const b = { ...base, settings: { ...base.settings, customStylePresets: { [second.id]: second }, stylePreset: second } }
  assert.deepEqual(diffScriptVideoChanges(base, a), [{
    target: 'project', fields: { [`settings.customStylePresets.${first.id}`]: first, 'settings.stylePreset': first }, unset: [],
  }])
  const saved = applyScriptVideoChanges(applyScriptVideoChanges(base, diffScriptVideoChanges(base, a)), diffScriptVideoChanges(base, b))
  assert.deepEqual(saved.settings, {
    ...base.settings, customStylePresets: { [first.id]: first, [second.id]: second }, stylePreset: second,
  })
  const withoutFirst = { ...a, settings: { ...base.settings, customStylePresets: {} } }
  const [deletion] = diffScriptVideoChanges(a, withoutFirst)
  assert.deepEqual(deletion?.unset, [`settings.customStylePresets.${first.id}`, 'settings.stylePreset'])
  assert.deepEqual(applyScriptVideoChanges(saved, [{ target: 'project', unset: [`settings.customStylePresets.${first.id}`] }])
    .settings.customStylePresets, { [second.id]: second })

  const revised = { ...first, name: '新版黑白风格', prefix: '高反差黑白光影' }
  const edited = { ...a, settings: { ...a.settings, customStylePresets: { [first.id]: revised }, stylePreset: revised } }
  assert.deepEqual(diffScriptVideoChanges(a, edited), [{
    target: 'project', fields: { [`settings.customStylePresets.${first.id}`]: revised, 'settings.stylePreset': revised }, unset: [],
  }])
})

test('summary-only episodes never emit body updates and concurrent additions survive reordering', () => {
  const base = fixture(), current = structuredClone(base)
  current.episodes[1]!.script = ''
  current.episodes[0]!.script = '只存第一集'
  const changes = diffScriptVideoChanges(base, current, { loadedEpisodeIds: ['one'] })
  assert.deepEqual(changes.map(change => change.id), ['one'])
  const remote = structuredClone(base)
  remote.episodes.push({ ...structuredClone(remote.episodes[0]!), id: 'three' })
  const reordered = applyScriptVideoChanges(remote, [{ target: 'episode', order: ['two', 'one'] }])
  assert.deepEqual(reordered.episodes.map(episode => episode.id), ['two', 'one', 'three'])
})

test('replaying creates does not roll back an entity edited after its creation', () => {
  const base = fixture(), next = structuredClone(base)
  next.assets.push({ id: 'new', name: '新角色', kind: 'character', image: '/static/uploads/two.png' })
  const changes = diffScriptVideoChanges(base, next)
  const first = applyScriptVideoChanges(base, changes)
  first.assets[1]!.name = '别人更新'
  assert.equal(applyScriptVideoChanges(first, changes).assets[1]!.name, '别人更新')
})

test('a new segment inserted before an existing segment keeps the chosen order', () => {
  const base = fixture(), next = structuredClone(base)
  next.episodes[0]!.cards.unshift({ ...structuredClone(next.episodes[0]!.cards[0]!), id: 'new-card' })
  const saved = applyScriptVideoChanges(base, diffScriptVideoChanges(base, next))
  assert.deepEqual(saved.episodes[0]!.cards.map(card => card.id), ['new-card', 'card-one'])
})

test('different shot cells merge by stable shot ID and concurrent duration edits recompute the card total', () => {
  const base: any = fixture()
  base.episodes[0].cards[0].shots = [
    { id: 'shot-a', camera: '近景', dialogue: '甲', duration: 2 },
    { id: 'shot-b', camera: '远景', dialogue: '乙', duration: 3 },
  ]
  base.episodes[0].cards[0].duration = 5
  const a = structuredClone(base), b = structuredClone(base)
  a.episodes[0].cards[0].shots[0].camera = '特写'
  a.episodes[0].cards[0].shots[0].duration = 4
  a.episodes[0].cards[0].duration = 7
  b.episodes[0].cards[0].shots[1].dialogue = '乙的新台词'
  b.episodes[0].cards[0].shots[1].duration = 6
  b.episodes[0].cards[0].duration = 8
  const saved = applyScriptVideoChanges(applyScriptVideoChanges(base, diffScriptVideoChanges(base, a)), diffScriptVideoChanges(base, b))
  const card = saved.episodes[0].cards[0]
  assert.equal(card.shots[0].camera, '特写')
  assert.equal(card.shots[1].dialogue, '乙的新台词')
  assert.equal(card.duration, 10)
})

test('rejects injected paths and server-owned fields without modifying the source', () => {
  const base = fixture()
  for (const field of ['__proto__.polluted', 'settings.constructor.prototype', 'revision', 'episodes']) {
    assert.throws(() => applyScriptVideoChanges(base, [{ target: 'project', fields: { [field]: true } }]))
  }
  for (const field of ['tasks', 'cards', 'generationsHistory']) {
    assert.throws(() => validateScriptVideoChanges([{ target: 'episode', id: 'one', fields: { [field]: [] } }]))
  }
  for (const field of ['version', 'videoUrl', 'status']) {
    assert.throws(() => validateScriptVideoChanges([{ target: 'card', episodeId: 'one', id: 'card-one', fields: { [field]: 'forged' } }]))
  }
  assert.deepEqual(base, fixture())
  assert.equal(({} as any).polluted, undefined)
})
