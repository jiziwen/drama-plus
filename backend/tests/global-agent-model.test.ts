import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(os.tmpdir(), 'global-agent-model-'))
process.env.SQLITE_PATH = path.join(root, 'db.sqlite3')
process.env.HUOBAO_DATA_DIR = root
process.env.STORAGE_PATH = path.join(root, 'static')
process.env.WORKSPACE_PATH = path.join(root, 'workspace')
process.env.MYSQL_AUTO_IMPORT = 'false'
await mkdir(path.join(root, 'workspace/prompts'), { recursive: true })
const promptPath = path.join(root, 'workspace/prompts/prompt_generator.md')
await writeFile(promptPath, '---\nname: 提示词\nmodel: ""\n---\n提示词')
const { db, schema } = await import('../src/db/index.js')
const { setGlobalDefaultModel } = await import('../src/services/ai.js')
const { agentRegistry } = await import('../src/agents/index.js')
const { buildAgentRequestContext } = await import('../src/agents/context.js')
after(async () => { db.$client.close(); await rm(root, { recursive: true, force: true }) })
const ts = new Date().toISOString()
const row = db.insert(schema.aiServiceConfigs).values({ serviceType: 'text', provider: 'openai', name: 'fixture',
  baseUrl: 'https://example.invalid', apiKey: 'fixture', model: JSON.stringify(['model-a', 'model-b']),
  isActive: true, createdAt: ts, updatedAt: ts }).returning().get()
setGlobalDefaultModel('text', { configId: row.id, model: 'model-b' })

test('built-in agents honor the exact global model while preserving deliberate prompt-file overrides', async () => {
  const agent = agentRegistry.prompt_generator
  assert.equal((await agent.getModel()).modelId, 'model-b')
  await writeFile(promptPath, '---\nname: 提示词\nmodel: "custom-model"\n---\n提示词')
  assert.equal((await agent.getModel()).modelId, 'custom-model')
  const context = buildAgentRequestContext({ modelOverride: 'model-a', textConfigId: row.id })
  assert.equal((await agent.getModel({ requestContext: context })).modelId, 'model-a')
})

test('an invalid account or mismatched explicit model never falls through to the global provider', async () => {
  const agent = agentRegistry.prompt_generator
  const stale = buildAgentRequestContext({ modelOverride: 'model-a', textConfigId: 999999 })
  await assert.rejects(agent.getModel({ requestContext: stale }), /配置不可用/)
  const mismatched = buildAgentRequestContext({ modelOverride: 'other-model', textConfigId: row.id })
  await assert.rejects(agent.getModel({ requestContext: mismatched }), /不属于该配置/)
})
