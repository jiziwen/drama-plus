import fs from 'node:fs/promises'
import path from 'node:path'
import { buildWorkFisher, workFisherModes, workFisherSourceHash } from '../src/services/work-fisher.js'

// Export both formats for inspection or the native, generation-free validator.
const folder = path.resolve(process.argv[2] || '../tmp/work-fisher-audit')
await fs.mkdir(folder, { recursive: true })
const manifest = []
for (const [model, mode] of Object.entries(workFisherModes)) {
  const built = buildWorkFisher({ model, baseUrl: '', apiKey: '' }, mode.type, { prompt: '节点核验' }, model === 'wf-qwen-image' ? ['example.png'] : [], 42)
  await fs.writeFile(path.join(folder, `${model}.json`), JSON.stringify(built.workflow, null, 2))
  await fs.writeFile(path.join(folder, `${model}.canvas.json`), JSON.stringify(built.canvasWorkflow, null, 2))
  manifest.push({ model, group: mode.group, sourceHash: workFisherSourceHash, nodes: Object.keys(built.workflow), output: built.outputNode, width: built.width, height: built.height })
}
await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(JSON.stringify(manifest, null, 2))
