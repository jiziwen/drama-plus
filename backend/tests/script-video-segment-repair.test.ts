import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateScriptVideoCards, ScriptVideoAIError,
  type ScriptVideoModelRequest, type ScriptVideoStoryboardCheckpoint,
} from '../src/services/script-video-ai.js'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'

const outline: ScriptVideoCard[] = ['到门前', '看向院中', '推门', '走进院中'].map((title, index) => ({
  id: 'scope-' + (index + 1), title, summary: title, duration: 30, assetIds: [], combat: false,
  prompt: '', shots: [], version: 1, status: 'draft',
}))
const production = {
  coreRhythm: '到门前站定，再推门进入。', visualSpecs: '晨光', shotRhythm: '固定机位',
  dialogueRules: '本场无对白。', interfaceRules: '无界面', costumeRules: '原稿服装',
  sceneAndCamera: '院内朝门', soundAndEditing: '门轴细响', continuityReview: '沿用推门方向', characters: [],
}
const input = { script: '阿明走到院门前站定，看向院中，再推门，走进院中。', assets: [], outline }
function draft(index: number, invalid = false) {
  const card = outline[index]
  return { ...card, opening: '院门前', ending: card.summary, scene: '清晨庭院', characters: '阿明站在院门前',
    independentGeneration: card.summary,
    shots: [{ duration: invalid ? 29 : 30, camera: '固定全景', action: '阿明' + card.summary, dialogue: '静默。' }],
  }
}
function target(request: ScriptVideoModelRequest) {
  const { targetCardIds } = JSON.parse(request.message)
  assert.equal(targetCardIds.length, 1, 'a batched call must target only the current segment')
  return targetCardIds[0] as string
}
const correction = (id: string) => ({ patches: [{ id, shots: [{ index: 1, duration: 30 }] }] })

test('four batched segments each receive their own repair budget and preserve successful prefixes', async () => {
  const calls: Array<{ mode?: string; id: string; attempted: number }> = []
  const snapshots: ScriptVideoStoryboardCheckpoint[] = []
  const result = await generateScriptVideoCards(input, async request => {
    const id = target(request)
    calls.push({ mode: request.mode, id, attempted: request.attempted })
    if (request.mode === 'episode') return { production, cards: [draft(outline.findIndex(c => c.id === id), true)] }
    return correction(id)
  }, { batchSize: 1, onProgress: (_, checkpoint) => { snapshots.push(structuredClone(checkpoint)) } })
  assert.deepEqual(calls.map(({ mode, id }) => [mode, id]), outline.flatMap(card => [
    ['episode', card.id], ['repair', card.id],
  ]))
  assert.deepEqual(calls.filter(call => call.mode === 'repair').map(call => call.attempted), [1, 1, 1, 1])
  assert.equal(result.attempts, 8)
  assert.equal(result.cards.length, 4)
  assert.equal(snapshots.at(-1)!.repairAttempts, 4, 'the aggregate remains available for call accounting')
  for (const count of [1, 2, 3]) {
    const next = snapshots.find(cp => cp.cards.length === count && !cp.candidate)
    assert.equal(next?.segmentRepairAttempts, 0, 'the next segment starts with a fresh budget')
    assert.equal(next?.repairCardId, outline[count].id)
  }
})

test('one failed segment stops after three repairs; explicit continuation keeps the accepted prefix and candidate', async () => {
  let saved!: ScriptVideoStoryboardCheckpoint
  const calls: string[] = []
  await assert.rejects(generateScriptVideoCards(input, async request => {
    const id = target(request)
    calls.push(request.mode + ':' + id)
    if (request.mode === 'episode') return { production, cards: [draft(outline.findIndex(c => c.id === id), id === 'scope-4')] }
    return { patches: [] }
  }, { batchSize: 1, onProgress: (_, checkpoint) => { saved = structuredClone(checkpoint) } }), {
    code: 'STORYBOARD_REPAIRS_EXHAUSTED',
  })
  assert.deepEqual(calls, ['episode:scope-1', 'episode:scope-2', 'episode:scope-3', 'episode:scope-4',
    'repair:scope-4', 'repair:scope-4', 'repair:scope-4'])
  assert.deepEqual(saved.cards.map(card => card.id), ['scope-1', 'scope-2', 'scope-3'])
  assert.equal(saved.segmentRepairAttempts, 3)
  assert.equal(saved.repairCardId, 'scope-4')
  const prefix = structuredClone(saved.cards)
  await assert.rejects(generateScriptVideoCards(input, async () => {
    assert.fail('ordinary resume must not reset an exhausted segment budget')
  }, { batchSize: 1, checkpoint: saved }), { code: 'STORYBOARD_REPAIRS_EXHAUSTED' })

  // The route grants this reset only on an explicit continuation of the failed segment.
  const checkpoint = { ...saved, segmentRepairAttempts: 0, repairFeedback: [] }
  let repairs = 0
  const result = await generateScriptVideoCards(input, async request => {
    assert.equal(request.mode, 'repair', 'the saved fourth candidate is repaired without regeneration')
    assert.equal(target(request), 'scope-4')
    assert.equal(request.attempted, 1)
    repairs++
    return correction('scope-4')
  }, { batchSize: 1, checkpoint })
  assert.equal(repairs, 1)
  assert.deepEqual(result.cards.slice(0, 3), prefix)
})

test('an interrupted segment keeps its reserved repair attempts across ordinary resume', async () => {
  let saved!: ScriptVideoStoryboardCheckpoint
  await assert.rejects(generateScriptVideoCards(input, async request => {
    if (request.mode === 'episode') {
      const index = outline.findIndex(card => card.id === target(request))
      return { production, cards: [draft(index, index === 0)] }
    }
    if (request.attempted === 2) throw Object.assign(Error('interrupted'), { statusCode: 504 })
    return { patches: [] }
  }, { batchSize: 1, onProgress: (_, checkpoint) => { saved = structuredClone(checkpoint) } }), {
    code: 'MODEL_TIMEOUT',
  })
  assert.equal(saved.segmentRepairAttempts, 2)
  const attempted: number[] = []
  const result = await generateScriptVideoCards(input, async request => {
    const id = target(request)
    if (request.mode === 'repair') { attempted.push(request.attempted); return correction(id) }
    return { cards: [draft(outline.findIndex(card => card.id === id))] }
  }, { batchSize: 1, checkpoint: saved })
  assert.deepEqual(attempted, [3])
  assert.equal(result.cards.length, 4)
})

test('legacy exhausted checkpoints can retry the pending segment without losing prior successful cards', async () => {
  const { cards } = await generateScriptVideoCards({ ...input, outline: outline.slice(0, 3) },
    async () => ({ production, cards: outline.slice(0, 3).map((_, index) => draft(index)) }))
  const legacy: ScriptVideoStoryboardCheckpoint = {
    cards, production, attempts: 7, repairAttempts: 3,
    candidate: { cards: [...cards, draft(3, true)], production },
  }
  await assert.rejects(generateScriptVideoCards(input, async () => {
    assert.fail('legacy ordinary resume must retain its previously reserved attempts')
  }, { batchSize: 1, checkpoint: legacy }), { code: 'STORYBOARD_REPAIRS_EXHAUSTED' })
  const result = await generateScriptVideoCards(input, async request => {
    assert.equal(request.mode, 'repair')
    assert.equal(target(request), 'scope-4')
    assert.equal(request.attempted, 1)
    return correction('scope-4')
  }, { batchSize: 1, checkpoint: { ...legacy, segmentRepairAttempts: 0 } })
  assert.deepEqual(result.cards.slice(0, 3), cards)
})
