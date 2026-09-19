// Builds Telegram Rich Message content (sendRichMessage) for assistant replies.
// Block shapes follow the Bot API: paragraphs, headings (size 1=largest),
// preformatted code, dividers, lists (bullets/ordered/checkboxes), block
// quotations and native tables. RichText parts cover bold/italic/underline/
// code/strikethrough and tappable links. The caller falls back to the HTML
// render whenever a rich message can't be sent.
export {}
import { isRow, isSep, parseRow, parseTable } from "./html.ts"

// builds a GFM table from headers + rows — the inverse of parseTable/
// mdToRich, for callers that have structured data and want it rendered as a
// native table (falls back to plain text same as any other markdown, since
// it's just markdown source). A stray "|" in a cell is swapped for a
// lookalike character: the parser below has no escape syntax, so a literal
// pipe would otherwise corrupt the column count.
export function mdTable(headers: string[], rows: string[][]): string {
  const cell = (s: string) => s.replace(/\|/g, "¦")
  const line = (cells: string[]) => `| ${cells.map(cell).join(" | ")} |`
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n")
}

// While a table is still streaming, the header row alone renders as raw
// "| a | b |" text until the GFM separator row ("|---|---|") lands. Once the
// header is followed by the *start* of a second line — not just the header
// alone, which could be any stray pipe in prose — that's decisive enough to
// commit to a table, so synthesize the separator early and let mdToRich grow
// the table shell row by row as real content streams in behind it.
export function closeStreamingTable(text: string): string {
  const lines = text.split("\n")
  const last = lines.length - 1
  if (last < 1) return text
  const headerIdx = last - 1
  const header = lines[headerIdx]!
  const trimmedHeader = header.trim()
  if (!isRow(header) || isSep(header)) return text
  if (!trimmedHeader.startsWith("|") && !trimmedHeader.endsWith("|")) return text
  // bail if the header is itself mid-table already (a prior row/sep line
  // precedes it) — the real detector already handles that case on its own
  if (headerIdx > 0 && (isRow(lines[headerIdx - 1]!) || isSep(lines[headerIdx - 1]!))) return text
  const next = lines[last]!
  if (next.length === 0) return text // second line hasn't started yet — wait for it
  if (isSep(next)) return text // real separator already complete, nothing to do
  if (/[^\s|:.-]/.test(next)) return text // diverged into real content, not a separator
  const cells = parseRow(header)
  if (cells.length < 2) return text
  const out = lines.slice(0, last)
  out.push("|" + cells.map(() => "---").join("|") + "|")
  return out.join("\n")
}

export type RichText = string | RichTextPart[]
export type RichTextPart = string | { type: string; text?: RichText; url?: string }

export interface RichTableCell {
  text?: RichText
  is_header?: boolean
}

export interface RichBlock {
  /** absent on a list item, which is a bare container of blocks */
  type?: string
  text?: RichText
  cells?: RichTableCell[][]
  is_bordered?: boolean
  is_striped?: boolean
  is_compact?: boolean
  size?: number
  language?: string
  items?: RichBlock[]
  blocks?: RichBlock[]
  has_checkbox?: boolean
  is_checked?: boolean
  value?: number
  /** RichBlockButtons (10.3): a row of buttons inside the message */
  buttons?: Array<Record<string, unknown>>
  align?: "left" | "center" | "right"
  /** credit line for block quotations */
  credit?: RichText
  /** details block header (InputRichBlockDetails, 10.3) */
  summary?: RichText
  /** details block starts expanded */
  is_open?: boolean
  /** RichBlockPhoto / RichBlockDocument: an attach:// reference to an uploaded file */
  photo?: { type: string; media: string }
  document?: { type: string; media: string }
}

// Plain text back out of a sent rich message — the inverse of mdToRich.
// Rich messages carry no `text` field on the wire, so a quoted reply to one
// cannot reuse the message's own words: they have to be lifted out of the
// blocks. Text lives in paragraph/pre/heading bodies, details summaries,
// table cells and list items; buttons, attachments and bare dividers are
// chrome, not content.
export function richTextFromBlocks(blocks: RichBlock[]): string {
  const lines: string[] = []
  const walk = (b: RichBlock): void => {
    if (b.summary) lines.push(richText(b.summary))
    if (b.text) lines.push(richText(b.text))
    if (b.credit) lines.push(richText(b.credit))
    if (b.cells) for (const row of b.cells) lines.push(row.map((c) => richText(c.text)).join(" | "))
    if (b.blocks) for (const sub of b.blocks) walk(sub)
    if (b.items) for (const item of b.items) for (const sub of item.blocks ?? []) walk(sub)
  }
  for (const b of blocks) walk(b)
  return lines.filter((l) => l.trim()).join("\n")
}

function richText(t: RichText | undefined): string {
  if (t == null) return ""
  if (typeof t === "string") return t
  return t.map((p) => (typeof p === "string" ? p : richText(p.text) || p.url || "")).join("")
}

const INLINE_RE =
  /(\*\*([^*\n]*)\*\*|__([^_\n]*)__|\*([^*\n]*)\*|_([^_\n]*)_|`([^`\n]*)`|~~([^~\n]*)~~|\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\))/g

function inlineRich(s: string): RichText {
  const out: RichTextPart[] = []
  let last = 0
  let hit = false
  for (const m of s.matchAll(INLINE_RE)) {
    hit = true
    if (m.index! > last) out.push(s.slice(last, m.index!))
    const whole = m[0]
    const table = [
      { kind: "bold" as const, raw: m[2] },
      { kind: "underline" as const, raw: m[3] },
      { kind: "italic" as const, raw: m[4] },
      { kind: "italic" as const, raw: m[5] },
      { kind: "code" as const, raw: m[6] },
      { kind: "strikethrough" as const, raw: m[7] },
    ].find((t) => t.raw !== undefined)
    if (m[8] !== undefined && m[9] !== undefined) {
      out.push({ type: "url", text: inlineRich(m[8]), url: m[9] })
    } else if (table) {
      out.push({ type: table.kind, text: inlineRich(table.raw!) })
    } else {
      out.push(s.slice(m.index!, m.index! + whole.length))
    }
    last = m.index! + whole.length
  }
  if (!hit) return s
  if (last < s.length) out.push(s.slice(last))
  return out
}

function tableBlock(rows: string[]): { block: RichBlock; intro?: string } | null {
  const parsed = parseTable(rows)
  if (!parsed || parsed.rows.length === 0) return null
  const cols = Math.max(...parsed.rows.map((r) => r.length))
  if (cols > 20) return null // API limit; caller falls back to the text render
  const grid: RichTableCell[][] = parsed.rows.map((row, ri) =>
    Array.from({ length: cols }, (_, ci) => {
      const v = (row[ci] ?? "").trim()
      return { text: v === "" ? undefined : inlineRich(v), is_header: ri === 0 }
    }),
  )
  return { block: { type: "table", cells: grid, is_bordered: true, is_striped: true, is_compact: true }, intro: parsed.intro }
}

interface ListEntry {
  kind: "bullet" | "1" | "a" | "A" | "i" | "I"
  text: string
  value?: number
  checkbox?: boolean
}

function parseListItem(l: string): ListEntry | null {
  const s = l.trim()
  const cb = s.match(/^([-*+])\s+\[(x|X| )\]\s+(.*)$/)
  if (cb) return { kind: "bullet", text: cb[3]!, checkbox: cb[2] !== " " }
  const bullet = s.match(/^([-*+])\s+(.*)$/)
  if (bullet) return { kind: "bullet", text: bullet[2]! }
  const ord = s.match(/^(\d+)[.)]\s+(.*)$/)
  if (ord) return { kind: "1", value: parseInt(ord[1]!, 10), text: ord[2]! }
  const alpha = s.match(/^([aAiI])[.)]\s+(.*)$/)
  if (alpha) return { kind: alpha[1] as ListEntry["kind"], text: alpha[2]! }
  return null
}

function listItemBlock(ent: ListEntry): RichBlock {
  const item: RichBlock = { blocks: [{ type: "paragraph", text: inlineRich(ent.text) }] }
  if (ent.kind !== "bullet") {
    item.type = ent.kind
    if (ent.value !== undefined) item.value = ent.value
  }
  if (ent.checkbox !== undefined) {
    item.has_checkbox = true
    item.is_checked = ent.checkbox
  }
  return item
}

const FENCE_RE = /^```(\w+)?\s*$/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE_RE = /^>\s?(.*)$/

export function mdToRich(src: string): RichBlock[] {
  const lines = src.split("\n")
  const blocks: RichBlock[] = []
  let para: string[] = []
  const flushPara = () => {
    const joined = para.join("\n").trim()
    if (!joined) return
    blocks.push({ type: "paragraph", text: inlineRich(joined) })
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    const fence = line.match(FENCE_RE)
    if (fence) {
      const lang = (fence[1] ?? "").trim() || undefined
      const buf: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        buf.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      flushPara()
      blocks.push({ type: "pre", text: buf.join("\n"), ...(lang ? { language: lang } : {}) })
      continue
    }
    const heading = line.match(HEADING_RE)
    if (heading) {
      flushPara()
      blocks.push({ type: "heading", size: heading[1]!.length, text: inlineRich(heading[2]!) })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      flushPara()
      blocks.push({ type: "divider" })
      i++
      continue
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const cur = lines[i]!
        const q = cur.match(QUOTE_RE)
        if (q) {
          inner.push(q[1]!)
          i++
          continue
        }
        if (!cur.trim()) {
          inner.push("")
          i++
          continue
        }
        break
      }
      flushPara()
      const nested = mdToRich(inner.join("\n"))
      blocks.push(nested.length ? { type: "blockquote", blocks: nested } : { type: "blockquote", blocks: [] })
      continue
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      let j = i
      while (j < lines.length && (isRow(lines[j]!) || (j > i && isSep(lines[j]!)))) j++
      const block = tableBlock(lines.slice(i, j))
      if (block) flushPara()
      if (block) {
        if (block.intro) blocks.push({ type: "paragraph", text: inlineRich(block.intro) })
        blocks.push(block.block)
      }
      i = j
      continue
    }
    if (parseListItem(line)) {
      const items: RichBlock[] = []
      while (i < lines.length) {
        const cur = lines[i]!
        const ent = parseListItem(cur)
        if (ent) {
          items.push(listItemBlock(ent))
          i++
          continue
        }
        if (!cur.trim()) {
          let k = i
          while (k < lines.length && !lines[k]!.trim()) k++
          if (k < lines.length && parseListItem(lines[k]!)) {
            i++
            continue
          }
        }
        break
      }
      flushPara()
      blocks.push({ type: "list", items })
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return blocks
}