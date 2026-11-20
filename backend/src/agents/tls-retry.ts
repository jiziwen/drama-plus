import { isPreTlsConnectionReset } from '../utils/network-error.js'

/** Retry only a connection reset explicitly reported before TLS was established.
 * The provider has not received an HTTP request in this case. Do not replay
 * requests after an ambiguous disconnect or after any HTTP response. */
export function retryBeforeTlsHandshake(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await base(input, init)
      } catch (error) {
        if (attempt >= 2 || !isPreTlsConnectionReset(error) || init?.signal?.aborted) throw error
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
}
