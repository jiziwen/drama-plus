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

export function isAicostHost(baseURL: string) {
  const host = URL.parse(baseURL)?.hostname
  return host === 'aicost.me' || host === 'www.aicost.me'
}

export function isHaiku55(model: unknown) {
  return typeof model === 'string' && /^(?:anthropic[./])?claude-haiku-5[.-]5$/i.test(model)
}

export function isAicostHaiku55(baseURL: string, model: string) {
  return isAicostHost(baseURL) && isHaiku55(model)
}

/** Use the model defaults for AICost's Haiku 5.5, even if the SDK supplies a temperature. */
export function adaptAicostTextFetch(base: typeof fetch, baseURL: string): typeof fetch {
  if (!isAicostHost(baseURL)) return base

  return async (input, init) => {
    if (typeof init?.body !== 'string') return base(input, init)
    const body = JSON.parse(init.body)
    if (!isHaiku55(body?.model)) return base(input, init)
    delete body.temperature
    delete body.top_p
    delete body.top_k
    return base(input, { ...init, body: JSON.stringify(body) })
  }
}
