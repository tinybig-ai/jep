// Converts bot output (assistant replies, /log) from markdown to Telegram's
// HTML parse mode. Everything from the model is escaped first, so malformed
// input degrades to plain text instead of a 400. Tables have no native
// Telegram representation, so they're rendered as padded <pre> blocks.
// Tags never span markdown line boundaries (slice-safe for streaming).
export {}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// A code span is literal: `__init__.py` is a filename, not an underline, and
// `a ** b ** c` is not a bold run. So markup is only ever applied to the
// stretches *between* spans — this maps `f` over those and leaves the spans
// themselves alone. Operates on already-escaped text, and returns escaped
// text, so callers never double-escape.
function outsideCode(t: string, f: (s: string) => string): string {
  const out: string[] = []
  let last = 0
  for (const m of t.matchAll(/`([^`\n]+)`/g)) {
    out.push(f(t.slice(last, m.index)))
    out.push(`<code>${m[1]}</code>`)
    last = m.index + m[0].length
  }
  out.push(f(t.slice(last)))
  return out.join("")
}

const emphasis = (t: string): string =>
  t
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")

// Operates on already-escaped text (returns escaped text). Held to that
// contract so callers never double-escape.
function toMarkup(t: string): string {
  return outsideCode(t, emphasis)
}

function inline(line: string): string {
  // the url is taken from text that has already been escaped, so escaping it
  // again here turned a single "&" into "&amp;amp;" in the href
  const withLinks = (t: string): string =>
    emphasis(t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}">${label}</a>`))
      .replace(/(^|[\s(])(\*|_)([^*_\n]+)\2(?=[.,;:!?)]\s*|\s|$)/g, "$1<i>$3</i>")
  return outsideCode(esc(line), withLinks)
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
  // A separator row is dropped wherever it appears — agents emit extra ones
  // mid-table in ASCII-art style. The column count is part of the test because
  // a lone "---" cell in a wide table is more likely to be content than a
  // separator; at row 1, the only place GFM puts one, it is a separator even
  // when the table has a single column. (Alignment colons on either side.)
  const isSepRow = (r: string[]) => r.every((c) => /^:?-{1,}:?$/.test(c))
  const body = cells.filter((r, ri) => ri === 0 || !(isSepRow(r) && (r.length >= 2 || ri === 1)))
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

// usable width of a Telegram `<pre>` block before mobile clients soft-wrap it,
// which mangles the box-drawing borders; long cells wrap onto extra lines
// within the row instead of blowing out the table width.
const TABLE_WIDTH = 36

// Columns of text the reader sees: tags contribute nothing, and each of the
// three entities we emit is one character on screen.
const visibleLen = (html: string): number => [...html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt);/g, "x")].length

function wrapCell(raw: string, width: number): string[] {
  const words = raw.split(/\s+/).filter(Boolean)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let cur = ""
  for (const word of words) {
    if (!cur) cur = word
    else if (cur.length + 1 + word.length <= width) cur += " " + word
    else {
      lines.push(cur)
      cur = word
    }
    while (cur.length > width) {
      lines.push(cur.slice(0, width))
      cur = cur.slice(width)
    }
  }
  if (cur) lines.push(cur)
  return lines
}

function renderTable(rows: string[]): string {
  const parsed = parseTable(rows)
  if (!parsed || parsed.rows.length === 0) return ""
  const cols = Math.max(...parsed.rows.map((r) => r.length))
  const raw = parsed.rows.map((r) => Array.from({ length: cols }, (_, ci) => (r[ci] ?? "").trim()))
  const naturalWidths = Array.from({ length: cols }, (_, ci) => Math.max(...raw.map((r) => r[ci]!.length)))
  const overhead = 3 * cols + 1
  const budget = Math.max(TABLE_WIDTH - overhead, cols * 3)
  const naturalTotal = naturalWidths.reduce((a, b) => a + b, 0)
  // shrink toward budget by taking width from the widest column(s) first, so
  // short columns (ids, names) keep their natural width and only the verbose
  // column(s) wrap.
  const MIN_COL = 8
  const floors = naturalWidths.map((w) => Math.min(MIN_COL, w))
  const targets = [...naturalWidths]
  let over = naturalTotal - budget
  while (over > 0) {
    let maxIdx = -1
    for (let i = 0; i < targets.length; i++) {
      if (targets[i]! > floors[i]! && (maxIdx === -1 || targets[i]! > targets[maxIdx]!)) maxIdx = i
    }
    if (maxIdx === -1) break
    targets[maxIdx]!--
    over--
  }
  if (over > 0) {
    // even at floors it's too wide (many columns) — scale everything down
    const floorTotal = floors.reduce((a, b) => a + b, 0) || 1
    for (let i = 0; i < targets.length; i++) targets[i] = Math.max(3, Math.floor((floors[i]! / floorTotal) * budget))
  }
  // Columns are measured on what the *reader* sees, not on what goes on the
  // wire: "&" is one column but five characters once escaped, `x` is one but
  // fifteen once it is a <code> tag, and the backticks that made it one vanish
  // entirely. Measuring the marked-up string padded every such row short and
  // bent the right-hand border.
  const wrapped = raw.map((r) => r.map((c, ci) => wrapCell(c, targets[ci]!).map((line) => toMarkup(esc(line)))))
  const widths = Array.from({ length: cols }, (_, ci) =>
    Math.max(...wrapped.map((r) => Math.max(...r[ci]!.map(visibleLen)))),
  )
  const border = (start: string, mid: string, end: string) =>
    `${start}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${end}`
  const rowLines = (row: string[][]) => {
    const height = Math.max(...row.map((c) => c.length))
    const out: string[] = []
    for (let li = 0; li < height; li++) {
      const cells = row.map((c, ci) => {
        const cell = c[li] ?? ""
        return cell + " ".repeat(Math.max(0, widths[ci]! - visibleLen(cell)))
      })
      out.push(`│ ${cells.join(" │ ")} │`)
    }
    return out
  }
  const out: string[] = [border("┌", "┬", "┐")]
  out.push(...rowLines(wrapped[0]!))
  if (parsed.rows.length > 1) out.push(border("├", "┼", "┤"))
  for (const row of wrapped.slice(1)) out.push(...rowLines(row))
  out.push(border("└", "┴", "┘"))
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