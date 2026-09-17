// telegram/fmt.ts — the small shared shapers. Both clock-readers take the
// instant as an argument, so none of this waits for time to pass.

import { test } from "node:test"
import assert from "node:assert/strict"
import { clipTitle, fmtCount, fmtDuration, fmtHome, fmtWsPath, timeAgo } from "../src/telegram/fmt.ts"

test("durations pick one unit and round", () => {
  assert.equal(fmtDuration(900), "1s")
  assert.equal(fmtDuration(45_000), "45s")
  assert.equal(fmtDuration(90_000), "2m")
  assert.equal(fmtDuration(5_400_000), "2h")
  assert.equal(fmtDuration(3 * 86_400_000), "3d")
})

test("counts read like a status bar, not a spreadsheet", () => {
  assert.equal(fmtCount(0), "0")
  assert.equal(fmtCount(999), "999")
  assert.equal(fmtCount(1000), "1K")
  assert.equal(fmtCount(12_430), "12.4K")
  assert.equal(fmtCount(1_834_219), "1.8M")
})

test("a title is flattened and clipped with an ellipsis", () => {
  assert.equal(clipTitle("short"), "short")
  assert.equal(clipTitle("a\n  multi   line\ttitle"), "a multi line title")
  const long = clipTitle("x".repeat(100), 10)
  assert.equal(long.length, 10)
  assert.ok(long.endsWith("…"))
})

test("a title clipped mid-space does not keep the space before the ellipsis", () => {
  assert.equal(clipTitle("abcdefgh ijkl", 10), "abcdefgh…")
})

test("ages are coarse, and a future timestamp renders as nothing", () => {
  const now = 1_700_000_000_000
  assert.equal(timeAgo(now - 10_000, now), "just now")
  assert.equal(timeAgo(now - 5 * 60_000, now), "5m ago")
  assert.equal(timeAgo(now - 3 * 3_600_000, now), "3h ago")
  assert.equal(timeAgo(now - 2 * 86_400_000, now), "2d ago")
  assert.equal(timeAgo(now - 14 * 86_400_000, now), "2w ago")
  assert.equal(timeAgo(now - 200 * 86_400_000, now), "7mo ago")
  assert.equal(timeAgo(0, now), "", "no timestamp, nothing to say")
  assert.equal(timeAgo(now + 60_000, now), "", "a clock skew is not a negative age")
})

test("a workspace shows as its folder name", () => {
  assert.equal(fmtWsPath("/home/me/code/jep"), "jep")
  assert.equal(fmtWsPath("/home/me/code/jep/"), "jep")
})

test("paths fold $HOME back to ~", () => {
  assert.equal(fmtHome("/home/me", "/home/me"), "~")
  assert.equal(fmtHome("/home/me/code/jep", "/home/me"), "~/code/jep")
  assert.equal(fmtHome("/opt/elsewhere", "/home/me"), "/opt/elsewhere")
  assert.equal(fmtHome("/home/mensa/x", "/home/me"), "/home/mensa/x", "a prefix is not a parent")
})
