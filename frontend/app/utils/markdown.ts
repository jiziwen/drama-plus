function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeHref(url: string): string | null {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed
  return null
}

function renderInline(raw: string): string {
  const codeTokens: string[] = []
  let text = raw.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = codeTokens.length
    codeTokens.push(`<code class="chat-inline-code">${escapeHtml(code)}</code>`)
    return `\u0000CODE${idx}\u0000`
  })

  text = escapeHtml(text)

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    const safe = sanitizeHref(url)
    if (!safe) return `${label} (${url})`
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`
  })

  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1<em>$2</em>')

  return text.replace(/\u0000CODE(\d+)\u0000/g, (_match, idx: string) => codeTokens[Number(idx)] ?? '')
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/u.test(line)
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

export function renderChatMarkdown(source: string): string {
  if (!source) return ''
  const normalized = source.replace(/\r\n?/g, '\n')
  const blocks: string[] = []
  const codeFenceRegex = /```([a-zA-Z0-9_+-]*)[ \t]*\n([\s\S]*?)(?:\n```|$)/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = codeFenceRegex.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      blocks.push(renderMarkdownSegment(normalized.slice(lastIndex, match.index)))
    }
    const lang = match[1]?.trim() || ''
    const code = match[2] ?? ''
    const langBadge = lang ? `<span class="chat-code-lang">${escapeHtml(lang)}</span>` : ''
    blocks.push(
      `<div class="chat-code-block">${langBadge ? `<div class="chat-code-head">${langBadge}</div>` : ''}<pre><code>${escapeHtml(code)}</code></pre></div>`,
    )
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < normalized.length) {
    blocks.push(renderMarkdownSegment(normalized.slice(lastIndex)))
  }

  return blocks.join('\n')
}

function renderMarkdownSegment(segment: string): string {
  const lines = segment.split('\n')
  const html: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i++
      continue
    }

    // Horizontal rule
    if (/^\s*(?:---+|===+|\*\*\*+)\s*$/.test(line)) {
      html.push('<hr />')
      i++
      continue
    }

    // Heading
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1]!.length
      html.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`)
      i++
      continue
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headers = splitTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitTableRow(lines[i]!))
        i++
      }
      const thead = `<thead><tr>${headers.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`
      const tbody = rows.length
        ? `<tbody>${rows.map(row => `<tr>${headers.map((_, col) => `<td>${renderInline(row[col] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>`
        : ''
      html.push(`<div class="chat-table-wrap"><table>${thead}${tbody}</table></div>`)
      continue
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${renderMarkdownSegment(quoteLines.join('\n'))}</blockquote>`)
      continue
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*[-*+]\s+/, ''))}</li>`)
        i++
      }
      html.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(`<li>${renderInline(lines[i]!.replace(/^\s*\d+\.\s+/, ''))}</li>`)
        i++
      }
      html.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Paragraph (collect consecutive plain lines)
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|(?:---+|===+|\*\*\*+)\s*$)/.test(lines[i]!) &&
      !(lines[i]!.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1]!))
    ) {
      paraLines.push(lines[i]!)
      i++
    }
    html.push(`<p>${paraLines.map(l => renderInline(l)).join('<br />')}</p>`)
  }

  return html.join('\n')
}
