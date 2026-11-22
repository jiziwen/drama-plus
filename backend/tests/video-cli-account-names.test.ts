import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createVideoCliAccount, listVideoCliAccounts, removeVideoCliAccount, renameVideoCliAccount, updateVideoCliAccountNameFromPlatform } from '../src/services/video-cli-accounts.js'

test('automatic platform names persist per provider and account while personal labels always win', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-cli-account-names-'))
  const previous = process.env.VIDEO_CLI_ACCOUNTS_DIR
  process.env.VIDEO_CLI_ACCOUNTS_DIR = directory
  t.after(async () => { if (previous === undefined) delete process.env.VIDEO_CLI_ACCOUNTS_DIR; else process.env.VIDEO_CLI_ACCOUNTS_DIR = previous; await rm(directory, { recursive: true, force: true }) })
  for (const provider of ['jimeng', 'libtv'] as const) {
    const a = createVideoCliAccount(provider)
    const b = createVideoCliAccount(provider)
    const manual = createVideoCliAccount(provider, '我的旧备注')
    updateVideoCliAccountNameFromPlatform(provider, a.id, '官网账号甲')
    updateVideoCliAccountNameFromPlatform(provider, b.id, '官网账号乙')
    updateVideoCliAccountNameFromPlatform(provider, manual.id, '不能覆盖手动名字')
    let entries = listVideoCliAccounts(provider)
    assert.equal(entries.find(entry => entry.id === a.id)!.name, '官网账号甲')
    assert.equal(entries.find(entry => entry.id === b.id)!.name, '官网账号乙')
    assert.equal(entries.find(entry => entry.id === manual.id)!.name, '我的旧备注')
    assert.deepEqual(Object.keys(a).sort(), ['id', 'name'])
    assert.ok(entries.every(entry => !('autoNamed' in entry)))
    renameVideoCliAccount(provider, a.id, '默认账号')
    updateVideoCliAccountNameFromPlatform(provider, a.id, '新的官网昵称')
    entries = listVideoCliAccounts(provider)
    assert.equal(entries.find(entry => entry.id === a.id)!.name, '默认账号', 'even a generic-looking explicit label is protected')
    const saved = JSON.parse(await readFile(path.join(directory, `${provider}.json`), 'utf8'))
    assert.equal(saved.accounts.find((entry: { id: string }) => entry.id === a.id).autoNamed, false)
    assert.equal(saved.accounts.find((entry: { id: string }) => entry.id === b.id).autoNamed, true)
    removeVideoCliAccount(provider, b.id)
    updateVideoCliAccountNameFromPlatform(provider, b.id, '延迟返回的旧账号昵称')
    assert.equal(listVideoCliAccounts(provider).some(entry => entry.id === b.id), false)
  }
})

test('legacy saved personal labels are retained and the legacy default slot can acquire its platform name', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'drama-cli-legacy-names-'))
  const previous = process.env.VIDEO_CLI_ACCOUNTS_DIR
  process.env.VIDEO_CLI_ACCOUNTS_DIR = directory
  t.after(async () => { if (previous === undefined) delete process.env.VIDEO_CLI_ACCOUNTS_DIR; else process.env.VIDEO_CLI_ACCOUNTS_DIR = previous; await rm(directory, { recursive: true, force: true }) })
  for (const provider of ['jimeng', 'libtv'] as const) {
    const oldId = randomUUID()
    await writeFile(path.join(directory, `${provider}.json`), JSON.stringify({ activeAccountId: 'default', accounts: [{ id: 'default', name: '默认账号' }, { id: oldId, name: '账号 2' }] }))
    updateVideoCliAccountNameFromPlatform(provider, oldId, '不覆盖没有标记的旧备注')
    updateVideoCliAccountNameFromPlatform(provider, 'default', '默认槽的官网昵称')
    let entries = listVideoCliAccounts(provider)
    assert.equal(entries.find(entry => entry.id === oldId)!.name, '账号 2')
    assert.equal(entries.find(entry => entry.id === 'default')!.name, '默认槽的官网昵称')
    renameVideoCliAccount(provider, 'default', '默认账号')
    updateVideoCliAccountNameFromPlatform(provider, 'default', '不能再自动覆盖')
    entries = listVideoCliAccounts(provider)
    assert.equal(entries.find(entry => entry.id === 'default')!.name, '默认账号')
  }
})
