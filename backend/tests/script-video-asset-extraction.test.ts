import assert from 'node:assert/strict'
import test from 'node:test'
import { extractScriptVideoAssets } from '../src/services/script-video-asset-extraction.js'

const asset = (
  kind: 'character' | 'scene' | 'prop' | 'creature',
  name: string,
  fields: { identity?: string; aliases?: string[]; reuseId?: string; prompt?: string } = {},
) => ({
  kind, name, assetIdentity: fields.identity || name, aliases: fields.aliases || [],
  imagePrompt: fields.prompt || `为${name}制作完整的中文参考图，统一项目画风。`,
  reuseId: fields.reuseId,
})

test('资产分段提取记住前段，用别名和项目已存在资产去重，保留明确的不同造型', async () => {
  const existing = { id: 'store', name: '老街铺子', kind: 'scene', aliases: ['小店'] }
  const progress: number[][] = []
  let calls = 0
  const extracted = await extractScriptVideoAssets({
    sources: [
      { title: '首集', episodeNumber: 1, script: '第1场 日 内 小店\n陆宁提着木盒进门检修。\n'.repeat(20) },
      { title: '次集', episodeNumber: 2, script: '深夜，小陆带着同一只木盒回到小店，换上夜行衣。附近的黑猫跟了进来。' },
    ],
    existingAssets: [existing],
    onProgress: (done, total) => progress.push([done, total]),
  }, async ({ instructions, message }) => {
    assert.match(instructions, /原始分镜条例/u)
    assert.match(instructions, /空场景参考母版/u)
    const { episode, known } = JSON.parse(message)
    calls++
    if (calls === 1) return '{"assets":[{"kind":"character","name":"陆'
    if (episode === 1) return JSON.stringify({
      assets: [
        asset('character', '陆宁', { aliases: ['小陆'] }),
        asset('scene', '小店'),
        asset('prop', '木盒'),
      ],
    })
    const normal = known.find((item: { name: string }) => item.name === '陆宁')
    assert.ok(normal.aliases.includes('小陆'))
    assert.ok(known.some((item: { id: string }) => item.id === 'existing-store'))
    return JSON.stringify({
      assets: [
        asset('character', '小陆', { reuseId: normal.id, prompt: '陆宁，平常穿深蓝检修工作服。' }),
        asset('character', '陆宁（夜行衣）', { identity: '陆宁｜夜行衣', aliases: ['小陆'] }),
        asset('scene', '老街铺子', { reuseId: 'existing-store' }),
        asset('prop', '木盒'),
        asset('creature', '黑猫'),
      ],
    })
  })
  assert.equal(calls, 4)
  assert.deepEqual(progress, [[0, 2], [0, 3], [1, 3], [2, 3], [3, 3]])
  assert.equal(extracted.length, 5)
  const regular = extracted.find(item => item.name === '陆宁')
  assert.deepEqual(regular?.sourceEpisodes, [1, 2])
  assert.deepEqual(regular?.sourceTitles, ['首集', '次集'])
  assert.equal(regular?.imagePrompt, '陆宁，平常穿深蓝检修工作服。')
  assert.deepEqual(extracted.find(item => item.name === '陆宁（夜行衣）')?.sourceEpisodes, [2])
  assert.equal(extracted.find(item => item.kind === 'scene')?.existingAssetId, 'store')
  assert.deepEqual(extracted.find(item => item.name === '木盒')?.sourceEpisodes, [1, 2])
})

test('长文件按输入长度切分，输入空间不足时继续缩小单批范围', async () => {
  const script = '在老街的小店里，陆宁反复检查柜台上的木盒。\n'.repeat(390)
  let limited = 0
  let processed = 0
  const result = await extractScriptVideoAssets({
    sources: [{ title: '长剧本', script }], existingAssets: [],
  }, async ({ message }) => {
    const { script: part, known } = JSON.parse(message)
    assert.ok(part.length <= 4800)
    if (part.length > 2600) {
      limited++
      throw Object.assign(new Error('上下文超过模型上限'), { code: 'context_length_exceeded' })
    }
    processed++
    if (processed > 1) assert.ok(known.some((item: { name: string }) => item.name === '陆宁'))
    return JSON.stringify({ assets: [asset('character', '陆宁')] })
  })
  assert.ok(limited >= 1)
  assert.ok(processed >= 4)
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].sourceTitles, ['长剧本'])
})
