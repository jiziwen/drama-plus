import type { TextModelLimits } from './script-video-output-limit.js'
import { isTextModelInputLimit } from './text-model-input-limit.js'

type ReferenceSlice = { number: number; text: string; first: boolean; last: boolean; progress: number }
type ReferenceDigest = { first: number; last: number; notes: string }

function tokenUnits(character: number) {
  if (character <= 0x7f) {
    if (character === 0x0a || character === 0x0d || character === 0x22 || character === 0x5c) return 10
    return 4
  }
  return character >= 0x3000 && character <= 0x9fff ? 13 : 19
}

// Model families tokenize differently. The provider's response is authoritative when this estimate is low.
function estimateTokens(value: string) {
  let units = 0
  for (let i = 0; i < value.length; i++) units += tokenUnits(value.charCodeAt(i))
  return Math.ceil(units / 10)
}

const smallestBatch = 1_200
const unknownInputLimit = 96_000

export function dramaReferenceBudgets(limits: TextModelLimits = {}, direction = '') {
  // This is an estimate reserved for output when splitting input, not a generation limit.
  const outputReserve = Math.min(8_000, limits.maxOutputTokens ?? Infinity,
    Math.floor((limits.contextWindow ?? Infinity) / 4))
  const reportedInput = Math.min(limits.maxInputTokens ?? Infinity,
    (limits.contextWindow ?? Infinity) - outputReserve)
  const input = Number.isFinite(reportedInput) ? reportedInput : unknownInputLimit
  const overhead = Math.min(4_000, Math.floor(input * .12)) + estimateTokens(direction)
  return { source: Math.max(smallestBatch, Math.floor(input * .93) - overhead) }
}

function sliceEnd(source: string, start: number, budget: number) {
  let units = 0
  let end = start
  while (end < source.length && units < budget * 10) units += tokenUnits(source.charCodeAt(end++))
  if (end === source.length) return end
  if (/[\uD800-\uDBFF]/u.test(source[end - 1]!)) end--
  const earliest = start + Math.floor((end - start) * .6)
  const tail = source.slice(earliest, end)
  for (const pattern of [/\n[ \t]*\n/gu, /\n/gu, /[。！？；.!?](?=\s|[^\x00-\x7f]|$)/gu]) {
    let boundary = 0
    for (const match of tail.matchAll(pattern)) boundary = match.index! + match[0].length
    if (boundary) return earliest + boundary
  }
  return end
}

type ReferenceAnalysis<T> = {
  whole: (source: string) => Promise<T>
  slice: (slice: ReferenceSlice) => Promise<string>
  merge: (digests: ReferenceDigest[]) => Promise<string>
  finish: (digests: ReferenceDigest[]) => Promise<T>
}

export async function analyzeDramaReference<T>(
  source: string,
  sourceBudget: number,
  signal: AbortSignal,
  steps: ReferenceAnalysis<T>,
): Promise<T> {
  let budget = sourceBudget
  const sourceTokens = estimateTokens(source)
  const shrink = (attempt: number) => Math.max(smallestBatch, Math.floor(Math.min(attempt, budget) / 2))
  signal.throwIfAborted()
  if (sourceTokens <= budget) {
    try { return await steps.whole(source) }
    catch (error) {
      signal.throwIfAborted()
      if (!isTextModelInputLimit(error) || sourceTokens <= smallestBatch) throw error
      budget = shrink(sourceTokens)
    }
  }

  let digests: ReferenceDigest[] = []
  for (let offset = 0; offset < source.length;) {
    signal.throwIfAborted()
    const end = sliceEnd(source, offset, budget)
    const text = source.slice(offset, end)
    const number = digests.length + 1
    try {
      const notes = await steps.slice({
        number, text, first: offset === 0, last: end === source.length,
        progress: Math.floor(offset * 100 / source.length),
      })
      digests.push({ first: number, last: number, notes })
      offset = end
    } catch (error) {
      signal.throwIfAborted()
      const next = shrink(estimateTokens(text))
      if (!isTextModelInputLimit(error) || next >= budget) throw error
      budget = next
    }
  }

  async function merge(group: ReferenceDigest[]): Promise<ReferenceDigest> {
    signal.throwIfAborted()
    if (group.length === 1) return group[0]!
    try {
      return { first: group[0]!.first, last: group.at(-1)!.last, notes: await steps.merge(group) }
    } catch (error) {
      signal.throwIfAborted()
      if (!isTextModelInputLimit(error) || group.length <= 2) throw error
      const middle = Math.ceil(group.length / 2)
      const left = await merge(group.slice(0, middle))
      const right = await merge(group.slice(middle))
      return merge([left, right])
    }
  }

  const digestSize = (digest: ReferenceDigest) => 20 + estimateTokens(digest.notes)
  for (;;) {
    signal.throwIfAborted()
    const size = digests.reduce((total, digest) => total + digestSize(digest), 0)
    if (size <= budget || digests.length <= 1) {
      try { return await steps.finish(digests) }
      catch (error) {
        signal.throwIfAborted()
        if (!isTextModelInputLimit(error) || digests.length < 2) throw error
        budget = shrink(size)
      }
    }
    const next: ReferenceDigest[] = []
    let group: ReferenceDigest[] = []
    let groupSize = 0
    for (const digest of digests) {
      const size = digestSize(digest)
      if (group.length >= 8 || (group.length >= 2 && groupSize + size > budget)) {
        next.push(await merge(group))
        group = []
        groupSize = 0
      }
      group.push(digest)
      groupSize += size
    }
    if (group.length) next.push(await merge(group))
    digests = next
  }
}
