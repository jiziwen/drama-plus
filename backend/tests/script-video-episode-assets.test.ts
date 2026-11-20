import assert from 'node:assert/strict'
import test from 'node:test'
import { selectScriptVideoEpisodeAssets } from '../src/services/script-video-episode-assets.js'

test('episode assets include the approved bindings, the named crowd and source costume changes', () => {
  const crowd = (owner: string) => ({
    id: owner,
    name: '素材/角色/' + owner + '/群体',
    originalName: '群体',
    sourcePath: '素材/角色/' + owner + '/群体.png',
    kind: 'character',
  })
  const assets = [
    { id: 'coat', name: '小禾_外套', kind: 'character' },
    { id: 'shirt', name: '小禾_白衬衫', kind: 'character' },
    { id: 'gown', name: '小禾_礼服', kind: 'character' },
    crowd('城门守卫'),
    crowd('剧院观众'),
    { id: 'river', name: '北城-临河广场', kind: 'scene' },
    { id: 'ring', name: '银戒指', kind: 'prop' },
    { id: 'train', name: '火车站', kind: 'scene' },
  ]
  const selected = selectScriptVideoEpisodeAssets(
    {
      script: '城门守卫/群体走过临河广场。小禾随后换上小禾_白衬衫。',
      assets,
    },
    [{ title: '广场', summary: '继承前场造型', assetIds: ['coat', 'ring'] }],
  )
  assert.deepEqual(
    selected.map((a) => a.id),
    ['coat', 'shirt', '城门守卫', 'river', 'ring'],
  )
  assert.deepEqual(selectScriptVideoEpisodeAssets({ script: '群体入场', assets }), [])
})
