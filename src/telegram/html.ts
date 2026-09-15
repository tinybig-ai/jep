// Converts bot output (assistant replies, /log) from markdown to Telegram's
// HTML parse mode. Everything from the model is escaped first, so malformed
// input degrades to plain text instead of a 400. Tables have no native
// Telegram representation, so they're rendered as padded <pre> blocks.
// Tags never span markdown line boundaries (slice-safe for streaming).
export {}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// Operates on already-escaped text (returns escaped text). Held to that
// contract so callers never double-escape.
function toMarkup(t: string): string {
  t = t.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`)
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
  t = t.replace(/__([^_\n]+)__/g, "<u>$1</u>")
  t = t.replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
  return t
}

function inline(line: string): string {
  let t = esc(line)
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${esc(url)}">${label}</a>`)
  t = toMarkup(t)
  t = t.replace(/(^|[\s(])(\*|_)([^*_\n]+)\2(?=[.,;:!?)]\s*|\s|$)/g, "$1<i>$3</i>")
  return t
}

export function isRow(line: string): boolean {
  const t = line.trim()
  return t.includes("|") && !isSep(line)
}

export function isSep(line: string): boolean {
  const t = line.trim().replace(/[|+]/g, "")
  return t.trim().length > 0 && /^[\s:.-]+$/.test(t) && /-{3}/.test(t)
}

export function parseRow(line: string): string[] {
  let t = line.trim()
  if (t.startsWith("|")) t = t.slice(1)
  if (t.endsWith("|")) t = t.slice(0, -1)
  return t.split("|").map((s) => s.trim())
}

export interface ParsedTable {
  rows: string[][]
  // a prose sentence LLMs sometimes jam into the first header cell
  // ("| Here's the sizes: | File | Size |") — rendered above the table
  intro?: string
}

// normalize a table's raw lines: drop separator rows (incl. single-dash
// |-|-|-| style), never drop the header, split a sentence-y first header cell
// out as intro, and trim trailing empty cells (leftovers of a jammed header).
export function parseTable(parsedLines: string[]): ParsedTable | null {
  const cells = parsedLines.map(parseRow).filter((r) => r.length > 1 || r[0] !== "")
  const body = cells.filter((r, ri) => ri === 0 || !(r.length >= 2 && r.every((c) => /^:?-{1,}$/.test(c))))
  if (body.length === 0) return null
  let head = body[0]!
  let intro: string | undefined
  if (head.length > 1 && head[0]!.trim()) {
    const first = head[0]!.trim()
    if (/\s/.test(first) && (/([.:!?;])$/.test(first) || first.length > 24)) {
      intro = first
      head = head.slice(1)
    }
  }
  const rows = [head, ...body.slice(1)].map((r) => {
    const rr = [...r]
    while (rr.length > 0 && !rr[rr.length - 1]!.trim()) rr.pop()
    return rr
  })
  return { rows, intro }
}

function renderTable(rows: string[]): string {
  const parsed = parseTable(rows)
  if (!parsed || parsed.rows.length === 0) return ""
  const cols = Math.max(...parsed.rows.map((r) => r.length))
  const marked = parsed.rows.map((r) => Array.from({ length: cols }, (_, ci) => toMarkup(esc(r[ci] ?? ""))))
  const widths = Array.from({ length: cols }, (_, ci) => {
    return Math.max(...marked.map((r) => r[ci]!.length))
  })
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length))
  const border = (start: string, mid: string, end: string) =>
    `${start}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${end}`
  const line = (row: string[]) => `│ ${row.map((c, ci) => pad(c, widths[ci]!)).join(" │ ")} │`
  const out: string[] = [border("┌", "┬", "┐")]
  if (parsed.rows.length > 0) out.push(line(marked[0]!))
  if (parsed.rows.length > 1) out.push(border("├", "┼", "┤"))
  for (const row of marked.slice(1)) out.push(line(row))
  if (parsed.rows.length > 0) out.push(border("└", "┴", "┘"))
  return `<pre>${out.join("\n")}</pre>`
}

export function mdToHtml(src: string): string {
  const lines = src.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed) {
      out.push("")
      i++
      continue
    }

    const fence = trimmed.match(/^```([\w-]*)/)
    if (fence) {
      const lang = /^[A-Za-z0-9_-]+$/.test(fence[1]!) ? fence[1] : ""
      i++
      const buf: string[] = []
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        buf.push(lines[i]!)
        i++
      }
      i++ // closing fence
      const code = buf.map(esc).join("\n")
      out.push(lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`)
      continue
    }

    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      let j = i
      while (j < lines.length && (isRow(lines[j]!) || (j > i && isSep(lines[j]!)))) j++
      const parsed = parseTable(lines.slice(i, j))
      if (parsed?.intro) out.push(inline(parsed.intro))
      out.push(renderTable(lines.slice(i, j)))
      i = j
      continue
    }

    const heading = trimmed.match(/^#{1,4}\s+(.+)$/)
    if (heading) {
      out.push(`<b>${inline(heading[1]!)}</b>`)
      i++
      continue
    }

    if (trimmed.startsWith(">")) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quote.push(lines[i]!.trim().replace(/^\s*> ?/, ""))
        i++
      }
      out.push(`<blockquote>${inline(quote.join("\n"))}</blockquote>`)
      continue
    }

    const checkbox = trimmed.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (checkbox) {
      const mark = checkbox[1]!.toLowerCase() === "x" ? "☑" : "☐"
      out.push(`${mark} ${inline(checkbox[2]!)}`)
      i++
      continue
    }

    const bullet = trimmed.match(/^\s*([-*+])\s+(.+)$/)
    if (bullet) {
      out.push(`• ${inline(bullet[2]!)}`)
      i++
      continue
    }

    out.push(inline(line))
    i++
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}