import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('LibTV creates and reuses a personal canvas per authorized account', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'drama-libtv-project-'))
  const previousData = process.env.HUOBAO_DATA_DIR
  const previousProject = process.env.LIBTV_PROJECT_ID
  process.env.HUOBAO_DATA_DIR = root
  delete process.env.LIBTV_PROJECT_ID
  t.after(async () => {
    if (previousData === undefined) delete process.env.HUOBAO_DATA_DIR
    else process.env.HUOBAO_DATA_DIR = previousData
    if (previousProject === undefined) delete process.env.LIBTV_PROJECT_ID
    else process.env.LIBTV_PROJECT_ID = previousProject
    await rm(root, { recursive: true, force: true })
  })
  const { activeLibTVCanvas, ensureLibTVCanvas } = await import('../src/services/libtv-project.js')
  const firstId = '070051fb-a9aa-4412-8c56-69a84e3858f5'
  const secondId = '17974d60-7973-4f68-945e-63f8342ea232'
  const requests: string[][] = []
  const create = async (args: string[]) => {
    requests.push(args)
    if (args[1] === 'list') return { projectMetaList: [] }
    return { projectUuid: firstId }
  }

  assert.equal(activeLibTVCanvas('account-a'), undefined)
  const first = await Promise.all(Array.from({ length: 8 }, () => ensureLibTVCanvas('account-a', create)))
  assert.ok(first.every(canvas => canvas.id === firstId))
  assert.deepEqual(requests, [
    ['project', 'list', '--name', '小李短剧 · 剧本转视频', '--team-id', '0', '--workspace', '0'],
    ['project', 'create', '小李短剧 · 剧本转视频', '--team-id', '0', '--workspace', '0'],
  ])
  assert.equal(activeLibTVCanvas('account-b'), undefined)
  const second = await ensureLibTVCanvas('account-b', async args => {
    assert.equal(args[1], 'list')
    return { projectMetaList: [
      { name: '无关画布', uuid: firstId },
      { name: '小李短剧 · 剧本转视频', uuid: secondId },
    ] }
  })
  assert.equal(second.id, secondId)
  assert.equal((await ensureLibTVCanvas('account-a', create)).id, firstId)
  assert.equal(requests.length, 2)
  const wrappedCalls: string[] = []
  const wrapped = await ensureLibTVCanvas('account-with-wrapped-response', async args => {
    wrappedCalls.push(args[1])
    if (args[1] === 'create') return { projectMeta: { uuid: secondId } }
    return { projectMetaList: wrappedCalls.length === 1 ? [] : [{ name: '小李短剧 · 剧本转视频', uuid: secondId }] }
  })
  assert.equal(wrapped.id, secondId)
  assert.deepEqual(wrappedCalls, ['list', 'create', 'list'])
  for (const file of await readdir(path.join(root, 'libtv'))) {
    assert.equal((await stat(path.join(root, 'libtv', file))).mode & 0o777, 0o600)
  }

  process.env.LIBTV_PROJECT_ID = firstId
  assert.equal((await ensureLibTVCanvas('account-c', create)).id, firstId)
  assert.equal(requests.length, 2)
})
