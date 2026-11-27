import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSeedance25Model } from './seedance-models.js'
import type { ScriptVideoStoryboardMode } from './script-video-storyboard-mode.js'

export type ScriptVideoStage = 'outline' | 'storyboard' | 'revision'
const assetExtraction = '资产提取.md'
const source = 'references/sd25-v2.1/'
const five = source + '五维镜头优化Skill-原始参考/'
const combat = 'fight-choreography/'
const ref = combat + 'references/'
const seedance = 'references/seedance-2.5/'
const files = {
  main: 'SKILL.md',
  outline: '分段大纲.md',
  cultivation: 'cultivation/SD2.5_30秒连续3D动漫分镜第三版.txt',
  cultivationAdapter: 'cultivation/项目适配.md',
  adapter: '项目适配说明.md',
  validation: 'references/validation.md',
  rules: source + '02-当前有效总规则.txt',
  setting: source + '03-项目设定卡.md',
  template: source + '04-正式输出模板.md',
  fantasy: source + '05-高武题材模块.txt',
  romance: source + '06-校园喜剧恋爱模块.txt',
  screen: source + '07-心声与界面模块.txt',
  checklist: source + '08-交付前自检表.md',
  fiveGuide: source + '09-五维镜头优化Skill调用说明.md',
  fiveMain: five + 'SKILL.md',
  fiveCore: five + 'references/v8-core-template.md',
  sd20: five + 'references/platform-profiles/SD20-001_v1.0.md',
  sd25: five + 'references/platform-profiles/SD25-001_v1.0.md',
  hybrid: five + 'references/platform-profiles/SD25-AUTO-HYBRID_v1.0.md',
  director: five + 'references/director-modules/DIR-PR-001_v2.1.md',
  fight: combat + 'SKILL.md',
  prompt25: seedance + '片段与镜头.md',
  text25: seedance + '声音与画内文字.md',
  reference25: seedance + '参考图与视频任务.md',
  troubleshoot25: seedance + '成片问题对照.md',
}
const chapters = [
  '01-02-visual-style',
  '03-06-scene-character-effects',
  '07-01-combat-exchanges',
  '07-08-weapons-and-draw',
  '09-10-rhythm-and-outcome',
  '11-camera',
  '12-01-finisher-structure',
  '12-02-ink',
  '12-03-metal',
  '12-04-wind',
  '12-05-lightning',
  '12-06-fire',
  '12-07-ice',
  '12-08-poison',
  '12-09-cosmos',
  '12-10-crystal',
  '12-11-gravity-space',
  '12-12-chaos-fusion',
  '12-13-archery',
  '12-14-other',
  '13-close-ups',
  '14-dialogue',
  '15-16-sequences',
  '17-20-output',
]
const chapterPath = (name: string) => ref + name + '.md'
const templateDirectory = fileURLToPath(
  new URL('../../workspace/skills/script-to-video/', import.meta.url),
)

/** Only curated rule documents are callable. Legacy scripts, arbitrary paths and links escaping the skill are never opened. */
export async function loadScriptVideoSkill(
  stage: ScriptVideoStage,
  context: {
    scene: string
    combatEnabled?: boolean
    hasCombat?: boolean
    crossSegment?: boolean
    instruction?: string
    videoModel?: string
    reviewing?: boolean
    sharedOutline?: boolean
    storyboardMode?: ScriptVideoStoryboardMode
  },
) {
  if (stage === 'outline' && context.sharedOutline) {
    const requested = [files.outline, files.setting]
    if (/心声|内心独白|旁白|系统|手机|屏幕|弹窗|界面|\bOS\b/iu.test(context.scene)) requested.push(files.screen)
    return readScriptVideoSkillDocuments(requested, new Set([...requested, files.screen]))
  }
  if (stage !== 'outline' && context.storyboardMode === 'cultivation' && !context.reviewing) {
    const requested = [files.cultivation, files.cultivationAdapter, files.validation]
    return readScriptVideoSkillDocuments(requested, new Set(requested))
  }
  const requested = new Set<string>([files.main, files.adapter, files.rules])
  const add = (...names: string[]) =>
    names.forEach((name) => requested.add(name))
  const text = context.scene
  // An unconfigured project can already export for Seedance 2.5. References for
  // video editing and troubleshooting are selected by the user's request only.
  const forSeedance = !context.videoModel || isSeedance25Model(context.videoModel)
  const writingForSeedance = forSeedance && stage !== 'outline' && !context.reviewing
  const request = context.instruction || ''
  const seedanceDocs: string[] = []
  if (writingForSeedance) {
    seedanceDocs.push(files.prompt25)
    if (/对白|台词|旁白|心声|字幕|音效|[（(](?:OS|OV|VO)[）)]|[“「]|系统|圣旨|牌匾|匾额|屏幕|手机|字样|信件/iu.test(text))
      seedanceDocs.push(files.text25)
    if (/白模|多宫格|九宫格|故事板图|关键帧|首尾帧|延长视频|视频延长|续写视频|编辑视频|视频编辑|跨版本|翻译视频|视频翻译/u.test(request))
      seedanceDocs.push(files.reference25)
    if (/串[角人音色]|错配|错别字|拼写错误|解码失败|指纹[状纹]|噪[音声]|啸叫|水波纹|色差|风格不一|混[语音]|[时帧]长不一|效果不稳|(?:眼睛|瞳孔).{0,5}发光|(?:字幕|配乐|背景音乐|画幅|宽高比).{0,10}(?:失效|出现|多余|错误|错了|不对|效果差|不生效)|(?:意外|冒出|多出|还是有|仍有|出现了?).{0,5}(?:字幕|配乐|背景音乐|回音)/u.test(request))
      seedanceDocs.push(files.troubleshoot25)
    add(...seedanceDocs)
  }
  const isFight =
    !!context.hasCombat ||
    /打斗|战斗|搏斗|激战|交手|攻防|缠斗|决斗|挥拳|出拳|踢向|反击|拔刀|挥刀|劈砍|刺向|扭打|躲闪|挥剑|格挡|对砍|擒拿|交锋|厮杀|射击|开枪|扣动扳机|斩向|击中|袭来/u.test(
      text,
    )
  if (stage === 'outline') add(files.setting)
  else add(files.template, files.checklist, files.validation)
  if (isFight || /高武|武道|机甲|修仙/u.test(text)) add(files.fantasy)
  if (/校园|学长|校花|班主任|恋爱|谈恋爱|表白|告白/u.test(text))
    add(files.romance)
  if (/心声|内心独白|旁白|系统|手机|屏幕|弹窗|界面|\bOS\b/iu.test(text))
    add(files.screen)
  if (
    isFight ||
    context.crossSegment ||
    /复杂场景|巨物|机甲|异象|跨段|连续动作|运镜|镜头优化|五维|AUTO-HYBRID/iu.test(
      text,
    )
  ) {
    add(files.fiveGuide, files.fiveMain, files.fiveCore)
  }
  // Platform and director choices must originate from requested project settings, never a character's line.
  if (/SD2[.]?5|SD25/i.test(context.instruction || '')) add(files.sd25)
  if (/SD2[.]?0|SD20/i.test(context.instruction || '')) add(files.sd20)
  if (/AUTO-HYBRID/i.test(context.instruction || ''))
    add(files.sd25, files.hybrid)
  const directorRequested = /DIR-PR-001/i.test(context.instruction || '')
  if (directorRequested)
    add(files.fiveGuide, files.fiveMain, files.fiveCore, files.director)
  if (isFight && context.combatEnabled !== false) {
    add(files.fight, chapterPath('07-01-combat-exchanges'))
    if (stage !== 'outline')
      add(chapterPath('11-camera'), chapterPath('17-20-output'))
    if (/兵器|持刀|剑|拔刀|枪|长矛|棍|斩/u.test(text))
      add(chapterPath('07-08-weapons-and-draw'))
    if (/大招|终结技|绝招|必杀/u.test(text))
      add(chapterPath('12-01-finisher-structure'))
    // The episode writer makes a single request. Resolve the relevant chapter
    // here so it needn't call a tool and send the script a second time.
    if (stage === 'storyboard') {
      if (/特写/u.test(text)) add(chapterPath('13-close-ups'))
      if (/边打边说|交手时喊|边打边喊/u.test(text)) add(chapterPath('14-dialogue'))
      if (/多段打斗|连续打斗|追逐战/u.test(text)) add(chapterPath('15-16-sequences'))
      const effects: [RegExp, string][] = [
        [/水墨|墨系/u, '12-02-ink'], [/金系|金之力/u, '12-03-metal'],
        [/风系|风刃/u, '12-04-wind'], [/雷系|雷法/u, '12-05-lightning'],
        [/火系|火法/u, '12-06-fire'], [/冰系|冰法/u, '12-07-ice'],
        [/毒系|毒法/u, '12-08-poison'], [/星辰之力|宇宙系/u, '12-09-cosmos'],
        [/晶体系|晶化/u, '12-10-crystal'], [/重力场|空间系/u, '12-11-gravity-space'],
        [/混沌系|元素融合/u, '12-12-chaos-fusion'], [/弓术|箭阵/u, '12-13-archery'],
      ]
      for (const [match, chapter] of effects)
        if (match.test(text)) add(chapterPath(chapter))
    }
  }
  const allowed = new Set<string>(Object.values(files).filter(name =>
    name !== files.outline && name !== files.cultivation && name !== files.cultivationAdapter))
  for (const doc of [files.prompt25, files.text25, files.reference25, files.troubleshoot25])
    if (!seedanceDocs.includes(doc)) allowed.delete(doc)
  if (!directorRequested) allowed.delete(files.director)
  if (context.combatEnabled === false) allowed.delete(files.fight)
  else for (const chapter of chapters) allowed.add(chapterPath(chapter))

  return readScriptVideoSkillDocuments(requested, allowed)
}

export async function loadScriptVideoAssetSkill() {
  return (await readScriptVideoSkillDocuments([assetExtraction], new Set([assetExtraction]))).instructions
}

// Installed workspaces keep editable copies. Update the old delivery instructions
// in the model's copy without replacing the surrounding custom guidance.
function workspaceStoryboardScope(name: string, text: string) {
  if (name === files.validation)
    return text.replaceAll('模型在一次回答中按已确认的主干事件顺序写完整集分镜',
      '生成正式分镜时，模型按本次请求指定的片段范围和确认的事件顺序提交 cards')
  if (name === files.adapter)
    return text.replaceAll('正式稿在一次请求中写完整集。', '生成正式分镜时，按本次请求的片段范围交付。')
      .replaceAll('按已确认大纲的顺序输出所有片段', '按生效时间表的顺序输出本次目标片段')
      .replaceAll('同一次回答里上一段的实际末镜', '上一段的实际末镜')
  return text
}

async function readScriptVideoSkillDocuments(requested: Iterable<string>, allowed: Set<string>) {
  const roots = process.env.WORKSPACE_PATH
    ? [
        path.resolve(process.env.WORKSPACE_PATH, 'skills/script-to-video'),
        templateDirectory,
      ]
    : [templateDirectory]
  const documents = new Map<string, string>()
  async function readSkill(name: string) {
    if (!allowed.has(name))
      throw new Error('只能读取当前 Skill 目录中列出的参考文件')
    const existing = documents.get(name)
    if (existing !== undefined) return existing
    for (const root of roots) {
      try {
        const parent = await realpath(root)
        const full = await realpath(path.join(parent, name))
        if (!full.startsWith(parent + path.sep))
          throw new Error('参考资料路径超出当前 Skill')
        const text = await readFile(full, 'utf8')
        const content = root === templateDirectory ? text : workspaceStoryboardScope(name, text)
        documents.set(name, content)
        return content
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err
      }
    }
    throw new Error('当前 Skill 所需参考文件缺失：' + name)
  }
  const snippets: string[] = []
  for (const name of requested)
    snippets.push('【' + name + '】\n' + (await readSkill(name)))
  return {
    instructions: snippets.join('\n\n'),
    allowed: [...allowed],
    readSkill,
    reads: () => [...documents.keys()],
  }
}
