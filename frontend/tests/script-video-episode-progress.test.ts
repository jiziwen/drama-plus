import assert from 'node:assert/strict'
import test from 'node:test'
import { scriptVideoEpisodeProgress } from '../app/utils/scriptVideoPreview'

const draft = { shots: [], prompt: '', status: 'draft' as const }
const storyboard = {
  ...draft,
  shots: [{ id: 'shot-1', duration: 5, camera: '近景', action: '转身', dialogue: '' }],
  prompt: '近景，角色转身。',
}

test('counts saved milestones when the episode is open on an earlier step', () => {
  const episode = { confirmed: true, outlineConfirmed: false, stage: 'materials', cards: [draft] }
  assert.equal(scriptVideoEpisodeProgress({ ...episode, cards: [] }), undefined)
  assert.equal(scriptVideoEpisodeProgress({ ...episode, confirmed: false }), undefined)
  assert.equal(scriptVideoEpisodeProgress(episode), '制作中-大纲')
  assert.equal(scriptVideoEpisodeProgress({ ...episode, outlineConfirmed: true }), '制作中-大纲')
  assert.equal(scriptVideoEpisodeProgress({ ...episode, outlineConfirmed: true, cards: [storyboard] }), '制作中-视频制作')
})

test('marks completion only when every current segment has a ready video', () => {
  const ready = { ...storyboard, status: 'ready' as const, videoUrl: '/video.mp4' }
  const episode = { confirmed: true, outlineConfirmed: true, cards: [ready, ready] }
  assert.equal(scriptVideoEpisodeProgress(episode), '已完成')
  assert.equal(scriptVideoEpisodeProgress({ ...episode, cards: [ready, { ...ready, status: 'draft' }] }), '制作中-视频制作')
  assert.equal(scriptVideoEpisodeProgress({ ...episode, cards: [{ ...ready, videoUrl: undefined }] }), '制作中-视频制作')
})

test('a new blank manual segment does not move a legacy storyboard out of video production', () => {
  const episode = { confirmed: true, outlineConfirmed: true, cards: [storyboard, { ...draft, manuallyAdded: true as const }] }
  assert.equal(scriptVideoEpisodeProgress(episode), '制作中-视频制作')
  assert.equal(scriptVideoEpisodeProgress({ ...episode, cards: [storyboard, draft] }), '制作中-大纲')
})
