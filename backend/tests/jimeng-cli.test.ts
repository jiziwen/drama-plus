import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createJimengVideoDraft, disconnectJimengAccount, downloadJimengVideo, getJimengAccount, getJimengVideoModels, inspectJimengVideo, JimengCliError, runJimengVideo, startJimengAuthorization } from '../src/services/jimeng-cli.js'

test('Jimeng submits the original personal draft once and still honors a legacy approved ceiling', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-jimeng-cli-'))
  const script = path.join(folder, 'fake-dreamina-canvas')
  const log = path.join(folder, 'commands.jsonl')
  const stateFile = path.join(folder, 'state.json')
  const vars = { JIMENG_CLI_BIN: process.env.JIMENG_CLI_BIN, DREAMINA_CANVAS_STATE_DIR: process.env.DREAMINA_CANVAS_STATE_DIR,
    VIDEO_CLI_ACCOUNTS_DIR: process.env.VIDEO_CLI_ACCOUNTS_DIR }
  process.env.JIMENG_CLI_BIN = script
  process.env.DREAMINA_CANVAS_STATE_DIR = folder
  process.env.VIDEO_CLI_ACCOUNTS_DIR = path.join(folder, 'profiles')
  t.after(async () => {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(folder, { force: true, recursive: true })
  })
  await fs.writeFile(script, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const folder = process.env.DREAMINA_CANVAS_STATE_DIR;
const args = process.argv.slice(5);
const cmd = args.slice(0, 2).join(' ');
const flag = name => args.find(value => value.startsWith('--' + name + '='))?.split('=').slice(1).join('=');
fs.appendFileSync(path.join(folder, 'commands.jsonl'), JSON.stringify({cmd, args}) + '\\n');
const state = JSON.parse(fs.readFileSync(path.join(folder, 'state.json'), 'utf8'));
const userId = state.userId || '18446744073709551615';
const subject = {userId, kind: state.team ? 'team' : 'personal'};
const nodeId = 'node_test';
const node = {nodeId, type: 'video', generation: {mode: state.mode || 't2v', prompt: state.prompt || '--literal', model: 'seedance_2.5', ratio: '16:9', resolution: '720P', durationSeconds: 4, outputCount: 1, references: state.references || []}};
const ok = data => console.log(JSON.stringify({ok: true,data}));
switch (cmd) {
  case 'auth status': ok({loggedIn: true}); break;
  case 'auth account': console.log('{"ok":true,"data":{"userId":' + userId + ',"displayName":"Test User","availableCredits":"120.5"}}'); break;
  case 'space current': ok({ userId, kind: state.teamSpace ? 'team' : 'personal' }); break;
  case 'model list': ok({items: [
    {model: 'seedance_2.5', displayName: 'Seedance 2.5'},
    {model: 'seedance_2.5_draft', displayName: 'Seedance 2.5', aliases: ['Seedance 2.5']},
    {model: 'seedance_2.5_flash', displayName: 'Seedance 2.5 Flash', aliases: ['Seedance 2.5']},
  ]}); break;
  case 'node create': ok({node:{nodeId}}); break;
  case 'node show': ok({nodes: [{result: 'FOUND', node}]}); break;
  case 'node quote': ok({consumptionSubject: subject, items: [{nodeId,maxCredits:state.credits}], totalMaxCredits: state.credits, confirmable: true, draftVersion: 2}); break;
  case 'node confirm': ok({consumptionSubject: subject, creditCeiling:Number(flag('credit-ceiling')), creditConfirmationToken:'test-in-memory-token'}); break;
  case 'node run':
    if (state.ambiguous) {
      console.error(JSON.stringify({ok: false,error:{code:40012,message:'Contains fake token'}}));
      process.exitCode = 20;
    } else {
      ok({items:[{nodeId,submitId:flag('submit-id'),state:'ACCEPTED'}]});
    }
    break;
  case 'operation status': ok({state:'succeeded', resources:[{resourceId:'resource_1', state:'succeeded'}]}); break;
  case 'resource get': ok({resourceId:'resource_1', type:'video', status:'succeeded', video:{durationSeconds:4}}); break;
  case 'resource download': {
    const media = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('ftypmp42')]);
    fs.writeFileSync(flag('output'), media);
    const sha256 = state.invalidHash ? 'invalid' : createHash('sha256').update(media).digest('hex');
    ok({resourceId:'resource_1', size:media.length, sha256});
    break;
  }
}
`, { mode: 0o700 })
  const reset = async (state: Record<string, unknown> = {}) => {
    await fs.writeFile(stateFile, JSON.stringify({ credits: 70, ...state }))
    await fs.writeFile(log, '')
  }
  const commands = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  await reset()
  const account = await getJimengAccount()
  assert.equal(account.accountId, '18446744073709551615')
  assert.equal(account.credits, 120.5)
  assert.deepEqual((await getJimengVideoModels()).map(model => [model.id, model.canonicalModel]), [
    ['jimeng-seedance-2.5', 'seedance_2.5'], ['jimeng-seedance-2.5-draft', 'seedance_2.5_draft'],
    ['jimeng-seedance-2.5-flash', 'seedance_2.5_flash'],
  ])
  const draft = {
    projectId: randomUUID(), model: 'jimeng-seedance-2.5', prompt: '--literal',
    mode: 't2v', aspectRatio: '16:9', duration: 4, resolution: '720p',
  } as const
  const runInput = await createJimengVideoDraft(draft, account.accountId!)
  assert.deepEqual((await commands()).slice(-3).map(entry => entry.cmd), ['model list', 'node create', 'node show'])
  assert.ok((await commands()).find(entry => entry.cmd === 'node create').args.includes('--prompt=--literal'))

  const references = [
    { kind: 'image', resourceId: 'resource_1' },
    { kind: 'image', resourceId: 'resource_2' },
  ] as const
  const savedReferences = references.map(ref => ({ kind: 'resource', type: ref.kind, id: ref.resourceId })).reverse()
  await reset({ mode: 'm2v', references: savedReferences })
  const multimodalDraft = await createJimengVideoDraft({ ...draft, mode: 'm2v', references }, runInput.accountId)
  assert.equal(multimodalDraft.nodeId, runInput.nodeId)
  await reset({ mode: 'first_last_frame', references: savedReferences })
  await assert.rejects(createJimengVideoDraft({ ...draft, mode: 'first_last_frame', references }, runInput.accountId), /参考素材/)
  assert.equal((await commands()).some(entry => entry.cmd === 'node quote'), false)

  for (const [state, message] of [
    [{ prompt: 'Edited in the official canvas' }, /草稿已变更/],
    [{ userId: '18446744073709551616' }, /授权账号已变更/],
    [{ team: true }, /消费归属/],
    [{ teamSpace: true }, /个人空间/],
  ] as const) {
    await reset(state)
    await assert.rejects(runJimengVideo(runInput), message)
    assert.equal((await commands()).some(entry => ['node confirm', 'node run'].includes(entry.cmd)), false)
  }

  await reset({ credits: 71 })
  await assert.rejects(runJimengVideo({ ...runInput, credits: 70 }), /超过已确认的积分上限/)
  assert.equal((await commands()).some(entry => ['node confirm', 'node run'].includes(entry.cmd)), false)

  await reset()
  await runJimengVideo(runInput)
  assert.deepEqual((await commands()).map(entry => entry.cmd), ['space current', 'node show', 'node quote', 'node confirm', 'node run'])
  assert.ok((await commands()).find(entry => entry.cmd === 'node confirm').args.includes('--credit-ceiling=70'))
  assert.ok((await commands()).find(entry => entry.cmd === 'node run').args.includes(`--submit-id=${runInput.submitId}`))

  await reset({ ambiguous: true })
  await assert.rejects(runJimengVideo(runInput), error => error instanceof JimengCliError && error.possiblySubmitted && error.code === 40012)
  assert.equal((await commands()).filter(entry => entry.cmd === 'node run').length, 1)

  const result = await inspectJimengVideo(runInput.projectId, runInput.submitId)
  assert.deepEqual(result, { state: 'completed', resourceId: 'resource_1', duration: 4 })
  const destination = path.join(folder, 'result.mp4')
  await downloadJimengVideo(runInput.projectId, 'resource_1', destination)
  assert.equal((await fs.stat(destination)).size, 12)
  await reset({ invalidHash: true })
  await assert.rejects(downloadJimengVideo(runInput.projectId, 'resource_1', destination), /视频文件校验失败/)
})

test('disconnect clears the Jimeng profile and prevents old authorization from restoring credentials', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-jimeng-disconnect-'))
  const binary = path.join(folder, 'mock-dreamina-canvas')
  const vars = {
    JIMENG_CLI_BIN: binary, JIMENG_CLI_PROFILE: 'disconnect-fixture', DREAMINA_CANVAS_STATE_DIR: folder,
    VIDEO_CLI_ACCOUNTS_DIR: path.join(folder, 'profiles'),
    SQLITE_PATH: path.join(folder, 'tasks.sqlite3'), MYSQL_AUTO_IMPORT: 'false',
  }
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]))
  Object.assign(process.env, vars)
  let closeDatabase: (() => void) | undefined
  t.after(async () => {
    closeDatabase?.()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(folder, { recursive: true, force: true })
  })
  await fs.writeFile(binary, String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
if (process.argv[4] !== '--profile=disconnect-fixture') process.exit(1)
const directory = process.env.DREAMINA_CANVAS_STATE_DIR
const file = name => path.join(directory, name)
const log = name => fs.appendFileSync(file('commands'), name + '\n')
const ok = data => console.log(JSON.stringify({ ok: true, data }))
const [group, command, flag] = process.argv.slice(5)
if (group !== 'auth') process.exit(1)
switch (command) {
  case 'status': ok({ loggedIn: fs.existsSync(file('account')) }); break
  case 'account': ok(JSON.parse(fs.readFileSync(file('account'), 'utf8'))); break
  case 'logout':
    log('logout')
    fs.rmSync(file('account'), { force: true })
    ok({ loggedOut: true })
    break
  case 'login': {
    const deviceCode = fs.existsSync(file('started')) ? 'new-login' : 'old-login'
    log('login:' + deviceCode)
    ok({ status: 'authorization_required', challenge: { deviceCode, verificationUri: 'https://jimeng.jianying.com/authorize' } })
    break
  }
  case 'wait': {
    const code = flag.slice('--device-code='.length)
    log('wait:' + code)
    fs.writeFileSync(file('started'), code)
    const timer = setInterval(() => {
      if (!fs.existsSync(file('approved-' + code))) return
      clearInterval(timer)
      fs.writeFileSync(file('account'), JSON.stringify({ userId: '302', displayName: code }))
      ok({ status: 'logged_in' })
    }, 5)
    setTimeout(() => process.exit(1), 3000).unref()
    break
  }
  default: process.exit(1)
}
`, { mode: 0o700 })
  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 1500
    while (!await check()) {
      assert.ok(Date.now() < deadline, 'timed out waiting for the test CLI')
      await delay(5)
    }
  }
  const started = path.join(folder, 'started')
  await fs.writeFile(path.join(folder, 'account'), JSON.stringify({ userId: '301', displayName: 'Original account' }))
  assert.equal((await getJimengAccount()).username, 'Original account')
  const { db, schema } = await import('../src/db/index.js')
  closeDatabase = () => db.$client.close()
  const date = new Date().toISOString()
  db.insert(schema.sysTask).values({ type: 'video', provider: 'jimeng', status: 'processing', createdAt: date, updatedAt: date }).run()
  await assert.rejects(disconnectJimengAccount(), error => error instanceof JimengCliError && error.reason === 'account_busy')
  assert.equal((await getJimengAccount()).username, 'Original account')
  db.delete(schema.sysTask).run()
  await disconnectJimengAccount()
  assert.equal((await getJimengAccount()).authenticated, false)
  assert.equal((await startJimengAuthorization()).pending, true)
  await waitFor(() => fs.access(started).then(() => true, () => false))
  assert.equal((await getJimengAccount()).authorizationPending, true)
  const disconnecting = disconnectJimengAccount()
  await assert.rejects(startJimengAuthorization(), error => error instanceof JimengCliError && error.reason === 'account_busy')
  await disconnecting
  await fs.writeFile(path.join(folder, 'approved-old-login'), '')
  assert.deepEqual(await getJimengAccount(), { available: true, authenticated: false, authorizationPending: false, message: undefined })
  assert.equal((await startJimengAuthorization()).pending, true)
  await fs.writeFile(path.join(folder, 'approved-new-login'), '')
  await waitFor(async () => (await getJimengAccount()).username === 'new-login')
  assert.deepEqual((await fs.readFile(path.join(folder, 'commands'), 'utf8')).trim().split('\n'), [
    'logout', 'login:old-login', 'wait:old-login', 'logout', 'login:new-login', 'wait:new-login',
  ])
})
