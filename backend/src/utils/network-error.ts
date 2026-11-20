export function isPreTlsConnectionReset(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause
  return cause?.code === 'ECONNRESET' && typeof cause.message === 'string' &&
    /\bbefore secure TLS connection was established\b/i.test(cause.message)
}
