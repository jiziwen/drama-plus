/** Decode common manuscript encodings without silently replacing characters. */
export function decodeTextFile(bytes: Uint8Array): string {
  const decode = (encoding: string) => new TextDecoder(encoding, { fatal: true }).decode(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decode('utf-16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decode('utf-16be')
  try { return decode('utf-8') }
  catch { return decode('gb18030') }
}
