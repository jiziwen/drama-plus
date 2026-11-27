import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { collectScriptVideoVoiceEvidence, extractScriptVideoVoiceDescription } from '../src/services/script-video-voice-description.js'
import type { ScriptVideoProject } from '../src/services/script-video-store.js'

const hero = { id: 'hero', name: '阿宁_常服', kind: 'character', assetIdentity: '阿宁｜常服', aliases: ['小宁'], sourceEpisodes: [2] }
const project: ScriptVideoProject = { id: 'project', title: '测试', revision: 0, episodeId: 'ep1',
  assets: [hero, { id: 'other', name: '阿宁公主', kind: 'character', assetIdentity: '阿宁公主', aliases: ['公主'] }],
  episodes: [
    { id: 'ep1', number: 1, script: '阿宁公主：这句话来自别人。\n小宁（哭）：我想回家。\n阿宁公主：不要泄露。',
      production: { characters: [{ name: '阿宁公主', voice: '刺耳高亢' }] } },
    { id: 'ep2', number: 2, script: '阿宁：快来帮我。', production: { characters: [
      { name: '阿宁', appearance: '长发绿衣', voice: '音色清亮，声线轻柔，语速平稳。' },
    ] } },
    { id: 'ep3', number: 3, script: '无关角色：秘密台词。' },
  ] }

test('extracts only matching role evidence, prioritizes current and source episodes, and labels the cited source', async () => {
  let payload: any
  const fallback = structuredClone(project)
  fallback.episodes[1].production.characters[0].voice = '已绑定音色'
  const result = await extractScriptVideoVoiceDescription(fallback, hero, 'ep1', async ({ instructions, message }) => {
    assert.match(instructions, /不要从年龄、性别、身份、外观/)
    assert.match(instructions, /不要把某次情绪/)
    payload = JSON.parse(message)
    return '```json\n{"text":"音色清亮，声线轻柔，语速平稳。","source":2}\n```'
  })
  assert.deepEqual(result, { text: '音色清亮，声线轻柔，语速平稳。', sourceLabel: '第 2 集' })
  assert.deepEqual(payload.evidence.map((item: any) => item.label), ['第 1 集', '第 2 集'])
  assert.match(payload.evidence[0].scriptExcerpt, /小宁（哭）/)
  assert.doesNotMatch(JSON.stringify(payload), /来自别人|刺耳高亢|长发绿衣|秘密台词/)
  assert.deepEqual(payload.evidence[1].productionVoices, ['已绑定音色'])
})

test('uses the confirmed script first, and explicit script voice facts before production without an AI call', async () => {
  const data = structuredClone(project)
  data.episodes[0].confirmedScript = '人物：小宁\n声音：嗓音沙哑，说话慢\n阿宁公主：她在哭。'
  data.episodes[0].script = '小宁：另一个草稿。'
  const result = await extractScriptVideoVoiceDescription(data, hero, 'ep1', async () => { throw new Error('no model call expected') })
  assert.deepEqual(result, { text: '嗓音沙哑，说话慢', sourceLabel: '第 1 集' })
  const evidence = collectScriptVideoVoiceEvidence(data, hero, 'ep1')
  assert.doesNotMatch(evidence[0].scriptExcerpt, /另一个草稿/)
})

test('uses a clear production voice without model calls while ignoring placeholder or emotional descriptions', async () => {
  const result = await extractScriptVideoVoiceDescription(project, hero, 'ep1', async () => { throw new Error('no model call expected') })
  assert.deepEqual(result, { text: '音色清亮，声线轻柔，语速平稳。', sourceLabel: '第 2 集' })
  for (const invalid of ['已绑定音色', '无台词', '说话时哭喊，声音激动', '声音清亮，身材高大']) {
    const fallback = structuredClone(project)
    fallback.episodes[1].production.characters[0].voice = invalid
    assert.deepEqual(await extractScriptVideoVoiceDescription(fallback, hero, 'ep1', async () => '{"text":""}'), { text: '' })
  }
})

test('reads the selected voice from the existing multi-character Markdown script format', async () => {
  const episode = JSON.parse(readFileSync(new URL('./fixtures/script-video-episode16.json', import.meta.url), 'utf8'))
  const eunuch = { id: 'wei', name: '魏忠国', kind: 'character' }
  const data = { ...project, assets: [eunuch], episodes: [{ id: 'ep16', number: 16, script: episode.script }] }
  assert.deepEqual(await extractScriptVideoVoiceDescription(data, eunuch, 'ep16', async () => { throw new Error('no model call expected') }),
    { text: '阴柔沙哑苍老太监音', sourceLabel: '第 16 集' })
})

test('returns empty without a model request when the character has no related evidence', async () => {
  let called = false
  const unknown = { id: 'absent', name: '无名角色', kind: 'character' }
  const result = await extractScriptVideoVoiceDescription(project, unknown, undefined, async () => { called = true; return '' })
  assert.deepEqual(result, { text: '' })
  assert.equal(called, false)
})

test('does not attribute a shared alias to either character', () => {
  const shared = { ...project, assets: [
    { id: 'a', name: '阿甲', kind: 'character', aliases: ['小宁'] },
    { id: 'b', name: '阿乙', kind: 'character', aliases: ['小宁'] },
  ], episodes: [{ id: 'ep1', number: 1, script: '小宁：你好。' }] }
  assert.deepEqual(collectScriptVideoVoiceEvidence(shared, shared.assets[0]), [])
})

test('does not attribute a sound heading following a spoken line to that character', () => {
  const data = structuredClone(project)
  data.episodes = [{ id: 'ep1', number: 1, script: '小宁：快跑！\n声音：警报声音低沉。' }]
  const evidence = collectScriptVideoVoiceEvidence(data, hero, 'ep1')
  assert.equal(evidence[0].scriptExcerpt, '小宁：快跑！')
  assert.deepEqual(evidence[0].scriptVoiceFacts, [])
})

test('preserves explicit insufficient-evidence output and rejects missing or invalid source references', async () => {
  const fallback = structuredClone(project)
  fallback.episodes[1].production.characters[0].voice = '无台词'
  assert.deepEqual(await extractScriptVideoVoiceDescription(fallback, hero, 'ep1', async () => '{"text":""}'), { text: '' })
  await assert.rejects(extractScriptVideoVoiceDescription(fallback, hero, 'ep1', async () => '{"text":"低沉","source":99}'), /来源/)
  await assert.rejects(extractScriptVideoVoiceDescription(fallback, hero, 'ep1', async () => 'not-json'), /格式无效/)
})
