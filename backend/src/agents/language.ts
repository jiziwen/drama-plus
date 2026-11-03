/**
 * AI 内容语言指令块 — 按 RequestContext 中的目标语言生成，追加到 Agent instructions 末尾
 *
 * 设计要点：
 * - zh / 未设置时返回空串：默认行为与历史完全一致，零 token 开销
 * - 指令用英文书写（多语言模型遵循度最好），目标语言用原生名标注
 * - 必须自带「最高优先级」声明：桌面版已安装用户的 workspace 模板不会被覆盖
 *   （cpSync force:false），旧 SKILL.md 中的「只输出中文」约束只能靠这里的显式覆盖压制
 */

const LANGUAGE_NATIVE_NAMES: Record<string, string> = {
  en: 'English',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
}

export function buildLanguageDirective(lang?: string | null): string {
  if (!lang || lang === 'zh') return ''
  const native = LANGUAGE_NATIVE_NAMES[lang] || lang
  return [
    '## Output Language (HIGHEST PRIORITY)',
    '',
    `User-facing scripts, dialogue, extracted fields, storyboard descriptions, atmosphere, and names for NEW assets MUST be written in ${native}. Image and video generation prompts are excluded and MUST always be Simplified Chinese.`,
    '',
    'This instruction sets the language for scripts and interface-facing content. Generation prompts have a separate mandatory Simplified Chinese requirement.',
    '',
    'Exceptions:',
    '- When referencing EXISTING assets with @mentions (e.g. in video prompts), the name after @ must EXACTLY match the asset name as it appears in the provided asset lists — do NOT translate or rewrite existing asset names.',
    '- Newly written image prompts, video prompts, and negative prompts MUST be primarily Simplified Chinese regardless of this language setting. Existing system/style wording, asset names, model names and technical terms may retain English. Visual style prefixes are injected by the system; do not duplicate them.',
  ].join('\n')
}
