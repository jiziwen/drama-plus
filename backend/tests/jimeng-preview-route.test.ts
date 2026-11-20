import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import type { ScriptVideoCard, ScriptVideoProduction } from '../src/services/script-video-types.js'

const fakeCli = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const folder = process.env.DREAMINA_CANVAS_STATE_DIR;
const args = process.argv.slice(5);
const command = args.slice(0, 2).join(' ');
const flag = name => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const ok = data => console.log(JSON.stringify({ ok: true, data }));
const subject = { userId: '123', kind: 'personal' };
const nodeFile = path.join(folder, 'node.json');
fs.appendFileSync(path.join(folder, 'commands.jsonl'), JSON.stringify({ command, args }) + '\n');
switch (command) {
  case 'auth status': ok({ loggedIn: true }); break;
  case 'auth account': ok({ userId: '123', displayName: 'Fixture', availableCredits: '120' }); break;
  case 'space current': ok(subject); break;
  case 'canvas create': ok({ project: { projectId: flag('project-id') } }); break;
  case 'model list': ok({ items: [{ model: 'seedance_2.5', displayName: 'Seedance 2.5' }] }); break;
  case 'node create': {
    const node = {
      nodeId: 'video-node', type: 'video', generation: {
        model: flag('model'), mode: flag('mode'), prompt: flag('prompt'), outputCount: Number(flag('count')),
        durationSeconds: Number(flag('duration')), ratio: flag('ratio'), resolution: flag('resolution'),
      },
    };
    fs.writeFileSync(nodeFile, JSON.stringify(node));
    ok({ node });
    break;
  }
  case 'node show': ok({ nodes: [{ nodeId: 'video-node', result: 'FOUND', node: JSON.parse(fs.readFileSync(nodeFile)) }] }); break;
  case 'node quote': ok({ consumptionSubject: subject, totalMaxCredits: 22, items: [{ nodeId: 'video-node', maxCredits: 22 }], confirmable: true, draftVersion: 1 }); break;
  case 'node confirm': ok({ consumptionSubject: subject, creditCeiling: Number(flag('credit-ceiling')), creditConfirmationToken: 'fixture-only' }); break;
  case 'node run': ok({ items: [{ nodeId: 'video-node', submitId: flag('submit-id'), state: 'ACCEPTED' }] }); break;
  case 'operation status': ok({ state: 'succeeded', resources: [{ resourceId: 'video-output', state: 'succeeded' }] }); break;
  case 'resource get': ok({ resourceId: 'video-output', type: 'video', status: 'succeeded', video: { durationSeconds: JSON.parse(fs.readFileSync(nodeFile)).generation.durationSeconds } }); break;
  case 'resource download': {
    const video = Buffer.from('0000000c667479706d703432', 'hex');
    fs.writeFileSync(flag('output'), video);
    ok({ resourceId: 'video-output', size: video.length, sha256: createHash('sha256').update(video).digest('hex') });
    break;
  }
  default: throw new Error('unexpected command: ' + command);
}
`

const script = '场景：静物台\n清晨阳光从右侧缓慢移过木桌，玻璃杯的影子轻轻移动。'
const production: ScriptVideoProduction = {
  coreRhythm: '光影平缓移动，连续完成。', visualSpecs: '16:9，720P，清晨自然光。', shotRhythm: '固定镜头。',
  dialogueRules: '无对白。', interfaceRules: '无界面。', costumeRules: '无人出镜。', sceneAndCamera: '木桌近景固定机位。',
  soundAndEditing: '室内环境底噪，完整保留固定镜头。', continuityReview: '无需与其他段落承接。', characters: [],
}
const card: ScriptVideoCard = {
  id: 'test-card', title: '静物台光影', duration: 4, summary: '静物台玻璃杯的影子随晨光移动。', assetIds: [], combat: false,
  opening: '晨光落在木桌右侧，透明玻璃杯立于桌中央。', scene: '静物台｜清晨', characters: '无人出镜。',
  independentGeneration: '固定近景观察晨光下的玻璃杯。', ending: '杯影落至桌面中部。', status: 'draft', version: 1,
  shots: [{ id: 'test-shot', duration: 4, camera: '近景固定机位，平视桌面。', action: '木桌中央的透明玻璃杯保持静止，右侧柔和晨光略微移动。', dialogue: '无对白。微弱的室内环境音。' }],
  prompt: '',
}

test('script-to-video binds a single approval to the exact quote and saves the generated clip on the card', {
  skip: process.platform === 'win32' ? 'The fixture uses an executable shebang.' : false,
  timeout: 12_000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-jimeng-preview-'))
  const binary = path.join(root, 'fake-dreamina-canvas')
  const storage = path.join(root, 'static')
  const environment = {
    SQLITE_PATH: path.join(root, 'test.sqlite3'), HUOBAO_DATA_DIR: root, STORAGE_PATH: storage,
    MYSQL_AUTO_IMPORT: 'false', DREAMINA_CANVAS_STATE_DIR: root, JIMENG_CLI_BIN: binary,
    FFMPEG_BIN: path.join(root, 'ffmpeg-not-needed'),
  }
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]))
  Object.assign(process.env, environment)
  let server: ReturnType<typeof serve> | undefined
  let closeDatabase: (() => void) | undefined
  t.after(async () => {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    closeDatabase?.()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { force: true, recursive: true })
  })
  await fs.writeFile(binary, fakeCli, { mode: 0o700 })
  const log = path.join(root, 'commands.jsonl')
  await fs.writeFile(log, '')
  const { db, schema } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const { default: routes } = await import('../src/routes/script-video.js')
  const { renderScriptVideoPrompt } = await import('../src/services/script-video-format.js')
  server = serve({ fetch: routes.fetch, hostname: '127.0.0.1', port: 0, overrideGlobalObjects: false })
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'Content-Type': 'application/json', 'X-Script-Video-Session': randomUUID() }

  async function request(endpoint: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}${endpoint}`, { method, headers, body: JSON.stringify(body) })
    return { status: response.status, payload: await response.json() }
  }
  async function commands() {
    const text = await fs.readFile(log, 'utf8')
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { command: string; args: string[] })
  }
  const isMoneyCommand = (entry: { command: string }) => entry.command === 'node confirm' || entry.command === 'node run'
  const timestamp = new Date().toISOString()
  const config = db.insert(schema.aiServiceConfigs).values({ createdAt: timestamp, updatedAt: timestamp, serviceType: 'video',
    provider: 'jimeng', name: 'Fake CLI', baseUrl: '', apiKey: '', model: '["jimeng-seedance-2.5"]' }).returning().get()
  const created = await request('/projects', 'POST', { title: 'Fixture' })
  assert.equal(created.status, 201, created.payload.message)
  const project = created.payload.data
  const episode = project.episodes[0]
  const projectUrl = `/projects/${project.id}`
  const episodeUrl = `${projectUrl}/episodes/${episode.id}`
  assert.equal((await request(`${episodeUrl}/lock`, 'POST')).status, 200)
  Object.assign(episode, { script, confirmedScript: script, confirmed: true, outlineConfirmed: true, production,
    cards: [{ ...card, prompt: renderScriptVideoPrompt(card, [], production) }] })
  const saved = await request(projectUrl, 'PUT', { project, expectedRevision: project.revision })
  assert.equal(saved.status, 200, saved.payload.message)
  const videoUrl = `${episodeUrl}/cards/${card.id}/video`
  const body = { model: 'jimeng-seedance-2.5', configId: config.id, expectedCardVersion: card.version, resolution: '720p', aspectRatio: '16:9', duration: 12 }
  const preview = await request(`${episodeUrl}/final-prompt`, 'POST', { ...body, cardId: card.id, cardVersion: card.version })
  assert.equal(preview.status, 200, preview.payload.message)
  assert.match(preview.payload.data.prompt, /总时长：12秒/u)
  assert.match(preview.payload.data.prompt, /镜头\s*01（0–12秒）/u)

  const missing = await request(videoUrl, 'POST', body)
  assert.equal(missing.status, 400, missing.payload.message)
  assert.match(missing.payload.message, /报价/)
  assert.equal((await commands()).length, 0)
  const quote = await request(`${videoUrl}/quote`, 'POST', body)
  assert.equal(quote.status, 200, quote.payload.message)
  assert.equal(quote.payload.data.credits, 22)
  const quotedVideo = JSON.parse(await fs.readFile(path.join(root, 'node.json'), 'utf8'))
  assert.equal(quotedVideo.generation.durationSeconds, 12)
  assert.equal(quotedVideo.generation.prompt, preview.payload.data.prompt)
  assert.equal((await commands()).filter(isMoneyCommand).length, 0)

  const approved = { ...body, jimengQuoteId: quote.payload.data.quote_id }
  const modified = await request(videoUrl, 'POST', { ...approved, aspectRatio: '9:16' })
  assert.equal(modified.status, 400, modified.payload.message)
  assert.match(modified.payload.message, /报价/)
  const changedDuration = await request(videoUrl, 'POST', { ...approved, duration: 13 })
  assert.equal(changedDuration.status, 400, changedDuration.payload.message)
  assert.match(changedDuration.payload.message, /报价/)
  assert.equal(db.select().from(schema.sysTask).all().length, 0)
  assert.equal((await commands()).filter(isMoneyCommand).length, 0)

  const started = await request(videoUrl, 'POST', approved)
  assert.equal(started.status, 201, started.payload.message)
  const taskUrl = `${projectUrl}/video/${started.payload.data.taskId}`
  const deadline = Date.now() + 6_000
  let result = await request(taskUrl)
  while (result.payload.data?.status === 'processing' && Date.now() < deadline) {
    await delay(20)
    result = await request(taskUrl)
  }
  assert.equal(result.payload.data?.status, 'completed', result.payload.data?.error || result.payload.message)
  const localVideo = result.payload.data.videoUrl as string
  assert.match(localVideo, /^\/?static\/videos\/jimeng-[a-f\d-]{36}\.mp4$/u)
  const updatedEpisode = (await request(projectUrl)).payload.data.episodes[0]
  const updated = updatedEpisode.cards[0]
  assert.equal(updated.status, 'ready')
  assert.equal(updated.videoUrl, localVideo)
  assert.equal(updated.duration, 4)
  assert.equal(updated.shots[0].duration, 4)
  assert.equal(updatedEpisode.tasks.find((task: { taskId: number }) => task.taskId === started.payload.data.taskId).duration, 12)
  assert.equal((await fs.readFile(path.join(root, localVideo.replace(/^\//, '')))).toString('hex'), '0000000c667479706d703432')

  const replay = await request(videoUrl, 'POST', approved)
  assert.equal(replay.status, 400, replay.payload.message)
  assert.match(replay.payload.message, /报价/)
  assert.equal(db.select().from(schema.sysTask).all().length, 1)
  const paid = (await commands()).filter(isMoneyCommand)
  assert.deepEqual(paid.map(entry => entry.command), ['node confirm', 'node run'])
  assert.ok(paid[0].args.includes('--credit-ceiling=22'))
})
