import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const appRoot = new URL('../app/', import.meta.url)
const read = (path) => readFileSync(new URL(path, appRoot), 'utf8')

function loadMarkdown() {
  const exports = {}
  const code = ts.transpileModule(read('utils/markdown.ts'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  runInNewContext(code, { exports }, { filename: 'utils/markdown.ts' })
  return exports
}

test('renderChatMarkdown 支持常见格式并拦截 XSS', () => {
  const { renderChatMarkdown } = loadMarkdown()
  const md = [
    '## 标题',
    '',
    '普通文本 **加粗** 和 `行内代码` 以及 [安全链接](https://example.com) 和 [危险脚本](javascript:alert(1))。',
    '',
    '<script>alert(1)</script>',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '```ts',
    'const x = "<tag>"',
    '```',
  ].join('\n')

  const html = renderChatMarkdown(md)
  assert.match(html, /<h2>标题<\/h2>/)
  assert.match(html, /<strong>加粗<\/strong>/)
  assert.match(html, /<code class="chat-inline-code">行内代码<\/code>/)
  assert.match(html, /href="https:\/\/example\.com"/)
  assert.doesNotMatch(html, /href="javascript:/i)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /<ul><li>列表一<\/li><li>列表二<\/li><\/ul>/)
  assert.match(html, /<pre><code>const x = &quot;&lt;tag&gt;&quot;<\/code><\/pre>/)
})

test('ai-chat.vue 与双布局导航栏可正确编译且包含入口', () => {
  for (const file of ['pages/ai-chat.vue', 'layouts/cinematic.vue', 'layouts/default.vue']) {
    const source = read(file)
    const { descriptor, errors } = parse(source, { filename: file })
    assert.deepEqual(errors, [])
    const compiledScript = compileScript(descriptor, { id: file })
    assert.ok(compiledScript.content)
    const compiledTemplate = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id: file,
    })
    assert.deepEqual(compiledTemplate.errors, [])
  }

  const cinematicLayout = read('layouts/cinematic.vue')
  const defaultLayout = read('layouts/default.vue')
  const middleware = read('middleware/cinematic.global.ts')

  assert.match(cinematicLayout, /interfaceLink\('\/downmarket-drama'\)[\s\S]*interfaceLink\('\/ai-chat'\)/)
  assert.match(cinematicLayout, /<span>07<\/span>AI 聊天/)
  assert.match(defaultLayout, /to="\/downmarket-drama"[\s\S]*to="\/ai-chat"/)
  assert.match(defaultLayout, /AI 聊天/)
  assert.match(middleware, /'\/ai-chat'/)
})
