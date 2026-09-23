// telegram/minimal.ts — the minimal-layout segmentation. The deadline: a
// "minimal" turn used to flatten into [all icons][all text], which hid the
// turn's chronology. Now verbosity accumulate in a segment, and the text that
// finalizes it ships as its own message; the next verbosity start a fresh
// segment. This test sticks to the pure split blocks.

import { test } from "node:test"
import assert from "node:assert/strict"
import { splitMinimalSegments, minimalSegmentBlocks, thinkingPhrase } from "../src/clients/telegram/minimal.ts"
import type { Part, TextPart } from "../src/core/types.ts"
import type { RichBlock } from "../src/clients/telegram/rich.ts"

const text = (s: string, id?: string): TextPart => ({ kind: "text", text: s, ...(id ? { id } : {}) })
const reasoning = (s: string, durationMs?: number): Part => ({ kind: "reasoning", text: s, ...(durationMs !== undefined ? { durationMs } : {}) })
const tool = (name: string, status = "completed"): Part => ({ kind: "tool", id: name, name, input: {}, output: {}, status: status as "completed", title: name })

const blocks = (seg: ReturnType<typeof splitMinimalSegments>[number], over?: Partial<{ thinking: boolean; tools: boolean }>) => {
  const r = { thinking: true, tools: true, ms: (p: { durationMs?: number }) => p.durationMs, icon: (t: { name: string }) => `⚙ ${t.name}`, ...over }
  return minimalSegmentBlocks(seg, { thinking: r.thinking, tools: r.tools, ms: r.ms, icon: r.icon })
}
const texts = (seg: ReturnType<typeof splitMinimalSegments>[number]) => seg.text.map((p) => p.text).join("")

test("pure text is one segment carrying no icons", () => {
  const segs = splitMinimalSegments([text("hello"), text(" world")])
  assert.equal(segs.length, 1)
  assert.deepEqual(segs[0]!.icons, [])
  assert.equal(texts(segs[0]!), "hello world")
})

test("verbosity before text ride the same segment", () => {
  const segs = splitMinimalSegments([reasoning("hmm"), tool("read"), text("found it"), text("!")])
  assert.equal(segs.length, 1)
  assert.equal(segs[0]!.icons.length, 2)
  assert.equal(texts(segs[0]!), "found it!")
})

test("non-text after text opens the next segment", () => {
  const segs = splitMinimalSegments([text("step one"), tool("write"), text("step two")])
  assert.equal(segs.length, 2)
  assert.equal(texts(segs[0]!), "step one")
  assert.equal(segs[0]!.icons.length, 0)
  assert.equal(texts(segs[1]!), "step two")
  assert.equal(segs[1]!.icons.length, 1)
})

test("icons between two texts join the later segment", () => {
  const segs = splitMinimalSegments([text("a"), tool("run"), reasoning("thinking out loud"), text("b")])
  assert.equal(segs.length, 2)
  assert.equal(segs[0]!.icons.length, 0)
  assert.equal(segs[1]!.icons.length, 2)
  assert.equal(texts(segs[1]!), "b")
})

test("a trailing tool still counts as its own last segment", () => {
  const segs = splitMinimalSegments([text("almost done"), tool("bash")])
  assert.equal(segs.length, 2)
  assert.equal(texts(segs[1]!), "")
  assert.equal(segs[1]!.icons.length, 1)
})

test("markers are icons, not text", () => {
  const segs = splitMinimalSegments([text("x"), { kind: "other", nativeType: "step-finish" }, text("y")])
  assert.equal(segs[1]!.icons[0]!.kind, "other")
  assert.equal(texts(segs[1]!), "y")
})

test("snapshots are icons, not text", () => {
  const segs = splitMinimalSegments([text("x"), { kind: "snapshot" }, text("y")])
  assert.equal(segs[1]!.icons[0]!.kind, "snapshot")
  assert.equal(texts(segs[1]!), "y")
})

test("empty icon line is omitted, text stays", () => {
  const seg = splitMinimalSegments([{ kind: "snapshot" }, text("plain answer")])[0]!
  const b = blocks(seg)
  assert.deepEqual(b.map((x) => x.type), ["paragraph"])
})

test("icon line carries thinking and tool, with fresh-vs-frozen thinking", () => {
  const seg = splitMinimalSegments([reasoning("long thought", 2500), tool("read"), text("answer")])[0]!
  const b = blocks(seg)
  assert.equal(b[0]!.type, "paragraph")
  assert.match(b[0]!.text as string, /💭 thought for 3s/)
  assert.match(b[0]!.text as string, /⚙ read/)
})

test("thinking or tools can be hidden, each independently", () => {
  const seg = splitMinimalSegments([reasoning("secret"), tool("bash"), text("out")])[0]!
  assert.match(blocks(seg, { thinking: false })[0]!.text as string, /⚙ bash/)
  assert.doesNotMatch(blocks(seg, { thinking: false })[0]!.text as string, /💭/)
  assert.match(blocks(seg, { tools: false })[0]!.text as string, /💭/)
  assert.doesNotMatch(blocks(seg, { tools: false })[0]!.text as string, /⚙/)
})

test("a marker-only icon line renders nothing", () => {
  const seg = splitMinimalSegments([{ kind: "snapshot" }, text("hi")])[0]!
  assert.deepEqual(blocks(seg).map((x) => x.type), ["paragraph"])
})

test("multiple text parts render as their own paragraphs", () => {
  const seg = splitMinimalSegments([text("one"), text(" two")])[0]!
  const b = blocks(seg)
  assert.deepEqual(b.map((x) => x.type), ["paragraph", "paragraph"])
  assert.equal(b[0]!.text, "one")
  assert.equal(b[1]!.text, "two")
})

test("blocks render empty only when there is no text at all", () => {
  const seg = splitMinimalSegments([tool("idle")])[0]!
  const b = blocks(seg)
  assert.ok(b.length >= 1, "icon line alone still renders")
})

test("thinkingPhrase reports known and unknown durations", () => {
  assert.equal(thinkingPhrase(), "Thinking")
  assert.equal(thinkingPhrase(1200), "Thought for 1s")
  assert.equal(thinkingPhrase(100), "Thought for 1s", "sub-second rounds up to 1s")
})

test("text id is preserved for segment matching", () => {
  const segs = splitMinimalSegments([text("a", "prt_1"), text("b", "prt_2")])
  assert.equal(segs[0]!.text[0]!.id, "prt_1")
  assert.equal(segs[0]!.text[1]!.id, "prt_2")
})