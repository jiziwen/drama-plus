import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { AIConfig } from '../src/services/adapters/types.js'
import type { GenerateVideoParams } from '../src/services/generation.js'

test('即梦上传展示名按完整附件顺序编号，两种正文都保持类型内引用和原始文件', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'jimeng-reference-names-'))
  const binary = path.join(folder, 'fake-dreamina-canvas')
  const stateFile = path.join(folder, 'state.json')
  const logFile = path.join(folder, 'commands.jsonl')
  const storage = path.join(folder, 'static')
  const uploads = path.join(storage, 'uploads')
  await fs.mkdir(uploads, { recursive: true })
  const variables = {
    JIMENG_CLI_BIN: binary, JIMENG_CLI_PROFILE: 'reference-names-fixture',
    DREAMINA_CANVAS_STATE_DIR: folder, VIDEO_CLI_ACCOUNTS_DIR: path.join(folder, 'profiles'),
    STORAGE_PATH: storage, HUOBAO_DATA_DIR: folder, SQLITE_PATH: path.join(folder, 'test.sqlite3'), MYSQL_AUTO_IMPORT: 'false',
  }
  const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]))
  Object.assign(process.env, variables)
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(folder, { recursive: true, force: true })
  })
  await fs.writeFile(binary, String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const folder = process.env.DREAMINA_CANVAS_STATE_DIR
const stateFile = path.join(folder, 'state.json')
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(5)
const command = args.slice(0, 2).join(' ')
const flag = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3)
const ok = data => console.log(JSON.stringify({ ok: true, data }))
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
fs.appendFileSync(path.join(folder, 'commands.jsonl'), JSON.stringify({ command, args }) + '\n')
switch (command) {
  case 'space current': ok({ userId: 'reference-name-user', kind: 'personal' }); break
  case 'canvas create': ok({ project: { projectId: flag('project-id') } }); break
  case 'resource upload': {
    const file = flag('file')
    const resource = { resourceId: flag('resource-id'), kind: flag('type'), name: flag('name'), file,
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
    state.uploads.push(resource)
    save()
    ok({ resourceId: resource.resourceId, mediaType: resource.kind })
    break
  }
  case 'model list': ok({ items: [{ model: 'seedance_2.5', displayName: 'Seedance 2.5' }] }); break
  case 'node create': {
    const references = args.filter(arg => arg.startsWith('--ref=res:')).map(arg => {
      const id = arg.slice('--ref=res:'.length)
      const resource = state.uploads.find(item => item.resourceId === id)
      return { kind: 'resource', id, type: resource.kind }
    })
    state.generation = { mode: flag('mode'), model: flag('model'), prompt: state.rebuiltPrompt || flag('prompt'),
      ratio: flag('ratio'), resolution: flag('resolution'), durationSeconds: Number(flag('duration')),
      outputCount: Number(flag('count')), references: state.reverse ? references.reverse() : references }
    save()
    ok({ node: { nodeId: 'node_reference_names' } })
    break
  }
  case 'node show': ok({ nodes: [{ result: 'FOUND', node: { nodeId: 'node_reference_names', type: 'video', generation: state.generation } }] }); break
  case 'node quote': ok({ consumptionSubject: { kind: 'personal', userId: 'reference-name-user' },
    items: [{ nodeId: 'node_reference_names', maxCredits: 7 }], totalMaxCredits: 7, draftVersion: 1, confirmable: true }); break
  case 'node confirm': ok({ consumptionSubject: { kind: 'personal', userId: 'reference-name-user' }, creditCeiling: 7, creditConfirmationToken: 'mock-only-token' }); break
  case 'node run': ok({ items: [{ nodeId: 'node_reference_names', submitId: flag('submit-id'), state: 'ACCEPTED' }] }); break
  default: throw Error('Unexpected mock command: ' + command)
}
`, { mode: 0o700 })
  const { prepareJimengVideo } = await import('../src/services/jimeng-video.js')
  const { runJimengVideo, uploadJimengReference } = await import('../src/services/jimeng-cli.js')
  const config: AIConfig = { provider: 'jimeng', model: 'jimeng-seedance-2.5', baseUrl: '', apiKey: '' }
  const images = Array.from({ length: 8 }, () => `/static/uploads/${randomUUID()}.png`)
  const audios = Array.from({ length: 3 }, () => `/static/uploads/${randomUUID()}.wav`)
  const video = `/static/uploads/${randomUUID()}.mp4`
  const allFiles = [...images, ...audios, video]
  for (const [index, url] of allFiles.entries()) await fs.writeFile(path.join(storage, url.slice('/static/'.length)), `fixture-${index}`)
  const originalNames = await fs.readdir(uploads)
  const originalHashes = await Promise.all(originalNames.map(async name => createHash('sha256').update(await fs.readFile(path.join(uploads, name))).digest('hex')))
  const reset = async (state: Record<string, unknown> = {}) => {
    await fs.writeFile(stateFile, JSON.stringify({ uploads: [], ...state }))
    await fs.writeFile(logFile, '')
  }
  const state = async () => JSON.parse(await fs.readFile(stateFile, 'utf8'))
  const commands = async () => (await fs.readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const input = (prompt: string, extra: Partial<GenerateVideoParams> = {}): GenerateVideoParams => ({
    prompt, duration: 4, aspectRatio: '16:9', resolution: '720p', referenceImageUrls: images, referenceAudioUrls: audios, ...extra,
  })

  for (const [mode, prompt] of [
    ['inline', '画面：@图片8角色甲看向@图片2角色乙。对白：角色甲@音频1：“请看图片8。”角色乙@音频3：“好。”'],
    ['reference-guide', '素材说明：@图片8是角色甲，@图片2是角色乙。@音频1是角色甲声音，@音频3是角色乙声音。\n\n画面：角色甲看向角色乙。对白：角色甲@音频1：“请看图片8。”角色乙@音频3：“好。”'],
  ]) await t.test(`${mode}：八图三音显示音频9至11，绑定仍选第一至第三条音频`, async () => {
    await reset({ reverse: true })
    await prepareJimengVideo(input(prompt), config)
    const saved = await state()
    assert.deepEqual(saved.uploads.map((resource: any) => resource.name), [
      ...Array.from({ length: 8 }, (_, index) => `图片${index + 1}`), '音频9', '音频10', '音频11',
    ])
    assert.deepEqual(saved.uploads.map((resource: any) => resource.file), await Promise.all(
      [...images, ...audios].map(url => fs.realpath(path.join(storage, url.slice('/static/'.length)))),
    ))
    const create = (await commands()).find(command => command.command === 'node create')
    const sent = create.args.find((arg: string) => arg.startsWith('--prompt=')).slice('--prompt='.length)
    assert.ok(sent.includes(`{{res:${saved.uploads[7].resourceId}}}是角色甲`) || sent.includes(`{{res:${saved.uploads[7].resourceId}}}角色甲`))
    assert.ok(sent.includes(`角色甲{{res:${saved.uploads[8].resourceId}}}`))
    assert.ok(sent.includes(`角色乙{{res:${saved.uploads[10].resourceId}}}`))
    assert.ok(sent.includes('请看图片8。'), '对白内的字面图片编号不被误绑定')
    assert.ok(!sent.includes('@音频9'), '展示用全局编号不回流到内部类型编号')
  })

  await t.test('混合图片、视频和音频继续按同一附件总序编号', async () => {
    await reset()
    await prepareJimengVideo(input('参考@图片2和@视频1，使用@音频1。', {
      referenceImageUrls: images.slice(0, 2), referenceVideoUrls: [video], referenceAudioUrls: audios.slice(0, 1),
    }), config)
    const saved = await state()
    assert.deepEqual(saved.uploads.map((resource: any) => resource.name), ['图片1', '图片2', '视频3', '音频4'])
    assert.equal(saved.generation.prompt, `参考{{res:${saved.uploads[1].resourceId}}}和{{res:${saved.uploads[2].resourceId}}}，使用{{res:${saved.uploads[3].resourceId}}}。`)
  })

  await t.test('首尾帧命名、官方提示词重建与已保存任务恢复不改变引用身份', async () => {
    await reset({ rebuiltPrompt: '官方画布重建后的首尾帧提示词。' })
    const run = await prepareJimengVideo(input('从@图片1连续到@图片2。', {
      referenceImageUrls: [], referenceAudioUrls: [], firstFrameUrl: images[0], lastFrameUrl: images[1],
    }), config)
    assert.deepEqual((await state()).uploads.map((resource: any) => resource.name), ['图片1', '图片2'])
    await fs.writeFile(logFile, '')
    await runJimengVideo(run)
    assert.deepEqual((await commands()).map(command => command.command), ['space current', 'node show', 'node quote', 'node confirm', 'node run'])
    const edited = await state()
    edited.generation.prompt += '编辑'
    await fs.writeFile(stateFile, JSON.stringify(edited))
    await assert.rejects(runJimengVideo(run), /草稿已变更/u)
  })

  await t.test('旧上传调用可继续省略展示名，不改变文件或资源类型', async () => {
    await reset()
    await uploadJimengReference(randomUUID(), path.join(uploads, path.basename(images[0])), 'image')
    const upload = (await commands()).find(command => command.command === 'resource upload')
    assert.ok(!upload.args.some((arg: string) => arg.startsWith('--name=')))
  })
  assert.deepEqual(await fs.readdir(uploads), originalNames)
  assert.deepEqual(await Promise.all(originalNames.map(async name => createHash('sha256').update(await fs.readFile(path.join(uploads, name))).digest('hex'))), originalHashes)
})
