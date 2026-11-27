// Existing asset prompts may already start with the previous generated layout.
const previousCharacterLayout = [
  '角色设定参考图（正脸特写＋三视图）。左侧是正脸特写，完整展示头部和肩部。右侧按正面、90 度侧面、背面排列三张等高全身图，头顶和脚底对齐。',
  '四个视图是同一角色的同一套造型，面容、发型、体型、服装和配饰一致。面部表情中性，全身采用自然 A 字站姿。纯白背景，柔和均匀的光线。画面无文字、水印或其他人物。',
  '构图以以上布局为准，以下描述用于角色设定和画风。',
  '',
].join('\n')

const characterLayoutTitle = '角色设定参考图（正脸特写＋服装三视图＋细节特写）。'
const characterLayoutClosing = '构图采用上述布局，以下描述用于角色设定和画风。'
const characterLayout = [
  characterLayoutTitle + '16:9 横向构图，纯白无缝背景，柔和均匀的棚拍光。',
  '左侧约占 38%，为超大正面头部与上半身肖像。重点展示面容、发型、已有发饰和服装真实的领口层次，角色表情中性。',
  '中部约占 50%，从左到右排列严格正面、严格 90 度侧面、严格 180 度背面三个服装视图。正面和侧面从颈根展示至鞋底，以干净的服装资产展示方式省略头部。颈根以上留白，头部与发丝不进入这两格。背面从头顶到鞋底完整入镜，保留完整头部、发型、衣装和鞋靴，后脑朝向镜头。',
  '三个服装视图采用同一比例，鞋底基线对齐，双臂自然垂落，双手放松。同一角色的体型、服装和配饰在不同视角保持一致。',
  '最右侧约占 12%，从上到下排列三个矩形细节特写，格间以窄白色留白分隔。依次优先展示发型或发饰、肩部或领口的结构与工艺、腰部结构或配饰。按角色已有设定选取辨识细节。',
  '保持各栏服装的颜色、材质、纹样和配饰一致。画面无文字、标签、水印或其他人物。' + characterLayoutClosing,
].join('\n')

const sceneLayoutHeading = '[5.四宫格多机位排版]'
const sceneDetailHeadings = /\[(?:0[.．]\s*画风与光影|1[.．]\s*空间档案|2[.．]\s*建筑骨架|3[.．]\s*五方十字坐标陈设|4[.．]\s*光影与色彩)\][ \t]*[:：]?/gu
const sceneLayoutStart = /\[5[.．]\s*四宫格多机位排版\]/u
const midjourneyParameterStart = /(?:^|\s)(?=--[a-z][a-z-]*(?:\s|$))/iu
const midjourneySceneLayout = '同一空景的 2×2 场景设定图，等格、相同布局与光照，以入口或主通道为轴。'
  + '四格短标题：左上入口向内正视 "FRONT"，右上从左侧 90° 平视 "SIDE"，左下朝入口 180° 反打 "REVERSE"，右下 45° 全局俯视 "OVERVIEW"。'

export function scriptVideoMidjourneySceneDescription(prompt: string): string {
  const parameterStart = prompt.search(midjourneyParameterStart)
  const description = parameterStart === -1 ? prompt : prompt.slice(0, parameterStart)
  return description.split(sceneLayoutStart, 1)[0].trim()
}

function compactMidjourneySceneDescription(description: string): string {
  const phrases = description.replace(sceneDetailHeadings, '\n')
    .split(/[，。；;\r\n]+|,(?!\d)/u)
    .map(part => part.trim()
      .replace(/^[①-⑳]\s*/u, '')
      .replace(/^(?:场景名|类型|时代|制式)\s*[:：]\s*/u, '')
      .replace(/^(?:全局采用|整体采用|画面呈现出?|场景为)\s*/u, '')
      .replace(/^([东西南北]侧|中央|正中)(?:为|是)/u, '$1'))
    .filter(part => part && !/^(?:纯)?原创虚构环境(?:与建筑美术设计)?$/u.test(part))
  return [...new Set(phrases)].join('，')
}

export function scriptVideoMidjourneyScenePrompt(prompt: string, rewrittenDescription?: string): string {
  const parameterStart = prompt.search(midjourneyParameterStart)
  const parameters = parameterStart === -1 ? '' : prompt.slice(parameterStart).trim().replace(/\s+/gu, ' ')
  const details = rewrittenDescription?.trim() || compactMidjourneySceneDescription(scriptVideoMidjourneySceneDescription(prompt))
  const exclusions = /(?:^|\s)--no(?:\s|$)/iu.test(parameters) ? '' : '--no people, watermarks'
  return [midjourneySceneLayout, details, parameters, exclusions].filter(Boolean).join(' ')
}

export function scriptVideoAssetImagePrompt(kind: string, prompt: string, name?: string): string {
  if (kind === 'scene') {
    if (prompt.includes(sceneLayoutHeading)) return prompt
    const frontLabel = name ? `${name}-正视（朝内）` : '正视（朝内）'
    return [
      prompt,
      '',
      sceneLayoutHeading,
      '一张横向场景设定图，等分为 2×2 四宫格，四幅都是同一三维空间的固定机位空镜。以场景档案定义的入口、空间主轴和固定地标为准。开放空间以主要通道的进入方向作为入口基准。',
      `左上【${frontLabel}】。从入口沿主轴向内平视，前景交代入口和动线，中景交代核心空间，远景交代边界或地标。`,
      '右上【90°侧视】。机位从正视画面的左侧朝右平拍，视线与主轴垂直，展示侧面结构、进深和实际有的高差。',
      '左下【180°反打（朝入口）】。从场景深处沿主轴朝入口反拍，画面左右由机位自然换位，建筑、地标和通道的实际位置一致。',
      '右下【45°全局俯视】。从入口一侧的斜上方约 45° 俯看，展示整体边界、核心结构、出入口和完整动线。',
      '四格沿用同一地点、同一时刻。结构、尺度、陈设位置、材质、光源方向和天气一致，只变化机位。四格用细线分隔，各格左上角仅标注对应机位标签。全场无人物、动物和水印。',
    ].join('\n')
  }
  if (kind !== 'character' || prompt.startsWith(characterLayout)) return prompt
  let description = prompt
  if (prompt.startsWith(previousCharacterLayout)) {
    description = prompt.slice(previousCharacterLayout.length)
  } else if (prompt.startsWith(characterLayoutTitle)) {
    const layoutEnd = prompt.indexOf(characterLayoutClosing)
    if (layoutEnd !== -1) description = prompt.slice(layoutEnd + characterLayoutClosing.length).trimStart()
  }
  return characterLayout + '\n' + description
}
