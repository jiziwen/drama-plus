import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generateScriptVideoCards,
  ScriptVideoAIError,
  type ScriptVideoStoryboardCheckpoint,
} from '../src/services/script-video-ai.js'
import type { ScriptVideoCard } from '../src/services/script-video-types.js'

const outline: ScriptVideoCard[] = ['到门前', '看向院中', '推门'].map((title, index) => ({
  id: 'courtyard-' + (index + 1),
  title,
  summary: title,
  duration: 3,
  assetIds: [],
  combat: false,
  prompt: '',
  shots: [],
  version: 1,
  status: 'draft',
}))
const production = {
  coreRhythm: '到门前站定，再推门。',
  visualSpecs: '晨光',
  shotRhythm: '固定机位',
  dialogueRules: '本场无对白。',
  interfaceRules: '无界面',
  costumeRules: '原稿服装',
  sceneAndCamera: '院内朝门',
  soundAndEditing: '门轴细响',
  continuityReview: '沿用推门方向',
  characters: [],
}
const input = { script: '阿明走到院门前站定，看向院中，再推门。', assets: [], outline }
const drafts = outline.map((card, index) => ({
  ...card,
  opening: '院门前',
  ending: card.summary,
  scene: '清晨庭院',
  characters: '阿明站在院门前',
  independentGeneration: card.summary,
  shots: [
    {
      duration: index === 0 ? 2 : 3,
      camera: '固定全景',
      action: '阿明' + card.summary,
      dialogue: '静默。',
    },
  ],
}))
const correction = { patches: [{ id: outline[0].id, shots: [{ index: 1, duration: 3 }] }] }

test('resume keeps received segments after a TS failure and writes only the missing suffix', async () => {
  let saved: ScriptVideoStoryboardCheckpoint | undefined
  const persist = (_progress: unknown, cp: ScriptVideoStoryboardCheckpoint) => {
    saved = structuredClone(cp)
  }
  await assert.rejects(
    generateScriptVideoCards(
      input,
      async (req) => {
        await req.onProduction!(production)
        await req.onCard!(drafts[0], 0)
        await req.onCard!(drafts[1], 1)
        throw Object.assign(Error('interrupted'), { statusCode: 524 })
      },
      { onProgress: persist },
    ),
    (e) => e instanceof ScriptVideoAIError && e.code === 'MODEL_TIMEOUT',
  )
  assert.equal(saved!.cards.length, 0)
  assert.equal(saved!.partialRaw!.cards.length, 2)

  const modes: string[] = []
  const result = await generateScriptVideoCards(
    input,
    async (req) => {
      modes.push(req.mode!)
      const data = JSON.parse(req.message)
      if (req.mode === 'episode') {
        assert.deepEqual(data.targetCardIds, [outline[2].id])
        assert.equal(data.previousCard.lastShot.action, drafts[1].shots[0].action)
        return { cards: [drafts[2]] }
      }
      assert.deepEqual(data.targetCardIds, [outline[0].id])
      return correction
    },
    { checkpoint: saved },
  )
  assert.deepEqual(modes, ['episode', 'repair'])
  assert.deepEqual(
    result.cards.map((card) => card.shots[0].action),
    drafts.map((card) => card.shots[0].action),
  )
})

test('a timeout in the third paid repair reports the original TS issue and exhausts the budget on resume', async () => {
  let calls = 0
  let saved: ScriptVideoStoryboardCheckpoint | undefined
  const isExhausted = (err: unknown) =>
    err instanceof ScriptVideoAIError &&
    err.code === 'STORYBOARD_REPAIRS_EXHAUSTED' &&
    ['DUR009', 'MODEL_TIMEOUT'].every((code) => err.issues.some((issue) => issue.code === code))
  await assert.rejects(
    generateScriptVideoCards(
      input,
      async (req) => {
        calls++
        if (req.mode === 'episode') return { production, cards: drafts }
        if (calls === 4) throw Object.assign(Error('private upstream error'), { statusCode: 504 })
        return { patches: [] }
      },
      {
        onProgress: (_, cp) => {
          saved = structuredClone(cp)
        },
      },
    ),
    isExhausted,
  )
  assert.equal(calls, 4)
  assert.equal(saved!.repairAttempts, 3)
  await assert.rejects(
    generateScriptVideoCards(
      input,
      async () => {
        calls++
        return {}
      },
      { checkpoint: saved },
    ),
    isExhausted,
  )
  assert.equal(calls, 4)
})

test('a patch targeting an unrelated segment is rejected atomically', async () => {
  const result = await generateScriptVideoCards(input, async (req) => {
    if (req.mode === 'episode') return { production, cards: drafts }
    if (req.attempted === 1)
      return {
        patches: [
          ...correction.patches,
          { id: outline[2].id, shots: [{ index: 1, action: '意外修改' }] },
        ],
      }
    assert.equal(JSON.parse(req.message).previousPatchIssues[0].code, 'REPAIR_SCOPE')
    return correction
  })
  assert.equal(result.attempts, 3)
  assert.equal(result.cards[2].shots[0].action, drafts[2].shots[0].action)
})
