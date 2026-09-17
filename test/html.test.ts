// telegram/html.ts — markdown → Telegram HTML. The two properties that matter
// here are the ones PHILOSOPHY §5 calls load-bearing: everything is escaped
// before any markup is added, and no inline tag ever spans a line, because the
// streaming placeholder slices this output mid-turn.

import { test } from "node:test"
import assert from "node:assert/strict"
import { isRow, isSep, mdToHtml, parseRow, parseTable } from "../src/telegram/html.ts"

// every tag html.ts can emit inside a single line
const INLINE_TAGS = ["b", "i", "u", "s", "code", "a", "blockquote"]

/** no inline tag may open on one line and close on another (outside <pre>) */
function assertLineLocalTags(html: string): void {
  let inPre = false
  for (const line of html.split("\n")) {
    if (line.includes("<pre>")) inPre = true
    if (inPre) {
      if (line.includes("</pre>")) inPre = false
      continue
    }
    for (const tag of INLINE_TAGS) {
      const open = line.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"))?.length ?? 0
      const close = line.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0
      assert.equal(open, close, `<${tag}> is unbalanced on: ${line}`)
    }
  }
}

test("model output is escaped, so raw HTML can never reach the wire", () => {
  const out = mdToHtml('<script>alert("x")</script> & <b>not bold</b>')
  assert.doesNotMatch(out, /<script>/)
  assert.match(out, /&lt;script&gt;/)
  assert.match(out, /&amp;/)
  assert.doesNotMatch(out, /<b>not bold<\/b>/, "their tags are text, ours are markup")
})

test("escaping happens before markup, not after", () => {
  // if markup were applied first, the <b> we emit would itself get escaped
  const out = mdToHtml("**<hi>**")
  assert.equal(out, "<b>&lt;hi&gt;</b>")
})

test("inline markdown becomes inline tags", () => {
  assert.equal(mdToHtml("**bold**"), "<b>bold</b>")
  assert.equal(mdToHtml("__under__"), "<u>under</u>")
  assert.equal(mdToHtml("~~gone~~"), "<s>gone</s>")
  assert.equal(mdToHtml("`code`"), "<code>code</code>")
  assert.equal(mdToHtml("an *emphasis* here"), "an <i>emphasis</i> here")
})

test("a code span keeps its contents escaped and unstyled", () => {
  assert.equal(mdToHtml("`a < b && **c**`"), "<code>a &lt; b &amp;&amp; **c**</code>")
})

test("links carry an escaped href", () => {
  assert.equal(mdToHtml("[docs](https://example.com/a?x=1&y=2)"), '<a href="https://example.com/a?x=1&amp;y=2">docs</a>')
})

test("a fenced block keeps its language and escapes its body", () => {
  const out = mdToHtml("```ts\nconst a = 1 < 2\n```")
  assert.match(out, /<pre><code class="language-ts">/)
  assert.match(out, /1 &lt; 2/)
})

test("an unterminated fence still produces something safe", () => {
  const out = mdToHtml("```\n<b>half a block")
  assert.doesNotMatch(out, /<b>/)
  assert.match(out, /&lt;b&gt;/)
})

test("headings, bullets and checkboxes", () => {
  assert.equal(mdToHtml("## Title"), "<b>Title</b>")
  assert.equal(mdToHtml("- one"), "• one")
  assert.equal(mdToHtml("- [x] done"), "☑ done")
  assert.equal(mdToHtml("- [ ] todo"), "☐ todo")
})

test("a quote becomes one blockquote", () => {
  const out = mdToHtml("> first\n> second")
  assert.equal(out, "<blockquote>first\nsecond</blockquote>")
})

test("no inline tag spans a line, even in mixed content", () => {
  const src = [
    "# A heading",
    "",
    "Some **bold** and *italic* and `code` and [a link](https://example.com).",
    "- a **bullet**",
    "> a **quoted** line",
    "",
    "| File | + |",
    "|---|---|",
    "| src/a.ts | 12 |",
    "",
    "```js",
    "const x = '<b>'",
    "```",
    "trailing **text**",
  ].join("\n")
  assertLineLocalTags(mdToHtml(src))
})

test("every prefix of a stream renders without unbalanced tags", () => {
  // the streaming placeholder pushes the answer tail as it arrives; a slice
  // landing mid-token must still produce something sendable
  const src = "Here is **bold** and `code` and a [link](https://example.com) and *more*."
  for (let i = 1; i <= src.length; i++) assertLineLocalTags(mdToHtml(src.slice(0, i)))
})

test("a table renders as a box-drawn pre block", () => {
  const out = mdToHtml("| File | + |\n|---|---|\n| src/a.ts | 12 |")
  assert.match(out, /^<pre>/)
  assert.match(out, /┌|│|└/)
  assert.match(out, /src\/a\.ts/)
})

// ─── the table grammar the rich renderer shares ───

test("isRow and isSep tell a separator from a row", () => {
  assert.equal(isRow("| a | b |"), true)
  assert.equal(isRow("no pipes here"), false)
  assert.equal(isSep("|---|---|"), true)
  assert.equal(isSep("| :--- | ---: |"), true)
  assert.equal(isSep("| a | b |"), false)
  assert.equal(isRow("|---|---|"), false, "a separator is not a row")
})

test("parseRow drops the outer pipes and trims", () => {
  assert.deepEqual(parseRow("|  a |  b  |"), ["a", "b"])
  assert.deepEqual(parseRow("a | b"), ["a", "b"])
})

test("parseTable keeps the header and drops separators", () => {
  const t = parseTable(["| A | B |", "|---|---|", "| 1 | 2 |"])!
  assert.deepEqual(t.rows, [
    ["A", "B"],
    ["1", "2"],
  ])
  assert.equal(t.intro, undefined)
})

test("a sentence jammed into the first header cell becomes an intro", () => {
  const t = parseTable(["| Here are the sizes: | File | Size |", "|---|---|---|", "| | a.ts | 12 |"])!
  assert.equal(t.intro, "Here are the sizes:")
  assert.deepEqual(t.rows[0], ["File", "Size"])
})

test("trailing empty cells are trimmed", () => {
  const t = parseTable(["| A | B | |", "|---|---|---|", "| 1 | 2 | |"])!
  assert.deepEqual(t.rows[1], ["1", "2"])
})

test("a table lines up even when its cells contain markup or escapes", () => {
  // the box is only a box if every row is the same number of columns wide —
  // tags and entities are characters on the wire but not on the screen
  const out = mdToHtml(
    ["| name | n |", "|---|---|", "| `__x__` | 1 |", "| a & b | 2 |", "| **bold** | 3 |", "| plain | 4 |"].join("\n"),
  )
  const lines = out.replace(/<\/?pre>/g, "").split("\n")
  const seen = (l: string) => [...l.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt);/g, "x")].length
  const widths = new Set(lines.map(seen))
  assert.equal(widths.size, 1, `rows disagree on width: ${[...widths].join(", ")}`)
})
