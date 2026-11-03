import { test } from 'node:test'
import assert from 'node:assert/strict'
import { videoPosterSrc } from '../app/composables/useMedia.ts'

test('changing a shot main video invalidates its poster URL while old task posters stay independent', () => {
  const first = videoPosterSrc('storyboards', 12, 'static/videos/task-52.mp4')
  const second = videoPosterSrc('storyboards', 12, 'static/videos/task-60.mp4')
  assert.notEqual(first, second)
  assert.equal(first, videoPosterSrc('storyboards', 12, 'static/videos/task-52.mp4'))
  assert.match(videoPosterSrc('tasks', 52, 'static/videos/task-52.mp4'), /^\/api\/v1\/tasks\/52\/poster\?v=/)
})

test('poster lookup never includes a remote source or its signature', () => {
  const url = videoPosterSrc('tasks', 60, 'https://video.example/clip.mp4?token=private-signature')
  assert.match(url, /^\/api\/v1\/tasks\/60\/poster\?v=[a-z0-9]+$/)
  assert.equal(url.includes('private-signature'), false)
})

test('empty or unidentified media does not produce a broken task endpoint', () => {
  assert.equal(videoPosterSrc('storyboards', 12, ''), '')
  assert.equal(videoPosterSrc('tasks', 0, '/static/videos/upload.mp4'), '/static/videos/upload_poster.jpg')
  assert.equal(videoPosterSrc('tasks', 'invalid', 'https://video.example/clip.mp4'), '')
})
