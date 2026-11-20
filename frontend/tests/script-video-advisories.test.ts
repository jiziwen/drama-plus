import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { validatePreviewCards } from '../app/utils/scriptVideoPreviewValidation'
import { createPreviewCards, seedAssets, seedScript } from './fixtures/scriptVideoCards'

const source = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const tree = ts.createSourceFile('page.ts', parse(source).descriptor.scriptSetup!.content, ts.ScriptTarget.Latest)
const handler = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'checkForAction')!
const { outputText } = ts.transpileModule(handler.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } })

function action(card: ReturnType<typeof createPreviewCards>[number]) {
  const state = { validation: { value: undefined as unknown }, dialog: { value: undefined as unknown } }
  const errors: string[] = []
  const cards = [card]
  const episode = { number: 16, production: undefined }
  const context = {
    ...state, validatePreviewCards, cards: { value: cards }, assets: { value: seedAssets },
    currentProject: { value: {} }, currentEpisode: { value: episode }, confirmedScript: { value: seedScript },
    deliveryOptions: () => ({}), validationScope: { value: '' }, projectTitle: { value: '七天' },
    toast: { error: (message: string) => errors.push(message) },
  }
  const allowed = runInNewContext(outputText + '\ncheckForAction(cards.value)', context)
  return { allowed, errors, ...state }
}

test('the actual page action continues with material and content advisories', () => {
  const card = createPreviewCards(seedScript, seedAssets, true)[0]!
  card.assetIds.push('removed-material')
  card.prompt += '\n画面与动作：@待补充的茶壶 靠在门边。'
  const checked = validatePreviewCards([card], seedAssets, { script: seedScript })
  assert.equal(checked.ok, true)
  assert.ok(checked.warnings.length > 0)
  const result = action(card)
  assert.equal(result.allowed, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.dialog.value, undefined)
  assert.equal(result.validation.value, undefined)
})

test('the same page action still reports an unusable numeric timeline', () => {
  const card = createPreviewCards(seedScript, seedAssets, true)[0]!
  card.shots[0]!.duration -= 1
  const result = action(card)
  assert.equal(result.allowed, false)
  assert.equal(result.dialog.value, 'validation')
  assert.ok((result.validation.value as ReturnType<typeof validatePreviewCards>).issues.some(issue => issue.code === 'DUR009'))
})
