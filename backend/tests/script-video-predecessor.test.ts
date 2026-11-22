import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previousScriptVideoCard } from '../src/services/script-video-predecessor.js'

test('第一段只衔接项目顺序中紧邻上一集的最后一段，后续段仍使用本集前驱', () => {
  const project = { episodes: [
    { id: 'earlier', number: 20, cards: [{ id: 'a' }, { id: 'b' }] },
    { id: 'current', number: 3, cards: [{ id: 'c' }, { id: 'd' }] },
  ] }
  const first = previousScriptVideoCard(project, 'current', 'c')!
  assert.equal(first.episode.id, 'earlier')
  assert.equal(first.card.id, 'b')
  assert.equal(first.index, 1)
  assert.equal(previousScriptVideoCard(project, 'current', 'd')?.card.id, 'c')
  assert.equal(previousScriptVideoCard(project, 'earlier', 'a'), undefined)
  assert.equal(previousScriptVideoCard(project, 'missing', 'c'), undefined)
  assert.equal(previousScriptVideoCard(project, 'current', 'missing'), undefined)
})

test('上一集为空或尚未加载时不越过该集找更早的成片', () => {
  const project = { episodes: [
    { id: 'earlier', cards: [{ id: 'a' }] },
    { id: 'empty', cards: [] },
    { id: 'current', cards: [{ id: 'c' }] },
  ] }
  assert.equal(previousScriptVideoCard(project, 'current', 'c'), undefined)
  assert.equal(previousScriptVideoCard({ episodes: [{ id: 'unloaded' }, project.episodes[2]] } as typeof project, 'current', 'c'), undefined)
})
