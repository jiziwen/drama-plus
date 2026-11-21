export function usesJimengVideo(provider?: string | null, model?: string | null): boolean {
  return provider?.toLowerCase() === 'jimeng' || Boolean(model?.startsWith('jimeng-seedance-'))
}
