// telegram/search.ts — what matched, and what the row says about it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { matches, rankHits, snippet } from "../src/telegram/search.ts"
import type { Hit } from "../src/telegram/search.ts"

test("matching ignores case and surrounding space", () => {
  assert.equal(matches("The Draft IDs bug", "draft ids"), true)
  assert.equal(matches("the draft ids bug", "  DRAFT  "), true, "outer space is trimmed")
  assert.equal(matches("the draft ids bug", "draft  ids"), false, "inner space is literal")
  assert.equal(matches("nothing here", "draft"), false)
})

test("a snippet is centred on the hit, not taken from the start", () => {
  const long = `${"filler ".repeat(40)}the draft ids fix ${"tail ".repeat(40)}`
  const out = snippet(long, "draft ids", 60)
  assert.ok(out.includes("**draft ids**"), "the hit is marked")
  assert.ok(out.startsWith("…") && out.endsWith("…"), "and it is clearly a window")
  assert.ok(out.length <= 66, `too wide: ${out.length}`)
  assert.ok(!out.startsWith("…filler filler filler filler filler filler"), "not the opening sentence")
})

test("a snippet flattens the many lines of a transcript onto one", () => {
  const out = snippet("first line\n\n  second line with draft ids in it\n\nthird", "draft ids")
  assert.ok(!out.includes("\n"))
  assert.ok(out.includes("**draft ids**"))
})

test("a hit near the start keeps its left edge", () => {
  const out = snippet("draft ids were restarting at 1 on every boot", "draft ids", 40)
  assert.ok(out.startsWith("**draft ids**"), `got: ${out}`)
})

test("text with no hit still renders as a clipped line", () => {
  const out = snippet("x".repeat(200), "nothing", 50)
  assert.equal(out.length, 50)
  assert.ok(out.endsWith("…"))
})

const hit = (over: Partial<Hit>): Hit => ({
  sessionID: "s",
  ws: "w",
  title: "t",
  updatedAt: 0,
  where: "message",
  ...over,
})

test("a title match outranks a body match, then recency decides", () => {
  const ranked = rankHits([
    hit({ sessionID: "old-body", where: "message", updatedAt: 10 }),
    hit({ sessionID: "new-body", where: "message", updatedAt: 30 }),
    hit({ sessionID: "old-title", where: "title", updatedAt: 5 }),
    hit({ sessionID: "new-title", where: "title", updatedAt: 20 }),
  ]).map((h) => h.sessionID)
  assert.deepEqual(ranked, ["new-title", "old-title", "new-body", "old-body"])
})

test("ranking does not mutate what it was given", () => {
  const input = [hit({ sessionID: "a", updatedAt: 1 }), hit({ sessionID: "b", updatedAt: 2 })]
  rankHits(input)
  assert.deepEqual(
    input.map((h) => h.sessionID),
    ["a", "b"],
  )
})
