import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parse } from '@vue/compiler-sfc'
import { computed, ref } from 'vue'
import ts from 'typescript'

const page = readFileSync(new URL('../app/pages/preview/script-to-video.vue', import.meta.url), 'utf8')
const { template, scriptSetup } = parse(page).descriptor
const tree = ts.createSourceFile('script-to-video.ts', scriptSetup.content, ts.ScriptTarget.Latest)
const outlineControls = tree.statements.filter(node => {
  if (ts.isFunctionDeclaration(node)) return node.name?.text === 'makeOutline'
  return ts.isVariableStatement(node) && node.declarationList.declarations.some(
    declaration => declaration.name.getText(tree) === 'outlineButtonDisabled',
  )
})
const { outputText } = ts.transpileModule(outlineControls.map(node => node.getText(tree)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
})

test('两处大纲按钮在点击后提示缺少资产，并阻止提交', async () => {
  const buttons = [...template.content.matchAll(/<button\b[^>]*@click="makeOutline"[^>]*>/g)]
  assert.equal(buttons.length, 2)
  for (const [button] of buttons) assert.match(button, /:disabled="outlineButtonDisabled"/)
  const assetNotice = '请先生成并导入项目资产'
  assert.ok(!template.content.includes(assetNotice))

  const notices = []
  const submitted = []
  const assets = ref([])
  const busy = ref(false)
  const currentTextRun = ref(undefined)
  const script = ref('守卫开门。')
  const { outlineButtonDisabled, makeOutline } = runInNewContext(
    `${outputText}\n;({ outlineButtonDisabled, makeOutline })`,
    { computed, assets, busy, currentTextRun, script, toast: { info: message => notices.push(message) }, runAI: async action => submitted.push(action) },
  )

  assert.equal(outlineButtonDisabled.value, false)
  assert.deepEqual(notices, [])
  await makeOutline()
  assert.deepEqual(notices, [assetNotice])
  assert.deepEqual(submitted, [])

  assets.value.push({ id: 'asset-1' })
  assert.equal(outlineButtonDisabled.value, false)
  await makeOutline()
  assert.deepEqual(notices, [assetNotice])
  assert.deepEqual(submitted, ['outline'])

  busy.value = true
  assert.equal(outlineButtonDisabled.value, true)
  await makeOutline()
  busy.value = false
  script.value = '  '
  assert.equal(outlineButtonDisabled.value, true)
  await makeOutline()
  assert.deepEqual(notices, [assetNotice])
  assert.deepEqual(submitted, ['outline'])

  script.value = '守卫开门。'
  assets.value = []
  assert.equal(outlineButtonDisabled.value, false)
  await makeOutline()
  assert.deepEqual(notices, [assetNotice, assetNotice])
  assert.deepEqual(submitted, ['outline'])
})
