import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'

function wav(seconds: number) {
  const size = 8000 * 2 * seconds, buffer = Buffer.alloc(44 + size)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(size, 40)
  return buffer
}

test('即梦真实提交准备链路保持说话角色、上传音频和画布资源的一一对应，不执行计费生成', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jimeng-voice-identity-'))
  const savedEnvironment = Object.fromEntries(['SQLITE_PATH', 'HUOBAO_DATA_DIR', 'STORAGE_PATH', 'MYSQL_AUTO_IMPORT',
    'VIDEO_CLI_ACCOUNTS_DIR', 'JIMENG_CLI_BIN', 'FFMPEG_BIN', 'FFPROBE_BIN'].map(key => [key, process.env[key]]))
  Object.assign(process.env, {
    SQLITE_PATH: path.join(root, 'isolated.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: path.join(root, 'static'),
    MYSQL_AUTO_IMPORT: 'false', VIDEO_CLI_ACCOUNTS_DIR: path.join(root, 'profiles'), JIMENG_CLI_BIN: process.execPath,
    FFMPEG_BIN: createRequire(import.meta.url)('ffmpeg-static'), FFPROBE_BIN: createRequire(import.meta.url)('ffprobe-static').path,
  })
  const resources = new Map<string, { kind: string; file: string }>()
  const calls: string[] = []
  let draft: { prompt: string; model: string; references: { kind: string; type: string; id: string }[] }
  let closeDatabase: (() => void) | undefined
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports(); closeDatabase?.()
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  })
  t.mock.method(childProcess, 'execFile', (binary: string, args: string[], _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    assert.equal(binary, process.execPath, '只能调用被替换的即梦命令，不允许外部进程生成')
    const command = args.slice(3, 5).join(' ')
    const flag = (name: string) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
    calls.push(command)
    const ok = (data: unknown) => queueMicrotask(() => callback(null, JSON.stringify({ ok: true, data }), ''))
    if (command === 'space current') ok({ userId: 'identity-fixture', kind: 'personal' })
    else if (command === 'canvas create') ok({ project: { projectId: flag('project-id') } })
    else if (command === 'resource upload') {
      resources.set(flag('resource-id')!, { kind: flag('type')!, file: path.basename(flag('file')!) })
      ok({ resourceId: flag('resource-id'), mediaType: flag('type') })
    } else if (command === 'model list' || command === 'model ls') ok({ items: [
      { model: 'seedance_2.5', displayName: 'Seedance 2.5' },
      { model: 'seedance_2.5_flash', displayName: 'Seedance 2.5 Flash' },
    ] })
    else if (command === 'node create') {
      draft = { prompt: flag('prompt')!, model: flag('model')!, references: args.filter(arg => arg.startsWith('--ref=res:'))
        .map(arg => { const id = arg.slice('--ref=res:'.length); return { kind: 'resource', type: resources.get(id)!.kind, id } }) }
      ok({ node: { nodeId: 'isolated-node' } })
    } else if (command === 'node show') ok({ nodes: [{ result: 'FOUND', node: {
      nodeId: 'isolated-node', type: 'video', generation: { ...draft, mode: 'm2v', durationSeconds: 6,
        ratio: '16:9', resolution: '720P', outputCount: 1 },
    } }] })
    else assert.fail('禁止计费或未知命令：' + command)
    return Object.assign(new EventEmitter(), { stdin: { end() {} }, kill() { return true } })
  })
  syncBuiltinESMExports()
  const { db, schema } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const { setVideoPromptMode } = await import('../src/services/app-settings.js')
  const { getScriptVideoSubmissionPrompt, previewScriptVideoPrompt, startScriptVideoGeneration } = await import('../src/services/script-video-generation.js')
  const uploads = path.join(root, 'static/uploads')
  await fs.mkdir(uploads, { recursive: true })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64')
  for (const role of ['alpha', 'bravo']) {
    await fs.writeFile(path.join(uploads, role + '.png'), png)
    await fs.writeFile(path.join(uploads, role + '.wav'), wav(3))
  }
  await fs.writeFile(path.join(uploads, 'picked.wav'), wav(3))
  const assets = [
    { id: 'alpha', name: '顾凌天_龙袍', kind: 'character', image: '/static/uploads/alpha.png',
      voiceAudio: { url: '/static/uploads/alpha.wav', name: '皇帝声音.wav' } },
    { id: 'bravo', name: '王禄', kind: 'character', image: '/static/uploads/bravo.png',
      voiceAudio: { url: '/static/uploads/bravo.wav', name: '太监声音.wav' } },
  ]
  const normalize = (prompt: string) => prompt.replace(/\{\{res:([^}]+)\}\}/gu,
    (_, resourceId: string) => '[' + resources.get(resourceId)?.file + ']')
  const now = new Date().toISOString()
  const configId = db.insert(schema.aiServiceConfigs).values({ provider: 'jimeng', name: '隔离映射回归',
    baseUrl: '', apiKey: 'isolated-test-only', serviceType: 'video', model: JSON.stringify(['jimeng-seedance-2.5', 'jimeng-seedance-2.5-flash']),
    isActive: true, videoCliAccountId: 'default', createdAt: now, updatedAt: now }).returning().get().id
  function generationInput(prompt: string, selected = assets, assetIds = selected.map(asset => asset.id), speakerAssetIds?: string[]) {
    return { projectId: 'isolated-project', episodeId: 'isolated-episode',
      card: { id: 'isolated-card', duration: 6, assetIds, prompt,
        shots: [{ duration: 6, dialogue: speakerAssetIds ? '顾凌天：“请退下。”；王禄：“臣遵旨。”' : '', speakerAssetIds }] },
      assets: selected, configId, model: 'jimeng-seedance-2.5', aspectRatio: '16:9', resolution: '720p',
      allowJimeng: true, videoCliAccountId: 'default',
    }
  }
  async function prepare(prompt: string, selected = assets, assetIds = selected.map(asset => asset.id), speakerAssetIds?: string[]) {
    resources.clear(); calls.length = 0
    const { taskId } = await startScriptVideoGeneration(generationInput(prompt, selected, assetIds, speakerAssetIds),
      { signal: new AbortController().signal, onTaskCreated(taskId) {
      db.update(schema.sysTask).set({ status: 'canceled' }).where(eq(schema.sysTask.id, taskId)).run()
    } })
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(calls.includes('resource upload') && calls.includes('node create') && calls.includes('node show'))
    assert.ok(!calls.includes('node quote') && !calls.includes('node confirm') && !calls.includes('node run'))
    return { prompt: normalize(draft.prompt), taskId }
  }

  await t.test('图片和发声先后与资产列表顺序相反时，每个角色仍引用自己的声线', async () => {
    const prompt = ['镜头 01（0–6秒）', '画面与动作：@王禄走到@顾凌天_龙袍身前。',
      '对白／音效：@王禄：“臣遵旨。”；@顾凌天_龙袍(OS)：“先等等。”；@王禄：“陛下？”'].join('\n')
    for (const selected of [assets, [...assets].reverse()]) {
      const [guide, body] = (await prepare(prompt, selected)).prompt.split('镜头 01')
      assert.match(guide, /\[bravo\.wav\] 是 王禄 的配音音色参考/u)
      assert.match(guide, /\[alpha\.wav\] 是 顾凌天_龙袍 的配音音色参考/u)
      assert.match(body, /王禄：“臣遵旨。”/u)
      assert.match(body, /顾凌天_龙袍\(OS\) ：“先等等。”/u)
      assert.match(body, /王禄：“陛下？”/u)
      assert.doesNotMatch(body, /@|\[\w+\.(?:png|wav)\]/u)
    }
  })

  await t.test('显式选定的音频只替换指定发声者，不能被角色默认音频或另一角色覆盖', async () => {
    const selected = [...assets, { id: 'picked', name: '临时嗓音', kind: 'audio', image: '',
      voiceAudio: { url: '/static/uploads/picked.wav', name: '临时.wav' } }]
    const prompt = ['镜头 01（0–6秒）', '画面与动作：@顾凌天_龙袍望向@王禄。',
      '对白／音效：@顾凌天_龙袍 @临时嗓音：“请退下。”；@王禄：“臣遵旨。”'].join('\n')
    const [guide, body] = (await prepare(prompt, selected)).prompt.split('镜头 01')
    assert.match(guide, /\[picked\.wav\] 是 顾凌天_龙袍 的配音音色参考（声音素材：临时嗓音）/u)
    assert.match(guide, /\[bravo\.wav\] 是 王禄 的配音音色参考/u)
    assert.match(body, /顾凌天_龙袍：“请退下。”/u)
    assert.match(body, /王禄：“臣遵旨。”/u)
    assert.doesNotMatch(guide, /alpha\.wav/u)
    assert.doesNotMatch(body, /@|\[\w+\.(?:png|wav)\]/u)
  })

  await t.test('旧提示词中未绑定的音频序号被拦截，不能静默覆盖角色自己的音色', async () => {
    const prompt = ['镜头 01（0–6秒）', '画面与动作：@顾凌天_龙袍望向@王禄。',
      '对白／音效：@顾凌天_龙袍 @音频2：“请退下。”；@王禄：“臣遵旨。”'].join('\n')
    await assert.rejects(prepare(prompt, assets, ['alpha', 'bravo'], ['alpha', 'bravo']), /找不到素材 @音频2/u)
  })

  await t.test('全局模式同时影响预览和提交，绑定道具在前置区，历史任务保留已提交的版本', async () => {
    const prompt = ['镜头 01（0–6秒）', '画面与动作：@顾凌天_龙袍望向@王禄。',
      '对白／音效：@顾凌天_龙袍：“请退下。”；@王禄：“臣遵旨。”'].join('\n')
    const prop = { id: 'blade', name: '绣春刀', kind: 'prop', image: '/static/uploads/blade.png' }
    await fs.writeFile(path.join(uploads, 'blade.png'), png)
    const withProp = [...assets, prop]
    const input = generationInput(prompt, withProp)
    const preview = () => previewScriptVideoPrompt({ ...input, selection: input })

    const guide = await preview()
    assert.deepEqual(guide.audios.map(({ name, tag }) => [name, tag]), [['顾凌天_龙袍', '@音频4'], ['王禄', '@音频5']])
    assert.match(guide.prompt, /@图片3 是 绣春刀/u)
    assert.match(guide.prompt, /@音频4 是 顾凌天_龙袍 的配音音色参考/u)
    assert.match(guide.prompt, /顾凌天_龙袍：“请退下。”/u)
    assert.doesNotMatch(guide.prompt.split('镜头 01')[1], /@(?:图片\d+|音频\d+|顾凌天_龙袍|王禄)/u)
    const guided = await prepare(prompt, withProp)
    assert.match(guided.prompt, /\[blade\.png\] 是 绣春刀/u)
    assert.match(guided.prompt, /\[alpha\.wav\] 是 顾凌天_龙袍 的配音音色参考/u)
    assert.match(guided.prompt, /顾凌天_龙袍：“请退下。”/u)
    assert.doesNotMatch(guided.prompt.split('镜头 01')[1], /\[(?:alpha|bravo)\.wav\]/u)

    setVideoPromptMode('inline')
    const inline = await preview()
    assert.match(inline.prompt, /@图片1顾凌天_龙袍 @音频3：“请退下。”/u)
    assert.doesNotMatch(inline.prompt, /绣春刀/u)
    assert.match((await prepare(prompt, withProp)).prompt, /\[alpha\.png\]顾凌天_龙袍 \[alpha\.wav\]：“请退下。”/u)
    assert.equal(getScriptVideoSubmissionPrompt(guided.taskId, withProp)?.prompt, guide.prompt)
  })
})
