/** Three-way merge of a saved snapshot, local edits and a newer server snapshot.
 * Conflicts retain local data for review; callers must not save them automatically. */
type ObjectValue = Record<string, unknown>
type Context = 'project' | 'episode' | 'card' | 'other'
const missing = Symbol('missing')
type Value = unknown | typeof missing
const object = (value: Value): value is ObjectValue =>
  value !== missing &&
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value)
const own = (value: ObjectValue, key: string): Value =>
  Object.prototype.hasOwnProperty.call(value, key) ? value[key] : missing
function equal(a: Value, b: Value): boolean {
  if (a === b) return true
  if (a === missing || b === missing) return false
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (object(a) && object(b)) {
    const keys = Object.keys(a),
      other = Object.keys(b)
    return (
      keys.length === other.length &&
      keys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(b, key) && equal(a[key], b[key]),
      )
    )
  }
  return false
}
function clone(value: Value): Value {
  if (
    value === missing ||
    value === undefined ||
    value === null ||
    typeof value !== 'object'
  )
    return value
  try {
    return structuredClone(value)
  } catch (error) {
    // Vue reactive proxies are not structured-cloneable. Project snapshots are
    // JSON data; preserve primitives/undefined above, and do not mask other errors.
    if (
      !error ||
      typeof error !== 'object' ||
      !('name' in error) ||
      error.name !== 'DataCloneError'
    )
      throw error
    return JSON.parse(JSON.stringify(value))
  }
}
function serverField(context: Context, key: string) {
  return (
    (context === 'project' && key === 'revision') ||
    (context === 'episode' && key === 'tasks') ||
    (context === 'card' && ['version', 'status', 'videoUrl', 'videoVersions'].includes(key))
  )
}
function localField(context: Context, key: string) {
  return (
    (context === 'project' && key === 'episodeId') ||
    (context === 'episode' && ['busy', 'selectedCardId'].includes(key))
  )
}
function childContext(context: Context, key: string): Context {
  return context === 'project' && key === 'episodes'
    ? 'episode'
    : context === 'episode' && key === 'cards'
      ? 'card'
      : 'other'
}
function comparable(value: Value, context: Context): Value {
  if (Array.isArray(value))
    return value.map((item) => comparable(item, context))
  if (!object(value)) return value
  const out: ObjectValue = {}
  for (const key of Object.keys(value)) {
    if (serverField(context, key) || localField(context, key)) continue
    const next = childContext(context, key)
    out[key] = comparable(value[key], next)
  }
  return out
}
function idArray(value: Value): value is ObjectValue[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<string>()
  for (const item of value) {
    if (
      !object(item) ||
      typeof item.id !== 'string' ||
      !item.id ||
      ids.has(item.id)
    )
      return false
    ids.add(item.id)
  }
  return true
}
function join(path: string, part: string) {
  return path ? `${path}.${part}` : part
}

export function mergeScriptVideoProject<T>(
  base: T,
  local: T,
  remote: T,
): { project: T; conflicts: string[] } {
  const conflicts: string[] = []
  function merge(
    baseValue: Value,
    localValue: Value,
    remoteValue: Value,
    path: string,
    context: Context,
    key?: string,
  ): Value {
    if (key && serverField(context, key)) return clone(remoteValue)
    if (key && localField(context, key))
      return clone(localValue === missing ? remoteValue : localValue)
    if (context === 'card' && key === 'referenceFrameSettings') {
      const settings = [baseValue, localValue, remoteValue].map(value => object(value) ? value : {})
      const maps = settings.map(value => object(value.lighting) ? value.lighting : {})
      const result: ObjectValue = {}, lighting: ObjectValue = {}
      // Never combine the mode, timestamp and video from different edits.
      function choice(values: ObjectValue[], name: string, choicePath: string) {
        const [base, local, remote] = values.map(value => own(value, name))
        if (equal(local, base)) return clone(remote)
        if (!equal(local, remote) && !equal(base, remote)) conflicts.push(choicePath)
        return clone(local)
      }
      const tail = choice(settings, 'tail', join(path, 'tail'))
      if (tail !== missing) result.tail = tail
      for (const shot of new Set(maps.flatMap(value => Object.keys(value)))) {
        const frame = choice(maps, shot, join(path, `lighting.${shot}`))
        if (frame !== missing) lighting[shot] = frame
      }
      if (Object.keys(lighting).length) result.lighting = lighting
      return Object.keys(result).length ? result : missing
    }
    if (localValue === missing || remoteValue === missing) {
      if (localValue === missing && remoteValue === missing) return missing
      if (baseValue === missing)
        return clone(localValue === missing ? remoteValue : localValue)
      if (localValue === missing) {
        if (
          !equal(
            comparable(baseValue, context),
            comparable(remoteValue, context),
          )
        )
          conflicts.push(path)
        return missing
      }
      if (
        !equal(comparable(baseValue, context), comparable(localValue, context))
      ) {
        conflicts.push(path)
        return clone(localValue)
      }
      return missing
    }
    if (object(baseValue) && object(localValue) && object(remoteValue)) {
      const result: ObjectValue = {}
      const keys = new Set([
        ...Object.keys(baseValue),
        ...Object.keys(localValue),
        ...Object.keys(remoteValue),
      ])
      for (const childKey of keys) {
        const merged = merge(
          own(baseValue, childKey),
          own(localValue, childKey),
          own(remoteValue, childKey),
          join(path, childKey),
          context,
          childKey,
        )
        if (merged !== missing) result[childKey] = merged
      }
      if (context === 'episode' && idArray(result.cards) && result.cards.length &&
          !result.cards.some(card => card.id === result.selectedCardId)) {
        result.selectedCardId = result.cards.find(card => card.id === remoteValue.selectedCardId)?.id ?? result.cards[0]!.id
      }
      return result
    }
    if (idArray(baseValue) && idArray(localValue) && idArray(remoteValue)) {
      const itemContext = childContext(context, key || '')
      const b = new Map(baseValue.map((item) => [item.id as string, item]))
      const l = new Map(localValue.map((item) => [item.id as string, item]))
      const r = new Map(remoteValue.map((item) => [item.id as string, item]))
      const ids = new Set([...b.keys(), ...l.keys(), ...r.keys()])
      const merged = new Map<string, Value>()
      for (const id of ids) {
        const item = merge(
          b.get(id) ?? missing,
          l.get(id) ?? missing,
          r.get(id) ?? missing,
          join(path, id),
          itemContext,
        )
        if (item !== missing) merged.set(id, item)
      }
      // Compare only IDs present in all three versions so additions and removals
      // do not look like reorder conflicts.
      const shared = new Set(
        [...b.keys()].filter((id) => l.has(id) && r.has(id)),
      )
      const commonOrder = (items: ObjectValue[]) =>
        items.map((item) => item.id as string).filter((id) => shared.has(id))
      const baseOrder = commonOrder(baseValue),
        localOrder = commonOrder(localValue),
        remoteOrder = commonOrder(remoteValue)
      const localReordered = !equal(baseOrder, localOrder),
        remoteReordered = !equal(baseOrder, remoteOrder)
      if (localReordered && remoteReordered && !equal(localOrder, remoteOrder))
        conflicts.push(join(path, 'order'))
      const preferred = localReordered ? localValue : remoteValue
      const order = [
        ...preferred,
        ...(localReordered ? remoteValue : localValue),
      ].map((item) => item.id as string)
      return [...new Set(order)]
        .filter((id) => merged.has(id))
        .map((id) => merged.get(id))
    }
    if (equal(localValue, remoteValue)) return clone(localValue)
    if (equal(localValue, baseValue)) return clone(remoteValue)
    if (equal(remoteValue, baseValue)) return clone(localValue)
    conflicts.push(path || 'project')
    return clone(localValue)
  }
  return { project: merge(base, local, remote, '', 'project') as T, conflicts }
}
