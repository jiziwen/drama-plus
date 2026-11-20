import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { generateScriptVideoCards, type ScriptVideoStoryboardCheckpoint } from '../src/services/script-video-ai.js'
import { renderScriptVideoPrompt } from '../src/services/script-video-format.js'
import {
  assertScriptVideoCards,
  remainingScriptVideoDialogue,
  sameShotDialogue,
  scriptVideoDialogueBoundaryCharacters,
  sourceDialogue,
  type ScriptVideoCard,
} from '../src/services/script-video-types.js'

const episode16 = JSON.parse(readFileSync(new URL('./fixtures/script-video-episode16-directions-checkpoint.json', import.meta.url), 'utf8'))

function board(dialogue: string[], actions: string[] = []): ScriptVideoCard {
  const card: ScriptVideoCard = {
    id: 'directions', title: '停连测试', duration: dialogue.length * 2, summary: '甲在门旁说完原话。',
    assetIds: [], combat: false, status: 'draft', version: 1, prompt: '',
    opening: '甲站在门旁。', scene: '门旁，同一空间。', characters: '甲站在门旁，乙在旁边听。',
    independentGeneration: '甲在原地说话，乙听着。', ending: '两人仍站在门旁。',
    shots: dialogue.map((text, index) => ({
      id: 'shot-' + (index + 1), duration: 2, camera: '近景／平视／固定',
      action: actions[index] ?? '甲站在门旁，视线不移。', dialogue: text,
    })),
  }
  card.prompt = renderScriptVideoPrompt(card, [])
  return card
}

function validate(script: string, card: ScriptVideoCard) {
  return assertScriptVideoCards({ script, cards: [card], assets: [] })
}

function checkpointCard(raw: any): ScriptVideoCard {
  const card: ScriptVideoCard = {
    ...structuredClone(raw),
    shots: raw.shots.map((shot: any, index: number) => ({ ...structuredClone(shot), id: raw.id + '-shot-' + (index + 1) })),
    status: 'draft', version: 1, prompt: '',
  }
  card.prompt = renderScriptVideoPrompt(card, episode16.assets, episode16.production)
  return card
}

test('the actual failed episode 16 fourth candidate resumes locally without spending another model call', async () => {
  const cards = episode16.prefixCards.map(checkpointCard)
  const stop = new DOMException('The fourth candidate was accepted locally', 'AbortError')
  const controller = new AbortController()
  let accepted: ScriptVideoStoryboardCheckpoint | undefined
  let modelCalls = 0
  const checkpoint: ScriptVideoStoryboardCheckpoint = {
    cards, production: episode16.production, attempts: episode16.attempts,
    repairAttempts: episode16.repairAttempts,
    candidate: { production: episode16.production, cards: [...cards, episode16.candidateCard] },
  }
  assert.match(episode16.candidateCard.shots[4].dialogue, /微顿后压低声线反问/u)
  await assert.rejects(generateScriptVideoCards({
    script: episode16.script, assets: episode16.assets, outline: episode16.outline,
    signal: controller.signal,
  }, async () => {
    modelCalls++
    assert.fail('The recorded fourth candidate must validate before another model request')
  }, {
    checkpoint, batchSize: 1,
    onProgress(progress, saved) {
      if (progress.phase === 'generating' && progress.completed === 4) {
        accepted = saved
        controller.abort(stop)
      }
    },
  }), error => error === stop)
  assert.equal(modelCalls, 0)
  assert.ok(accepted)
  assert.equal(accepted.cards.length, 4)
  assert.equal(accepted.repairAttempts, 3)
  assert.deepEqual(accepted.cards.slice(0, 3).map(card => card.shots.map(shot => shot.dialogue)),
    cards.map((card: ScriptVideoCard) => card.shots.map(shot => shot.dialogue)))
})

test('an inline brief pause may move to a shot cue and action while the spoken words stay intact', () => {
  const script = '甲：“别回头。（微顿）跟我走。”'
  const card = board(['甲：“别回头。”', '甲【微顿后低声续说】：“跟我走。”'],
    ['甲说完前半句后闭口。', '甲微顿后接着说，视线不移。'])
  assert.doesNotThrow(() => validate(script, card))
})

test('an inline pause may move outside the quotation without adding spoken words', () => {
  for (const pause of ['（停顿）', '(停顿)', '(微顿)']) {
    const script = '甲：“别回头。' + pause + '跟我走。”'
    const card = board(['甲【停顿后续说】：“别回头。跟我走。”'], ['甲说完前半句后停顿，再接着说。'])
    assert.doesNotThrow(() => validate(script, card), pause)
  }
})

test('a manually synchronized prompt can move the same pause from quoted speech to its performance cue', () => {
  const script = '甲：“别回头。（微顿）跟我走。”'
  const card = board(['甲：“别回头。（微顿）跟我走。”'])
  card.prompt = renderScriptVideoPrompt(board(['甲【微顿后续说】：“别回头。跟我走。”']), [])
  assert.doesNotThrow(() => validate(script, card))
})

test('execution checks do not compare spoken words after a pause moves', () => {
  const script = '甲：“别回头。（微顿）跟我走。”'
  for (const changed of ['跟走。', '跟他走。']) {
    const card = board(['甲：“别回头。”', '甲【微顿后续说】：“' + changed + '”'])
    assert.doesNotThrow(() => validate(script, card))
  }
})

test('execution checks leave prose speaker labels to the model rules', () => {
  const script = '甲：“别回头。（微顿）跟我走。”'
  const card = board(['甲：“别回头。”', '乙【微顿后续说】：“跟我走。”'])
  assert.doesNotThrow(() => validate(script, card))
})

test('execution checks leave inner voice semantics to the model rules', () => {
  const script = '甲(OS)：“别回头。（微顿）跟我走。”'
  const card = board(['甲：“别回头。”', '甲【微顿后续说】：“跟我走。”'])
  assert.doesNotThrow(() => validate(script, card))
})

test('execution checks accept literal sound text without judging omissions', () => {
  for (const literal of ['（A-01）', '【警报】']) {
    const script = '甲：“屏幕上写着' + literal + '，马上撤离。”'
    assert.doesNotThrow(() => validate(script, board(['甲：“屏幕上写着' + literal + '，马上撤离。”'])))
    assert.doesNotThrow(() => validate(script, board(['甲：“屏幕上写着，马上撤离。”'])))
  }
})

test('execution checks do not interpret quoted pause labels as a blocker', () => {
  const script = '甲：“请念出‘（停顿）’这几个字。”'
  assert.doesNotThrow(() => validate(script, board(['甲：“请念出‘（停顿）’这几个字。”'])))
  assert.doesNotThrow(() => validate(script, board(['甲：“请念出这几个字。”'])))
})

test('a literal pause label keeps its identity when a quotation continues in the next shot or queue', () => {
  const script = '甲：“请念出‘（停顿）’这几个字。”'
  const first = board(['甲：“请念出‘”'])
  assert.doesNotThrow(() => assertScriptVideoCards({ script, assets: [], cards: [first], scope: 'prefix' }))
  const consumed = scriptVideoDialogueBoundaryCharacters(sourceDialogue(script, true), { line: 1, endCue: '请念出‘' })
  assert.equal(consumed, 3)
  const [remaining] = remainingScriptVideoDialogue(script, consumed)
  assert.equal(remaining.text, '（停顿）’这几个字。')
  assert.doesNotThrow(() => validate(script, board(['甲：“请念出‘”', '甲：“' + remaining.text + '”'])))
})

test('a dialogue boundary ending at or inside a pause token counts only the actual preceding words', () => {
  const lines = sourceDialogue('甲：“开门。（微顿）进来。”', true)
  for (const endCue of ['（微顿）', '（微顿', '微顿', '（微']) {
    assert.equal(scriptVideoDialogueBoundaryCharacters(lines, { line: 1, endCue }), 2, endCue)
  }
})

test('resuming after a prefix that crosses pause tokens neither repeats words nor cuts a token in half', () => {
  const script = '甲：“开门。（微顿）进来。（停顿）跟上。”'
  const card = board(['甲：“开门。进来。跟”'])
  assert.doesNotThrow(() => assertScriptVideoCards({ script, cards: [card], assets: [], scope: 'prefix' }))
  const consumed = scriptVideoDialogueBoundaryCharacters(sourceDialogue(script, true), { line: 1, endCue: '跟' })
  assert.equal(consumed, 5)
  assert.deepEqual(remainingScriptVideoDialogue(script, consumed), [{ speaker: '甲', text: '上。' }])
})

test('revision dialogue equivalence ignores only the same clear pause instructions', () => {
  const script = '甲：“别回头。（微顿）跟我走。”'
  assert.equal(sameShotDialogue('甲：“别回头。（微顿）跟我走。”', '甲【微顿后续说】：“别回头。跟我走。”', script), true)
  assert.equal(sameShotDialogue('甲：“别回头。（微顿）跟我走。”', '甲【微顿后续说】：“别回头。跟他走。”', script), false)
  assert.equal(sameShotDialogue('甲：“【警报】响了。”', '甲：“响了。”', '甲：“【警报】响了。”'), false)
})
