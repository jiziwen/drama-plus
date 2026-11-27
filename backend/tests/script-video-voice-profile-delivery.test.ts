import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const root = await mkdtemp(path.join(tmpdir(), 'script-video-voice-profile-delivery-'))
Object.assign(process.env, {
  SQLITE_PATH: path.join(root, 'tasks.sqlite3'),
  HUOBAO_DATA_DIR: root,
  STORAGE_PATH: path.join(root, 'static'),
  MYSQL_AUTO_IMPORT: 'false',
})
const { db, schema } = await import('../src/db/index.js')
const { ScriptVideoStore } = await import('../src/services/script-video-store.js')
const { saveGeneratedCharacterVoice, sameScriptVideoVoiceOwner, scriptVideoVoiceTaskScope } =
  await import('../src/services/script-video-voice-generation.js')
const store = new ScriptVideoStore(path.join(root, 'projects'))
after(async () => {
  await store.close()
  db.$client.close()
  await rm(root, { recursive: true, force: true })
})

const profile = { id: randomUUID(), key: '阿宁:adult', character: '阿宁', ageStage: 'adult', clues: [], conflicts: [] }
const youngerProfile = { ...profile, id: randomUUID(), key: '阿宁:child', ageStage: 'child' }
const character = (id: string, voiceProfile = profile) => ({
  id, kind: 'character', name: id, image: '/static/images/reference.png', voiceProfile,
})
const manual = { url: '/static/uploads/manual.mp3', name: '手动上传.mp3', mimeType: 'audio/mpeg' }
async function existingOutput(projectId: string, assetId: string, voiceProfile = profile) {
  const outputId = randomUUID()
  const uploads = path.join(root, 'static/uploads')
  await mkdir(uploads, { recursive: true })
  await writeFile(path.join(uploads, outputId + '.mp3'), 'saved output before project commit')
  return { projectId, assetId, profileId: voiceProfile.id, outputId, name: '试音.mp3', expectedUrl: null }
}

test('task lookup shares profile IDs and only associates legacy tasks for matching member assets', () => {
  const projectId = 'project-a'
  const requested = { projectId, assetId: 'portrait', profileId: profile.id, memberAssetIds: ['costume'] }
  const stored = [
    { key: 'same-profile', owner: { projectId, assetId: 'another-costume', profileId: profile.id, memberAssetIds: ['costume'] } },
    { key: 'legacy-origin', owner: { projectId, assetId: 'portrait' } },
    { key: 'legacy-member', owner: { projectId, assetId: 'costume' } },
    { key: 'different-profile', owner: { projectId, assetId: 'portrait', profileId: youngerProfile.id } },
    { key: 'other-project', owner: { projectId: 'project-b', assetId: 'portrait', profileId: profile.id } },
    { key: 'other-legacy', owner: { projectId, assetId: 'unrelated' } },
  ]
  const task = schema.sysTask
  db.insert(task).values(stored.map(({ key, owner }) => ({
    type: 'video', taskId: key, params: JSON.stringify({ scriptVideoVoice: owner }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }))).run()
  const dbMatches = (owner: typeof requested | { projectId: string; assetId: string }) => db.select({ key: task.taskId })
    .from(task).where(scriptVideoVoiceTaskScope(owner)).orderBy(task.id).all().map(row => row.key)
  const legacy = stored[2].owner
  assert.deepEqual(dbMatches(requested), ['same-profile', 'legacy-origin', 'legacy-member'])
  assert.deepEqual(dbMatches(legacy), ['same-profile', 'legacy-member'])
  for (const owner of [requested, legacy]) {
    assert.deepEqual(dbMatches(owner), stored.filter(item => sameScriptVideoVoiceOwner(owner, item.owner)).map(item => item.key))
  }
})

test('completed voice binds current profile members after the originating asset is removed', async () => {
  const project = await store.create('同龄角色音色')
  const assets = [character('costume'), character('new-costume'), { ...character('young', youngerProfile), voiceAudio: manual }]
  await store.mutateAssets(project.id, () => ({ assets, result: undefined }))
  const request = {
    ...await existingOutput(project.id, 'removed-origin'),
    memberAssetIds: ['costume', 'young'],
    description: { text: '干净平静的女声', sourceLabel: '手动编辑' },
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await saveGeneratedCharacterVoice(request, 'static/videos/task-1.mp4', store)
    const result = (await store.summary(project.id)).assets
    for (const asset of result.slice(0, 2)) {
      assert.equal(asset.voiceAudio.url, '/static/uploads/' + request.outputId + '.mp3')
      assert.deepEqual(asset.voiceDescription, request.description)
      assert.equal(asset.voiceProfile.generatedOutputId, request.outputId)
    }
    assert.deepEqual(result[2].voiceAudio, manual)
    assert.equal(result[2].voiceProfile.generatedOutputId, undefined)
  }
})

test('a distinct manual voice blocks the profile attachment atomically', async () => {
  const project = await store.create('保留手工音色')
  const assets = [character('origin'), { ...character('costume'), voiceAudio: manual }]
  await store.mutateAssets(project.id, () => ({ assets, result: undefined }))
  const request = await existingOutput(project.id, 'origin')
  await assert.rejects(saveGeneratedCharacterVoice(request, 'static/videos/task-2.mp4', store), /声音已更改/)
  const result = (await store.summary(project.id)).assets
  assert.equal(result[0].voiceAudio, undefined)
  assert.deepEqual(result[1].voiceAudio, manual)
  assert.ok(result.every(asset => asset.voiceProfile.generatedOutputId === undefined))
})

test('an in-flight legacy result follows a newly assigned profile while preserving independent recordings', async () => {
  for (const conflict of [false, true]) {
    const project = await store.create('已有生成任务')
    const assets = [character('origin'), { ...character('costume'), ...(conflict && { voiceAudio: manual }) }]
    await store.mutateAssets(project.id, () => ({ assets, result: undefined }))
    const { profileId: _profileId, ...request } = await existingOutput(project.id, 'origin')
    await saveGeneratedCharacterVoice(request, 'static/videos/task-3.mp4', store)
    const [origin, costume] = (await store.summary(project.id)).assets
    assert.equal(origin.voiceAudio.url, '/static/uploads/' + request.outputId + '.mp3')
    assert.deepEqual(costume.voiceAudio, conflict ? manual : origin.voiceAudio)
    assert.equal(origin.voiceProfile.generatedOutputId, conflict ? undefined : request.outputId)
    assert.equal(costume.voiceProfile.generatedOutputId, conflict ? undefined : request.outputId)
  }
})

test('a late result cannot replace a profile recording that was previously generated and then removed', async () => {
  const project = await store.create('已有音色的年龄阶段')
  const stage = { ...profile, generatedOutputId: randomUUID() }
  const assets = [character('origin', stage), character('costume', stage)]
  await store.mutateAssets(project.id, () => ({ assets, result: undefined }))
  const { profileId: _profileId, ...request } = await existingOutput(project.id, 'origin')
  await assert.rejects(saveGeneratedCharacterVoice(request, 'static/videos/task-4.mp4', store), /声音已更改/)
  for (const asset of (await store.summary(project.id)).assets) {
    assert.equal(asset.voiceAudio, undefined)
    assert.equal(asset.voiceProfile.generatedOutputId, stage.generatedOutputId)
  }
})
