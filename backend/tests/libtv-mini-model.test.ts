import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIBTV_SEEDANCE_20_MINI_MODEL, libtvVideoModel } from '../src/services/libtv-video-models.js'
import { scriptVideoCapabilities } from '../src/services/script-video-capabilities.js'
import { scriptVideoDeliveryTags } from '../src/services/script-video-delivery.js'

test('LibTV Mini uses 2.0 limits and LibTV reference tags without changing 2.5', () => {
  const spec = libtvVideoModel(LIBTV_SEEDANCE_20_MINI_MODEL)!
  assert.equal(spec.name, 'Seedance 2.0 Mini')
  assert.deepEqual(spec.resolutions, ['480p', '720p'])
  assert.equal(scriptVideoCapabilities('libtv', spec.id)?.maxDuration, 15)
  const mini = scriptVideoDeliveryTags({ provider: 'libtv', model: spec.id })
  assert.equal(mini.seedance25, false)
  assert.equal(mini.audioTag(1), '@音频1')
  assert.equal(scriptVideoDeliveryTags({ provider: 'libtv', model: 'star-video2.5' }).seedance25, true)
})
