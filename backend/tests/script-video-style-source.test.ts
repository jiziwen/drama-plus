import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getCurrentScriptVideoStylePresets, getCurrentScriptVideoStyleRevision, parseScriptVideoStylePresets, resolveBuiltinStyleSnapshot } from '../src/services/script-video-style-source'

test('运行期按标题读取风格原文，保持换行、空白和各分区内容', () => {
  const source = readFileSync(new URL('../workspace/skills/script-to-video/references/项目风格前缀原文.txt', import.meta.url), 'utf8')
  const presets = parseScriptVideoStylePresets(source)
  assert.equal(presets.map(preset => preset.prefix).join(''), source)
  assert.deepEqual(presets.map(preset => [preset.id, preset.name]), [['cool', '冷色调'], ['warm', '暖色调']])
  assert.equal(presets[0]!.prefix.includes('画面带有柔和泛光'), false)
  assert.equal(presets[1]!.prefix.includes('画面带有柔和泛光'), true)
  assert.throws(() => parseScriptVideoStylePresets('只剩正文'), /两个分区/u)
})

test('改源文件立即更新同一运行进程的预设和版本，返回值不能污染缓存', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'style-source-'))
  const previous = process.env.SCRIPT_VIDEO_STYLE_SOURCE
  try {
    const file = path.join(root, '预设.txt')
    process.env.SCRIPT_VIDEO_STYLE_SOURCE = file
    writeFileSync(file, '冷色调\r\n\r\n旧风格\r\n\r\n暖色调\r\n暖光\r\n')
    const first = getCurrentScriptVideoStylePresets(), revision = getCurrentScriptVideoStyleRevision()
    first[0]!.prefix = '不应写入缓存'
    assert.match(getCurrentScriptVideoStylePresets()[0]!.prefix, /旧风格/u)
    writeFileSync(file, '冷色调\r\n\r\n新的冷色风格\r\n\r\n暖色调\r\n暖光也更新\r\n')
    assert.notEqual(getCurrentScriptVideoStyleRevision(), revision)
    assert.match(getCurrentScriptVideoStylePresets()[0]!.prefix, /新的冷色风格/u)
    assert.match(resolveBuiltinStyleSnapshot({ id: 'cool', name: '冷色调', prefix: '旧风格' })!.prefix, /新的冷色风格/u)
    assert.equal(resolveBuiltinStyleSnapshot({ id: 'custom', name: '冷色调', prefix: '手写风格' }), undefined)
    assert.equal(resolveBuiltinStyleSnapshot({ id: 'cool', name: '我自己的风格', prefix: '手写风格' }), undefined)
  } finally {
    if (previous === undefined) delete process.env.SCRIPT_VIDEO_STYLE_SOURCE
    else process.env.SCRIPT_VIDEO_STYLE_SOURCE = previous
    rmSync(root, { recursive: true, force: true })
  }
})

test('桌面工作区的预设优先于源码中的默认副本', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'style-workspace-'))
  const previousWorkspace = process.env.WORKSPACE_PATH, previousSource = process.env.SCRIPT_VIDEO_STYLE_SOURCE
  try {
    delete process.env.SCRIPT_VIDEO_STYLE_SOURCE
    process.env.WORKSPACE_PATH = root
    const file = path.join(root, 'skills/script-to-video/references/项目风格前缀原文.txt')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, '冷色调\n桌面自带预设\n\n暖色调\n桌面暖色预设\n')
    assert.match(getCurrentScriptVideoStylePresets()[0]!.prefix, /桌面自带预设/u)
  } finally {
    if (previousWorkspace === undefined) delete process.env.WORKSPACE_PATH
    else process.env.WORKSPACE_PATH = previousWorkspace
    if (previousSource === undefined) delete process.env.SCRIPT_VIDEO_STYLE_SOURCE
    else process.env.SCRIPT_VIDEO_STYLE_SOURCE = previousSource
    rmSync(root, { recursive: true, force: true })
  }
})
