export const CHINESE_PROMPT_RULE = '图片和视频生成提示词中新创作的画面、动作、运镜和光线描述以简体中文为主，与界面语言无关。已有系统提示词、视觉风格描述、资产名称、模型名和必要技术缩写可以保留英文，包括 high-quality 等风格词，不要因这些词拒绝保存或生成。系统会自动拼接项目风格，不要重复添加。不要整段使用英文创作，也不要附加英文翻译。'

export function isChinesePrompt(text: string | null | undefined): boolean {
  if (!text?.trim()) return false
  const clean = text.replace(/@[^\s，。；：、！？\n]+(?:\s+[A-Z][a-z]+)*/g, '')
    .replace(/\b[A-Za-z][\w.-]*\d[\w.-]*\b/g, '')
    .replace(/\b(?:Unreal Engine|ComfyUI|MiniMax|Qwen|Image|Seedance|LoRA|SDXL|CGI?|PBR|HDR|[2348]D|[248]K)\b/gi, '')
    .replace(/\b(?:high[- ]quality|best[- ]quality|masterpiece|white background|cinematic lighting|sharp focus|high detail|game[- ]engine|semi[- ]realistic|low[- ]poly)\b/gi, '')
  const han = (clean.match(/\p{Script=Han}/gu) || []).length
  const latin = (clean.match(/[a-z]/gi) || []).length
  return han > 0 && han / Math.max(1, han + latin) >= 0.55
    && !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(clean)
}

export function assertChinesePrompt(text: string | null | undefined) {
  if (!isChinesePrompt(text)) throw new Error('新创作的画面、动作和运镜描述请以简体中文为主；已有系统风格词、名称和技术术语可以保留英文。')
}

const translations = new Map<string, Promise<string>>()
export async function toChinesePrompt(text: string, systemPrefix?: string): Promise<string> {
  // 系统已拼接的风格前缀按原文保留，只处理创作正文。
  if (systemPrefix && text.startsWith(systemPrefix)) {
    const body = text.slice(systemPrefix.length)
    const translated = await toChinesePrompt(body)
    return translated === body ? text : `${systemPrefix}，${translated}`
  }
  if (!text.trim() || isChinesePrompt(text)) return text
  const existing = translations.get(text)
  if (existing) return existing
  const job = (async () => {
    const { mastra } = await import('../mastra/index.js')
    const { buildAgentRequestContext } = await import('../agents/context.js')
    const result = await mastra.getAgent('prompt_generator').generate([{
      role: 'user', content: `请把以下生成提示词完整翻译为简体中文，保留所有视觉约束、专有名称和必要技术缩写。只返回翻译后的提示词，不要解释，不要调用工具。\n\n${text}`,
    }], { maxSteps: 1, toolChoice: 'none', requestContext: buildAgentRequestContext({ episodeId: 0, dramaId: 0, language: 'zh' }) })
    const translated = result.text.trim()
    assertChinesePrompt(translated)
    return translated
  })()
  translations.set(text, job)
  try {
    const value = await job
    if (translations.size > 200) translations.delete(translations.keys().next().value!)
    return value
  } catch (error) { translations.delete(text); throw error }
}
