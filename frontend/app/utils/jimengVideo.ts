export interface JimengVideoQuote {
  quote_id: string
  credits: number
  model: string
  expires_at: string
}

export function usesJimengVideo(provider?: string | null, model?: string | null): boolean {
  return provider?.toLowerCase() === 'jimeng' || Boolean(model?.startsWith('jimeng-seedance-'))
}
