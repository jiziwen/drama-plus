import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import { getConfigById, getTextProviderBaseUrl } from '../src/services/ai.js'
import { adaptOfficialOpenAIFetch, selectAgentOpenAIModel } from '../src/agents/openai-model.js'
const config = await getConfigById(6)
if (!config) throw new Error('Official OpenAI config missing')
let called = false
const requests: { path: string; status: number; temperature: boolean }[] = []
const fetcher = adaptOfficialOpenAIFetch(async (input, init) => {
  const response = await fetch(input, { ...init, signal: AbortSignal.timeout(90000) })
  requests.push({ path: new URL(String(input)).pathname, status: response.status, temperature: 'temperature' in JSON.parse(String(init?.body || '{}')) })
  return response
})
const provider = createOpenAI({ apiKey: config.apiKey, baseURL: getTextProviderBaseUrl(config), fetch: fetcher })
const agent = new Agent({ id: 'openai-readonly-smoke', name: 'Smoke', instructions: 'Call verify_connection exactly once with value ping, then reply with the returned value. This is a connection test.', model: selectAgentOpenAIModel(provider, config.model, getTextProviderBaseUrl(config)), tools: {
  verify_connection: createTool({ id: 'verify_connection', description: 'Read-only connection test; returns pong.', inputSchema: z.object({ value: z.string() }), execute: async () => { called = true; return { value: 'pong' } } }),
} })
try {
  const result = await agent.generate('Please run the connection test now.', { maxSteps: 3 })
  console.log(JSON.stringify({ called, hasReply: !!result.text, requests }))
  if (!called || !result.text) process.exitCode = 1
} catch (error: any) { console.log(JSON.stringify({ error: error.message, requests })); process.exitCode = 1 }
