import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const route = readFileSync(new URL('../src/routes/episodes.ts', import.meta.url), 'utf8')

test('new episodes leave omitted image and video configurations unpinned', () => {
  assert.match(route, /const imageConfigId = body\.image_config_id \?\? null/)
  assert.match(route, /const videoConfigId = body\.video_config_id \?\? null/)
  assert.match(route, /getActiveConfigId\('image'\)/)
  assert.match(route, /getActiveConfigId\('video'\)/)
})
