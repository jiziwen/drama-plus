import { declaredScriptVideoSceneName } from './script-video-scene-continuity.js'
import type { ScriptVideoAsset, ScriptVideoCard } from './script-video-types.js'

type Card = Pick<ScriptVideoCard, 'id' | 'scene' | 'manuallyAdded'> & {
  prompt?: string
  assetIds?: readonly string[]
  shots?: ReadonlyArray<Pick<ScriptVideoCard['shots'][number], 'duration' | 'action' | 'camera'>>
}
type SourceScene = { name: string; number: string; time: string; environment: string; establishingLight?: string; index: number }
export type ScriptVideoLightingSceneRange = {
  sceneKey: string
  sceneName: string
  lighting: string
  firstShot: number
  lastShot: number
  startSeconds: number
  endSeconds: number
  /** A transition inside the first shot only reaches this scene after the cut. */
  transitionIn?: boolean
  /** Equal bounds mean the entire run is a transition, with no safe frame to sample. */
  stableStartSeconds: number
  stableEndSeconds: number
}

const label = /^(?:(?:切换(?:至|到)?|切入|转入)\s*)?(?:场景[一二三四五六七八九十\d]*|地点)\s*[:：]\s*/u
const sceneNumber = /场(?:号|次)\s*[:：]?\s*([\d]+(?:[-－.]\d+)*)/u
const hour = /[子丑寅卯辰巳午未申酉戌亥]时|\d{1,2}[:：]\d{2}|凌晨|黎明|拂晓|清晨|早晨|早上|上午|正午|中午|午后|下午|傍晚|黄昏|日落|深夜|午夜|夜晚|夜间|夜里|白昼|白天|日间|日出/u
const dayChange = /翌日|次日|次晨|隔日|隔天|第二天|数日后|数年后|多年后/u
const lightWord = /阳光|日照|日光|月光|烛光|灯光|灯火|光线|光源|光照|采光|晨光|天光|侧光|散射光|直射光|逆光|柔光|冷光|暖光|明暗|昏暗|幽暗|阴影|背阴|晴天|晴朗|阴天|阴雨|阴云|多云|大雨|暴雨|浓雾|大雪/u
const shotNumbers = /(?:镜头|镜号)\s*(\d+)(?:\s*[-–—~～至到]\s*(?:镜头)?\s*(\d+))?/u
const transitionWord = /切镜转场|转场镜头|(?:画面|镜头)(?:缓缓|逐渐|快速)?(?:切入|切至|切到|转入|转至|叠化)|(?:淡出|叠化)至/u
const lightChange = /(?:灯(?:光|火)?|烛(?:光|火)|光源)(?:突然|骤然|渐渐|逐渐|全部)?(?:熄灭|骤灭|亮起|熄了)|熄(?:灭|掉)(?:了)?(?:灯火|油灯|烛火)|拉开窗帘|天色(?:逐渐|突然|渐渐)(?:变暗|转暗|转亮)/u
const shadeChange = /(?:从|自)[^，。；\n]{1,14}(?:走|步|迈|退|跨|跑|钻|移|踏|闯)(?:入|进|到|至|进了)(?:了)?(?:明亮的|强烈的|正午的)?(?:阳光|日光|直射光|日照区|阴影|廊下|背阴处)|(?:走|步|迈|退|踏|跨)(?:入|进|到)(?:阳光直射处|背阴处|浓重的阴影|阴影中)|(?:走出|离开)(?:廊下的)?阴影[^，。；\n]{0,8}(?:日光|阳光)/u
const timeChange = /(?:时间(?:跳至|转到|来到)|画面(?:跳切|切至|切到)|转眼(?:已是)?)(?:次日|翌日)?(?:凌晨|清晨|白天|日间|正午|午后|黄昏|傍晚|夜晚|深夜)|^(?:镜头\d+[:：]?|画面(?:与动作)?[:：])?\s*(?:次日|翌日|隔天|第二天|数日后)(?:的)?(?:凌晨|清晨|白天|日间|正午|午后|黄昏|傍晚|夜晚|深夜)?/u
const skyConditions = [
  ['晴', /晴天|晴朗|晴空|阳光照|日光直射/u], ['阴', /阴天|阴云|多云|阴沉|乌云/u],
  ['雨', /雨天|阴雨|暴雨|大雨|细雨/u], ['雪', /雪天|大雪|暴雪/u], ['雾', /浓雾|大雾/u],
] as const
const sky = (text: string) => skyConditions.find(([, pattern]) => pattern.test(text))?.[0] || ''
const clean = (value: string) => value.replaceAll('@', '').trim().normalize('NFKC')

function sourceScenes(script: string): SourceScene[] {
  const scenes: SourceScene[] = []
  let number = '', scene: SourceScene | undefined
  for (const raw of script.split(/\r?\n/u)) {
    const line = clean(raw.replaceAll('**', '').replace(/^\s*#{1,6}\s*/u, ''))
    const field = /^(场次|场号|场景|地点|时间|天气(?:\/环境)?|光线|环境):\s*(.+)$/u.exec(line)
    if (!field) {
      if (scene && scene.establishingLight === undefined && /^[△Δ▲]?\s*画面:/u.test(line)) {
        const opening = line.replace(/^[△Δ▲]?\s*画面:\s*/u, '').replace(/【[^】]*】/gu, '')
        scene.establishingLight = lightingFacts(opening.split(/[。；;]/u)[0]).filter(fact => fact.length <= 35).join('，')
      }
      continue
    }
    const [, key, value] = field
    if (key === '场次' || key === '场号') {
      number = value
      scene = undefined
    } else if (key === '场景' || key === '地点') {
      scene = { number, name: value, time: '', environment: '', index: scenes.length }
      scenes.push(scene)
      number = ''
    } else if (scene && key === '时间') scene.time = value
    else if (scene) scene.environment += '，' + value
  }
  return scenes
}

function lightingFacts(value: string) {
  return clean(value).split(/[,，。;；、|｜]/u)
    .map(text => text.trim()).filter(text => text.length <= 75 && lightWord.test(text))
}

function timeOf(value: string) {
  // A specific hour takes precedence over the coarser “日间” in “日间巳时”.
  return value.match(/[子丑寅卯辰巳午未申酉戌亥]时/u)?.[0] ?? value.match(hour)?.[0] ??
    value.match(/(?:^|[｜|,，:：\s])([日夜])(?:[｜|,，。\s]|$)/u)?.[1] ?? ''
}

function shotVisuals(card: Card) {
  // The saved prompt may include manual camera or action edits made after the board was generated.
  const blocks = new Map<number, string>()
  for (const match of (card.prompt || '').matchAll(/^镜头\s*(\d+)(?:\s*[（(][^\r\n]*[）)])?\s*$([\s\S]*?)(?=^镜头\s*\d+|(?![\s\S]))/gmu)) {
    const text = match[2].split(/^(?:对白\s*[／/]\s*音效|对白|台词|→衔接|末镜停在)\s*[：:]/mu)[0]
    if (/^(?:景别\s*[／/]\s*机位\s*[／/]\s*运动|画面与动作)\s*[：:]/mu.test(text)) blocks.set(Number(match[1]), clean(text))
  }
  return (card.shots || []).map((shot, index) => blocks.get(index + 1) ?? clean(shot.camera + '\n' + shot.action))
}

type Declaration = {
  name: string; identity: string; numbered: boolean; weather: string; lighting: string; description: string; first?: number; last?: number
}

function declarations(card: Card, sources: SourceScene[], assets: readonly ScriptVideoAsset[]): Declaration[] {
  const header = /^\s*场景\s*[：:]\s*([^\r\n]+)/mu.exec(card.prompt || '')?.[1] || card.scene
  const boundScenes = assets.filter(asset => asset.kind === 'scene' && card.assetIds?.includes(asset.id))
  const fallback = boundScenes.length === 1 && sources.length === 1 && clean(boundScenes[0].name) === sources[0].name
  const text = clean(header || (fallback ? boundScenes[0].name : ''))
  if (!text) return []
  const sections = text.split(/[;；]\s*(?=(?:切换(?:至|到)?|切入|转入)?\s*(?:场景[一二三四五六七八九十\d]*|地点)\s*[:：])/u)
  const found = sections.flatMap(section => {
    const description = section.replace(label, '').replace(label, '')
    const parts = description.split(/[｜|]/u)
    const name = clean(declaredScriptVideoSceneName(description) || parts.find(part => !sceneNumber.test(part) && !shotNumbers.test(part)) || '').replace(/[。.]$/u, '')
    if (!name || name.length > 100 || /[,，:：、;；→/]|转场|切换|^(?:未知|未提供|待定|同上|承上|无)$/u.test(name)) return []
    const named = assets.filter(asset => asset.kind === 'scene' && clean(asset.name) === name)
    const resolved = named.length > 1 ? named.filter(asset => card.assetIds?.includes(asset.id)) : named
    if (resolved.length > 1 || (named.length > 1 && !resolved.length)) return []
    const id = sceneNumber.exec(description)?.[1] ?? ''
    const time = timeOf(description.slice(description.indexOf(name) + name.length))
    const relativeDay = dayChange.exec(description)?.[0] ?? ''
    const byName = sources.filter(scene => scene.name === name)
    const matches = byName.filter(scene => (!id || !scene.number || id === scene.number) &&
      (!relativeDay || !scene.time.match(dayChange) || scene.time.includes(relativeDay)) &&
      (!time || !timeOf(scene.time) || scene.time.includes(time) || time === timeOf(scene.time)))
    const weather = sky(parts.slice(1).join('，'))
    const matchingWeather = weather ? matches.filter(scene => sky(scene.environment) === weather) : []
    const source = matches.length === 1 ? matches[0] : matchingWeather.length === 1 ? matchingWeather[0] : undefined
    const sourceWeather = sky(source?.environment || '')
    const cardFacts = lightingFacts(parts.slice(1).join('，')).filter(fact =>
      (!sourceWeather || !sky(fact) || sky(fact) === sourceWeather) &&
      !assets.some(asset => asset.kind === 'scene' && clean(asset.name) !== name && fact.includes(clean(asset.name))),
    )
    const facts = [...new Set([source?.time || [relativeDay, time].filter(Boolean).join(''),
      ...lightingFacts(source?.environment || ''), ...lightingFacts(source?.establishingLight || ''), ...cardFacts].filter(Boolean))]
    const lighting = facts.filter(fact => !facts.some(other => other !== fact && other.includes(fact))).join('，')
    const bounds = shotNumbers.exec(description)
    const number = source ? 'script-' + source.index : id
    const identity = JSON.stringify([resolved[0]?.id || name, number, relativeDay || source?.time.match(dayChange)?.[0],
      timeOf(source?.time || '') || time, !source && matches.length > 1 && !id ? card.id : undefined])
    return [{ name, identity, numbered: !!(id || source?.number), weather: sourceWeather || weather, description, lighting, first: bounds ? Number(bounds[1]) : undefined, last: bounds ? Number(bounds[2] || bounds[1]) : undefined }]
  })
  return found.length === sections.length ? found : []
}

function transitionTo(text: string, name: string) {
  for (const clause of text.split(/[。；;，,\n]/u)) {
    const position = clause.indexOf(name)
    if (position < 0 || !/^(?:内|中)?(?:[\s:：。；;，,!?！？)]|$)/u.test(clause.slice(position + name.length))) continue
    const lead = clause.slice(0, position)
    if (/不切|不转|不得|尚未|不要|禁止|看向|望向|视线|想象|下一镜|准备/u.test(lead)) continue
    if (/(?:切(?:换)?[入至到]|转[入至到]|转场[至到]|驶入|进入|步入|走进|踏入|叠化[至到])\s*$/u.test(lead)) return true
  }
  return false
}

/** Use a uniquely declared landmark only when the shot physically places someone there.
 * Looking toward a gate or hearing sound from outside does not move the camera outside. */
function atLandmark(text: string, target: Declaration, others: Declaration[]) {
  const markers = target.description.split(/[，,、；;。｜|与及]/u)
    .map(part => part.trim().replace(/^设(?:有)?/u, ''))
    .filter(part => part.length >= 4 && part.length <= 18 && !others.some(item => item !== target && item.description.includes(part)))
  return markers.some(marker => {
    const at = text.indexOf(marker)
    return at >= 0 && /(?:站上|站在|立于|立在|来到|抵达|置身|身处|位于|跪在|走上|走到)\s*$/u.test(text.slice(0, at))
  })
}

function sceneStarts(scenes: Declaration[], shots: string[]) {
  const starts: number[] = []
  for (const [i, scene] of scenes.entries()) {
    let start = scene.first ? scene.first - 1 : 0
    if (!scene.first && i) {
      start = shots.findIndex((text, index) => index > starts[i - 1] && transitionTo(text, scene.name))
      if (start < 0) start = shots.findIndex((text, index) => index > starts[i - 1] && atLandmark(text, scene, scenes))
      if (start < 0) {
        // An explicitly marked scene change can establish the cut when it has only one possible destination.
        const cuts = shots.flatMap((text, index) => index > starts[i - 1] && /切镜转场|跨场转场/u.test(text) ? [index] : [])
        if (i === scenes.length - 1 && cuts.length === 1) start = cuts[0]
      }
    }
    if (start < 0 || start >= shots.length || i && start <= starts[i - 1] ||
      scene.last !== undefined && (scene.last > shots.length || scene.last <= start) ||
      i && scenes[i - 1].last !== undefined && scenes[i - 1].last! > start) return []
    starts.push(start)
  }
  return starts
}

function changedLight(visual: string): string {
  const clauses = visual.replace(/[“「][^”」]*[”」]/gu, '').split(/[。,，;；\n]/u)
  for (const text of clauses) {
    const clause = text.replace(/^(?:画面与动作|景别\/机位\/运动):\s*/u, '').trim()
    if (/不得|尚未|没有|不要|不会|准备|试图|目光|视线|望向|看向/u.test(clause)) continue
    const time = clause.match(timeChange)?.[0]
    if (time) return time
    const shade = clause.match(shadeChange)?.[0]
    if (shade) return /(?:阳光|日光|直射光|日照区|阳光直射处)$/u.test(shade)
      ? '进入日照区的人物受日光直射，阴影处保持原有受光。' : '进入阴影处的人物受间接光，日照区保持原有受光。'
    const change = clause.match(lightChange)?.[0]
    if (change) return change
  }
  return ''
}

export function buildScriptVideoLightingPlan(cards: readonly Card[], script: string, assets: readonly ScriptVideoAsset[]): Record<string, ScriptVideoLightingSceneRange[]> {
  const sources = sourceScenes(script || '')
  const result: Record<string, ScriptVideoLightingSceneRange[]> = Object.create(null)
  // A cutaway can return to a specifically numbered screenplay scene. Without a
  // scene number, identical location text after a cut cannot establish the same occasion.
  type State = { key: string; weather: string; lightAfterChange: string }
  const numberedScenes = new Map<string, State>()
  let activeIdentity = '', state: State | undefined
  for (const card of cards) {
    if (!card?.id) { activeIdentity = ''; continue }
    const ranges: ScriptVideoLightingSceneRange[] = []
    result[card.id] = ranges
    if (card.manuallyAdded) continue
    const storedShots = card.shots
    if (!Array.isArray(storedShots) || !storedShots.length || storedShots.some(shot => !shot || !(shot.duration > 0) || !Number.isFinite(shot.duration))) {
      activeIdentity = ''
      continue
    }
    const shots = shotVisuals(card)
    const scenes = declarations(card, sources, assets)
    // Older cards can have only an opening location in their header. Respect a later explicit
    // change to a known scene in their effective visual instructions.
    if (scenes.length === 1 && !scenes[0].first) {
      const names = new Set([...sources.map(scene => scene.name),
        ...assets.filter(asset => asset.kind === 'scene' && card.assetIds?.includes(asset.id)).map(asset => clean(asset.name))])
      for (let index = 1; index < shots.length; index++) {
        const destinations = [...names].filter(name => name !== scenes.at(-1)?.name && transitionTo(shots[index], name))
        if (destinations.length !== 1) continue
        const next = declarations({ ...card, prompt: '', scene: destinations[0] }, sources, assets)[0]
        if (next) scenes.push({ ...next, first: index + 1 })
      }
    }
    const starts = sceneStarts(scenes, shots)
    if (!starts.length) { activeIdentity = ''; continue }
    let seconds = 0, current = 0
    for (const [index, shot] of storedShots.entries()) {
      const startSeconds = seconds
      seconds += shot.duration
      if (starts[current + 1] === index) current++
      const scene = scenes[current], text = shots[index]
      if (index < starts[current] || scene.last && index >= scene.last || /(?:^|[:：])\s*(?:小剧场|幻想镜头|梦境镜头|闪回镜头)[｜|／/]/mu.test(text)) continue
      const change = changedLight(text)
      if (scene.identity !== activeIdentity) {
        state = scene.numbered ? numberedScenes.get(scene.identity) : undefined
        activeIdentity = scene.identity
      }
      if (!state || change || scene.weather && state.weather && scene.weather !== state.weather) {
        state = { key: JSON.stringify([scene.identity, card.id, index + 1]), weather: scene.weather, lightAfterChange: change }
        if (scene.numbered) numberedScenes.set(scene.identity, state)
      } else if (scene.weather) state.weather = scene.weather
      const lighting = state.lightAfterChange || scene.lighting
      const previous = ranges.at(-1)
      if (previous && previous.sceneKey === state.key && previous.lastShot === index) {
        previous.lastShot = index + 1
        previous.endSeconds = previous.stableEndSeconds = seconds
      } else {
        const cut = !!change || index === starts[current] && (transitionTo(text, scene.name) || /镜头\s*\d+\s*转场/u.test(scene.description) || current > 0 && transitionWord.test(text))
        ranges.push({ sceneKey: state.key, sceneName: scene.name, lighting, firstShot: index + 1, lastShot: index + 1,
          startSeconds, endSeconds: seconds, stableStartSeconds: cut ? seconds : startSeconds, stableEndSeconds: seconds, ...(cut ? { transitionIn: true } : {}) })
      }
    }
  }
  return result
}
