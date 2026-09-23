// telegram/rich.ts — markdown → Rich Message blocks. The streaming-table
// invariant at the bottom is the subtle one: a table arrives header-first, and
// until its separator row lands it renders as literal "| a | b |" text.

import { test } from "node:test"
import assert from "node:assert/strict"
import { closeStreamingTable, mdTable, mdToRich, richTextFromBlocks } from "../src/clients/telegram/rich.ts"
import type { RichBlock } from "../src/clients/telegram/rich.ts"

const types = (blocks: RichBlock[]): (string | undefined)[] => blocks.map((b) => b.type)

test("a paragraph is a paragraph", () => {
  const b = mdToRich("just text")
  assert.deepEqual(types(b), ["paragraph"])
  assert.equal(b[0]!.text, "just text")
})

test("a blank line splits paragraphs, and they stay separate blocks", () => {
  const b = mdToRich("one\n\ntwo\n\nthree")
  assert.deepEqual(types(b), ["paragraph", "paragraph", "paragraph"])
  assert.deepEqual(
    b.map((x) => x.text),
    ["one", "two", "three"],
  )
})

test("a soft line break stays inside one paragraph", () => {
  const b = mdToRich("one\ntwo")
  assert.deepEqual(types(b), ["paragraph"])
  assert.equal(b[0]!.text, "one\ntwo")
})

test("headings keep their level", () => {
  assert.deepEqual(mdToRich("# one")[0], { type: "heading", size: 1, text: "one" })
  assert.deepEqual(mdToRich("### three")[0], { type: "heading", size: 3, text: "three" })
})

test("a fence becomes a pre block, with its language when it has one", () => {
  assert.deepEqual(mdToRich("```ts\nconst a = 1\n```")[0], { type: "pre", text: "const a = 1", language: "ts" })
  assert.deepEqual(mdToRich("```\nplain\n```")[0], { type: "pre", text: "plain" })
})

test("a fence swallows markdown-looking lines inside it", () => {
  const b = mdToRich("```\n# not a heading\n- not a list\n```")
  assert.deepEqual(types(b), ["pre"])
  assert.match(b[0]!.text as string, /# not a heading/)
})

test("a horizontal rule is a divider", () => {
  assert.deepEqual(types(mdToRich("---")), ["divider"])
  assert.deepEqual(types(mdToRich("***")), ["divider"])
})

test("inline markup becomes typed parts", () => {
  const parts = mdToRich("a **b** and `c` and ~~d~~ and [e](https://x.y)")[0]!.text
  assert.ok(Array.isArray(parts))
  const kinds = (parts as Array<{ type?: string }>).filter((p) => typeof p === "object").map((p) => p.type)
  assert.deepEqual(kinds, ["bold", "code", "strikethrough", "url"])
})

test("a link carries its url", () => {
  const parts = mdToRich("[label](https://example.com/x)")[0]!.text as Array<{ type: string; url?: string }>
  assert.equal(parts[0]!.type, "url")
  assert.equal(parts[0]!.url, "https://example.com/x")
})

test("a bullet list becomes one list block of items", () => {
  const b = mdToRich("- one\n- two")
  assert.deepEqual(types(b), ["list"])
  assert.equal(b[0]!.items!.length, 2)
  // a bullet item is a bare container: no type of its own
  assert.equal(b[0]!.items![0]!.type, undefined)
})

test("an ordered list keeps its numbering", () => {
  const items = mdToRich("3. three\n4. four")[0]!.items!
  assert.equal(items[0]!.type, "1")
  assert.equal(items[0]!.value, 3)
})

test("checkboxes carry their state", () => {
  const items = mdToRich("- [x] done\n- [ ] todo")[0]!.items!
  assert.deepEqual(
    items.map((i) => [i.has_checkbox, i.is_checked]),
    [
      [true, true],
      [true, false],
    ],
  )
})

test("a quote nests its own blocks", () => {
  const b = mdToRich("> quoted **text**")
  assert.equal(b[0]!.type, "blockquote")
  assert.equal(b[0]!.blocks![0]!.type, "paragraph")
})

test("a table becomes a native table with a header row", () => {
  const b = mdToRich("| File | + |\n|---|---|\n| a.ts | 12 |")
  assert.deepEqual(types(b), ["table"])
  const cells = b[0]!.cells!
  assert.equal(cells[0]![0]!.is_header, true)
  assert.equal(cells[1]![0]!.is_header, false)
  assert.equal(cells[1]![1]!.text, "12")
  assert.equal(b[0]!.is_compact, true)
})

test("an empty cell carries no text at all", () => {
  const cells = mdToRich("| a | b |\n|---|---|\n| x |  |")[0]!.cells!
  assert.equal(cells[1]![1]!.text, undefined, "undefined renders as blank; \"\" would be a value")
})

test("a table wider than the API allows is dropped rather than sent", () => {
  const wide = Array.from({ length: 25 }, (_, i) => `c${i}`)
  const src = `| ${wide.join(" | ")} |\n|${wide.map(() => "---").join("|")}|\n| ${wide.map(() => "x").join(" | ")} |`
  assert.equal(mdToRich(src).length, 0, "the caller falls back to the text render")
})

test("a table's intro sentence is lifted out as a paragraph", () => {
  const b = mdToRich("| Sizes are as follows: | File | Size |\n|---|---|---|\n| | a.ts | 1 |")
  assert.deepEqual(types(b), ["paragraph", "table"])
  assert.equal(b[0]!.text, "Sizes are as follows:")
})

test("mixed content keeps its order", () => {
  const b = mdToRich("# Title\n\ntext\n\n- a\n\n```\ncode\n```\n\n> q")
  assert.deepEqual(types(b), ["heading", "paragraph", "list", "pre", "blockquote"])
})

// ─── mdTable, the inverse ───

test("mdTable builds a table markdown round-trips back through", () => {
  const src = mdTable(["File", "+"], [["a.ts", "12"]])
  const b = mdToRich(src)
  assert.deepEqual(types(b), ["table"])
  assert.equal(b[0]!.cells![1]![0]!.text, "a.ts")
})

test("mdTable swaps a pipe inside a cell, which would otherwise split it", () => {
  const src = mdTable(["A"], [["one | two"]])
  const b = mdToRich(src)
  assert.equal(b[0]!.cells![1]!.length, 1, "still one column")
  assert.equal(b[0]!.cells![1]![0]!.text, "one ¦ two")
})

// ─── the streaming-table invariant ───

test("a header plus the start of a second line commits to a table", () => {
  // "| a | b |\n|" — enough to know a separator is coming
  const closed = closeStreamingTable("| a | b |\n|")
  assert.match(closed, /\|---\|---\|/)
  assert.deepEqual(types(mdToRich(closed)), ["table"])
})

test("a header alone is left as text — a stray pipe is not a table", () => {
  assert.equal(closeStreamingTable("| a | b |"), "| a | b |")
  assert.equal(closeStreamingTable("prices | costs\n"), "prices | costs\n")
})

test("a second line that turned out to be prose is left alone", () => {
  const src = "| a | b |\nactually just text"
  assert.equal(closeStreamingTable(src), src)
})

test("a complete separator needs no help", () => {
  const src = "| a | b |\n|---|---|"
  assert.equal(closeStreamingTable(src), src)
})

test("a table already under way is left to the real parser", () => {
  const src = "| a | b |\n|---|---|\n| 1 | 2 |\n|"
  assert.equal(closeStreamingTable(src), src)
})

test("a one-column header is not enough to call it a table", () => {
  const src = "| a |\n|"
  assert.equal(closeStreamingTable(src), src)
})

test("every prefix of a streaming table renders without throwing", () => {
  const full = "text before\n\n| File | + |\n|---|---|\n| a.ts | 12 |\n| b.ts | 3 |\n\nafter"
  for (let i = 1; i <= full.length; i++) {
    const slice = full.slice(0, i)
    assert.doesNotThrow(() => mdToRich(closeStreamingTable(slice)), `failed at prefix ${i}`)
  }
})

test("richTextFromBlocks lifts the words out of the blocks the bot sent", () => {
  const blocks: RichBlock[] = [
    { type: "heading", size: 1, text: "the rich answer" },
    { type: "paragraph", text: [{ type: "bold", text: "fixed" }, { type: "code", text: "pack.ts" }, " now"] },
  ]
  assert.equal(richTextFromBlocks(blocks), "the rich answer\nfixedpack.ts now")
})

test("richTextFromBlocks walks details, tables and list items", () => {
  const blocks: RichBlock[] = [
    { type: "details", summary: "why", is_open: false, blocks: [{ type: "paragraph", text: "the why" }] },
    { type: "table", cells: [[{ text: "file" }, { text: "+" }], [{ text: "a.ts" }, { text: "12" }]] },
    { type: "bulleted_list", items: [{ blocks: [{ type: "paragraph", text: "one" }] }, { blocks: [{ type: "paragraph", text: "two" }] }] },
  ]
  const out = richTextFromBlocks(blocks)
  assert.match(out, /why/)
  assert.match(out, /the why/)
  assert.match(out, /file \| \+/)
  assert.match(out, /a\.ts \| 12/)
  assert.match(out, /one\ntwo/)
})

test("richTextFromBlocks skips chrome — buttons, attachments, empty blocks", () => {
  const blocks: RichBlock[] = [
    { type: "buttons", buttons: [{ text: "tap" }] },
    { type: "divider" },
    { type: "photo", photo: { type: "photo", media: "attach://x.png" } },
    { type: "paragraph", text: "real content" },
  ]
  assert.equal(richTextFromBlocks(blocks), "real content")
})
