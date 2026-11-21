/** Browser-safe changes for the script/video editor. IDs address entities so a
 * stale page can never replace another episode, task, or generated video. */
export type ScriptVideoChange = {
  target: 'project' | 'asset' | 'episode' | 'card' | 'shot'
  id?: string
  episodeId?: string
  cardId?: string
  fields?: Record<string, unknown>
  unset?: string[]
  value?: Record<string, unknown>
  remove?: boolean
  order?: string[]
}

type Document = Record<string, any>
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const object = (value: unknown): value is Document => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value))
const same = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => same(item, b[i]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => own(b, key) && same(a[key], b[key]))
}
const idPattern = /^[A-Za-z0-9_-]{1,100}$/
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const ignored: Record<ScriptVideoChange['target'], Set<string>> = {
  project: new Set(['id', 'revision', 'episodeId', 'assets', 'episodes', 'loaded', 'summary', 'episodeRevision']),
  asset: new Set(['id']),
  episode: new Set(['id', 'revision', 'episodeRevision', 'cards', 'tasks', 'busy', 'selectedCardId', 'generationsHistory', 'loaded', 'summary', 'cardCount', 'readyCardCount', 'progress']),
  card: new Set(['id', 'version', 'status', 'videoUrl', 'videoVersions', 'shots']),
  shot: new Set(['id']),
}
function editable(target: ScriptVideoChange['target'], key: string) {
  return !key.startsWith('_') && !ignored[target].has(key) && !forbidden.has(key) &&
    (target !== 'project' || key === 'title' || key === 'settings')
}
function safePath(target: ScriptVideoChange['target'], key: string) {
  const parts = key.split('.')
  if (!parts.length || parts.some(part => !part || forbidden.has(part) || part.startsWith('_')) || !editable(target, parts[0]!))
    throw new Error('不可修改的保存字段')
  return parts
}
function clean(target: ScriptVideoChange['target'], value: Document) {
  const result: Document = { id: value.id }
  for (const [key, item] of Object.entries(value)) if (editable(target, key)) result[key] = clone(item)
  return result
}

export function validateScriptVideoChanges(input: unknown): asserts input is ScriptVideoChange[] {
  if (!Array.isArray(input) || input.length > 10_000) throw new Error('保存改动格式无效')
  for (const change of input) {
    if (!object(change) || !['project', 'asset', 'episode', 'card', 'shot'].includes(change.target)) throw new Error('保存目标无效')
    const target = change.target as ScriptVideoChange['target']
    if (change.id !== undefined && (typeof change.id !== 'string' || !idPattern.test(change.id))) throw new Error('保存标识无效')
    if ((target === 'card' || target === 'shot') && (typeof change.episodeId !== 'string' || !idPattern.test(change.episodeId))) throw new Error('分集标识无效')
    if (target === 'shot' && (typeof change.cardId !== 'string' || !idPattern.test(change.cardId))) throw new Error('分镜标识无效')
    if (change.fields !== undefined) {
      if (!object(change.fields)) throw new Error('保存字段无效')
      Object.keys(change.fields).forEach(key => safePath(target, key))
    }
    if (change.unset !== undefined) {
      if (!Array.isArray(change.unset) || !change.unset.every((key: unknown) => typeof key === 'string')) throw new Error('移除字段无效')
      change.unset.forEach((key: string) => safePath(target, key))
    }
    if (change.value !== undefined && (!object(change.value) || change.value.id !== change.id)) throw new Error('新增内容标识无效')
    if (change.order !== undefined && (!Array.isArray(change.order) || !change.order.every((id: unknown) => typeof id === 'string' && idPattern.test(id)) || new Set(change.order).size !== change.order.length)) throw new Error('排列顺序无效')
    if (target === 'project' && (change.id || change.value || change.remove || change.order)) throw new Error('项目保存范围无效')
    if (target !== 'project' && !change.id && !change.order) throw new Error('保存标识必填')
    if (change.remove && (change.value || change.fields || change.unset || change.order)) throw new Error('删除改动无效')
    if (change.order && (change.id || change.value || change.remove || change.fields || change.unset)) throw new Error('排列改动无效')
  }
}

/** Applies the actual fields that changed, with the latest accepted write winning.
 * Task records and render metadata are always owned by the server. */
export function applyScriptVideoChanges<T extends Document>(project: T, changes: ScriptVideoChange[]): T {
  validateScriptVideoChanges(changes)
  const result = clone(project)
  const retime = new Set<Document>()
  for (const change of changes) {
    let collection: Document[] | undefined
    if (change.target === 'asset') collection = result.assets
    if (change.target === 'episode') collection = result.episodes
    if (change.target === 'card' || change.target === 'shot') {
      const episode = result.episodes.find((item: Document) => item.id === change.episodeId)
      if (!episode) throw new Error('分集已被删除，草稿仍保留在本机')
      collection = episode.cards
      if (change.target === 'shot') {
        const card = collection!.find(item => item.id === change.cardId)
        if (!card) throw new Error('分镜已被删除，草稿仍保留在本机')
        collection = card.shots ||= []
        if (change.remove || change.value || own(change.fields || {}, 'duration') || change.unset?.includes('duration')) retime.add(card)
      }
    }
    if (change.order) {
      const ordered = change.order.map(id => collection!.find(item => item.id === id)).filter(Boolean) as Document[]
      const ids = new Set(change.order)
      collection!.splice(0, collection!.length, ...ordered, ...collection!.filter(item => !ids.has(item.id)))
      continue
    }
    if (change.remove) {
      const index = collection!.findIndex(item => item.id === change.id)
      if (index >= 0) collection!.splice(index, 1)
      continue
    }
    let entity = change.target === 'project' ? result : collection!.find(item => item.id === change.id)
    if (change.value) {
      if (!entity) {
        entity = clean(change.target, change.value)
        // A new episode owns its initial cards. They are still sanitized before persistence.
        if (change.target === 'card') entity.shots = clone(change.value.shots || [])
        if (change.target === 'episode') entity.cards = (Array.isArray(change.value.cards) ? change.value.cards : []).map((card: Document) => ({ ...clean('card', card), shots: clone(card.shots || []) }))
        collection!.push(entity)
      }
      // Replaying a create never overwrites an entity another page has edited.
    }
    if (!entity) throw new Error('编辑内容已被删除，草稿仍保留在本机')
    for (const [field, value] of Object.entries(change.fields || {})) {
      const parts = safePath(change.target, field)
      let parent = entity
      for (const part of parts.slice(0, -1)) {
        if (!object(parent[part])) parent[part] = {}
        parent = parent[part]
      }
      parent[parts.at(-1)!] = clone(value)
    }
    for (const field of change.unset || []) {
      const parts = safePath(change.target, field)
      let parent: Document | undefined = entity
      for (const part of parts.slice(0, -1)) parent = parent && object(parent[part]) ? parent[part] : undefined
      if (parent) delete parent[parts.at(-1)!]
    }
  }
  for (const card of retime) {
    if (card.shots.length && card.shots.every((shot: Document) => Number.isFinite(shot.duration) && shot.duration > 0))
      card.duration = card.shots.reduce((total: number, shot: Document) => total + shot.duration, 0)
  }
  return result
}

function fieldsChanged(target: ScriptVideoChange['target'], before: Document, after: Document) {
  const fields: Record<string, unknown> = {}, unset: string[] = []
  function visit(a: Document, b: Document, prefix = '') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!prefix && !editable(target, key)) continue
      if (key.startsWith('_') || forbidden.has(key)) continue
      const name = prefix ? `${prefix}.${key}` : key
      if (same(a[key], b[key])) continue
      if (!own(b, key) || b[key] === undefined) unset.push(name)
      else if (object(a[key]) && object(b[key]) && Object.keys(b[key]).length) visit(a[key], b[key], name)
      else fields[name] = clone(b[key])
    }
  }
  visit(before, after)
  return { fields, unset }
}

/** Only bodies that have actually been loaded may produce edits. Summary rows
 * cannot become empty episode replacements during navigation or reconnect. */
export function diffScriptVideoChanges(
  base: Document, current: Document,
  options: { loadedEpisodeIds?: Iterable<string> } = {},
): ScriptVideoChange[] {
  const changes: ScriptVideoChange[] = []
  const loaded = options.loadedEpisodeIds ? new Set(options.loadedEpisodeIds) : undefined
  function fields(target: ScriptVideoChange['target'], a: Document, b: Document, id?: string, episodeId?: string, cardId?: string) {
    const changed = fieldsChanged(target, a, b)
    if (Object.keys(changed.fields).length || changed.unset.length) changes.push({ target, ...(id && { id }), ...(episodeId && { episodeId }), ...(cardId && { cardId }), ...changed })
  }
  function collection(target: 'asset' | 'episode' | 'card' | 'shot', a: Document[] = [], b: Document[] = [], episodeId?: string, cardId?: string) {
    const old = new Map(a.map(item => [item.id, item])), next = new Map(b.map(item => [item.id, item]))
    for (const item of a) if (!next.has(item.id)) changes.push({ target, id: item.id, ...(episodeId && { episodeId }), ...(cardId && { cardId }), remove: true })
    for (const item of b) {
      const before = old.get(item.id)
      if (!before) {
        if (target === 'episode' && loaded && !loaded.has(item.id)) continue
        const value = clean(target, item)
        if (target === 'card') value.shots = clone(item.shots || [])
        if (target === 'episode') value.cards = (item.cards || []).map((card: Document) => ({ ...clean('card', card), shots: clone(card.shots || []) }))
        changes.push({ target, id: item.id, ...(episodeId && { episodeId }), ...(cardId && { cardId }), value })
      } else if (target !== 'episode' || !loaded || loaded.has(item.id)) {
        fields(target, before, item, item.id, episodeId, cardId)
        if (target === 'episode') collection('card', before.cards, item.cards, item.id)
        if (target === 'card') collection('shot', before.shots, item.shots, episodeId, item.id)
      }
    }
    // Additions/deletions already carry their own order. Emit a reorder only
    // when surviving entities were reordered, and preserve concurrent additions.
    const appliedOrder = [...a.filter(item => next.has(item.id)), ...b.filter(item => !old.has(item.id))].map(item => item.id)
    if (!same(appliedOrder, b.map(item => item.id))) changes.push({ target, ...(episodeId && { episodeId }), ...(cardId && { cardId }), order: b.map(item => item.id) })
  }
  fields('project', base, current)
  if (Array.isArray(base.assets) && Array.isArray(current.assets)) collection('asset', base.assets, current.assets)
  collection('episode', base.episodes, current.episodes)
  return changes
}
