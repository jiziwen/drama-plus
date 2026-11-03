import type { OpenAIProvider } from '@ai-sdk/openai'

/** Official OpenAI agents use Responses, including tool results and reasoning items.
 * Compatible third-party endpoints retain Chat Completions support.
 */
export function selectAgentOpenAIModel(provider: OpenAIProvider, model: string, baseURL: string) {
  let official = false
  try { official = new URL(baseURL).hostname === 'api.openai.com' } catch { /* compatible endpoint */ }
  return official ? provider.responses(model) : provider.chat(model)
}

/** Older SDK releases do not recognize GPT-6 reasoning capabilities yet. */
export function adaptOfficialOpenAIFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body)
      if (/^gpt-6(?:[.-]|$)/i.test(body.model || '')) {
        delete body.temperature
        delete body.top_p
        init = { ...init, body: JSON.stringify(body) }
      }
    }
    return base(input, init)
  }
}
