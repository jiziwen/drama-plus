/** Line numbers remain aligned with the source, including fenced examples and prompts. */
export function markdownLines(markdown: string): string[] {
  let marker = '', size = 0
  return markdown.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).map(line => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (fence && fence[1][0] === marker && fence[1].length >= size && !fence[2].trim()) marker = ''
      return ''
    }
    if (fence) {
      marker = fence[1][0]
      size = fence[1].length
      return ''
    }
    return line
  })
}

export interface TableRow { line: number; cells: string[] }
export interface Table { line: number; headers: string[]; rows: TableRow[] }
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|').replace(/\*\*|`/g, '').trim())
}

export function parseTables(lines: string[]): Table[] {
  const tables: Table[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|') || !lines[i + 1].includes('|')) continue
    const headers = cells(lines[i]), separator = cells(lines[i + 1])
    if (headers.length !== separator.length || !separator.every(s => /^:?-{3,}:?$/.test(s))) continue
    const table: Table = { line: i + 1, headers, rows: [] }
    i += 2
    while (i < lines.length && lines[i].trim().startsWith('|')) {
      table.rows.push({line: i + 1, cells: cells(lines[i])})
      i++
    }
    tables.push(table)
    i--
  }
  return tables
}

export function normalize(text: string) { return text.replace(/[\s_/（）()·]/g, '').toUpperCase() }
export function column(table: Table, ...aliases: string[]): number {
  const normalized = aliases.map(normalize)
  return table.headers.findIndex(h => normalized.some(alias => normalize(h).includes(alias)))
}
export type Issue = { level: 'WARN' | 'ERROR'; code: string; message: string; line?: number }
