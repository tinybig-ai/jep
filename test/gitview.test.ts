// telegram/gitview.ts — what the /git screens say. Pure, so every layout
// decision is checkable here rather than by squinting at a CALL dump.

import { test } from "node:test"
import assert from "node:assert/strict"
import { GIT_ROWS, clipPath, diffWindow, gitLogText, gitMark, gitStatusText } from "../src/telegram/gitview.ts"
import type { GitCommit, GitFile, GitStatus } from "../src/core/git.ts"

const file = (over: Partial<GitFile> = {}): GitFile => ({
  path: "src/a.ts",
  code: "M",
  staged: false,
  additions: 1,
  deletions: 0,
  binary: false,
  ...over,
})

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  dir: "/home/me/code/jep",
  branch: "main",
  detached: false,
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  additions: 0,
  deletions: 0,
  commits: [],
  born: true,
  ...over,
})

test("a clean tree says so instead of drawing an empty table", () => {
  const out = gitStatusText(status())
  assert.match(out, /## ⎇ main/)
  assert.match(out, /✓ clean/)
  assert.doesNotMatch(out, /\|/, "no table at all")
})

test("the tracking line reports each state in its own words", () => {
  assert.match(gitStatusText(status()), /in sync with origin\/main/)
  assert.match(gitStatusText(status({ ahead: 3 })), /↑3 vs origin\/main/)
  assert.match(gitStatusText(status({ ahead: 2, behind: 1 })), /↑2 ↓1 vs origin\/main/)
  assert.match(gitStatusText(status({ upstream: null })), /no upstream/)
  assert.match(gitStatusText(status({ born: false, upstream: null })), /no commits yet/)
  assert.match(gitStatusText(status({ detached: true, branch: "9d1532c" })), /detached HEAD/)
})

test("the changes table carries the letter, the counts and the totals", () => {
  const out = gitStatusText(
    status({
      files: [file({ path: "src/one.ts", additions: 12, deletions: 3 })],
      additions: 12,
      deletions: 3,
    }),
  )
  assert.match(out, /\*\*1 changed\*\* · \+12 −3/)
  assert.match(out, /M src\/one\.ts/)
  assert.match(out, /\| 12 \| 3 \|/)
})

test("a zero count renders as an empty cell, not a 0", () => {
  const out = gitStatusText(status({ files: [file({ additions: 4, deletions: 0 })], additions: 4 }))
  assert.match(out, /\| 4 \|  \|/, "the deletions cell is blank")
})

test("a binary file says bin rather than a meaningless count", () => {
  const out = gitStatusText(status({ files: [file({ binary: true, additions: 0, deletions: 0 })] }))
  assert.match(out, /\| bin \|/)
})

test("staged rows are marked, and the mark is explained only when one is used", () => {
  assert.equal(gitMark(file({ staged: true })), "●M")
  assert.equal(gitMark(file({ staged: false })), "M")
  const withStaged = gitStatusText(status({ files: [file({ staged: true })] }))
  assert.match(withStaged, /● staged/, "the legend earns its line")
  const without = gitStatusText(status({ files: [file({ staged: false })] }))
  assert.doesNotMatch(without, /● staged/)
})

test("a rename names where it came from", () => {
  const out = gitStatusText(status({ files: [file({ code: "R", path: "src/new.ts", from: "src/old.ts" })] }))
  assert.match(out, /⟵ old\.ts/)
})

test("more files than fit are counted, not dropped silently", () => {
  const many = Array.from({ length: GIT_ROWS + 5 }, (_, i) => file({ path: `src/f${i}.ts` }))
  const out = gitStatusText(status({ files: many }))
  assert.match(out, /… and 5 more/)
  assert.ok(!out.includes(`f${GIT_ROWS + 1}.ts`), "rows past the cap are not drawn")
})

test("a long path keeps its tail, which is the part that identifies it", () => {
  const clipped = clipPath("a/very/deeply/nested/path/to/the/interesting/file.ts", 20)
  assert.equal(clipped.length, 20)
  assert.ok(clipped.endsWith("file.ts"))
  assert.ok(clipped.startsWith("…"))
  assert.equal(clipPath("short.ts", 20), "short.ts", "a short path is untouched")
})

// ─── the log ───

const commit = (over: Partial<GitCommit> = {}): GitCommit => ({
  hash: "abc1234",
  subject: "a change",
  at: 0,
  author: "T",
  ...over,
})

test("an empty log says so rather than rendering nothing", () => {
  assert.equal(gitLogText([]), "(no commits yet)")
})

test("ages are padded so the subjects line up", () => {
  const now = 1_000_000_000_000
  const out = gitLogText(
    [
      commit({ hash: "aaaaaaa", at: now - 2 * 3_600_000, subject: "two hours" }),
      commit({ hash: "bbbbbbb", at: now - 3 * 86_400_000, subject: "three days" }),
    ],
    40,
    now,
  )
  const [first, second] = out.split("\n")
  assert.equal(first!.indexOf("two hours"), second!.indexOf("three days"), "subjects start in the same column")
  assert.match(out, / 2h /)
  assert.match(out, / 3d /)
})

test("the author appears only when the log has more than one", () => {
  const one = gitLogText([commit({ author: "T" }), commit({ author: "T" })])
  assert.doesNotMatch(one, /· T/, "naming the only author on every line is noise")
  const two = gitLogText([commit({ author: "T" }), commit({ author: "Other" })])
  assert.match(two, /· Other/)
})

test("a long subject is clipped to the given width", () => {
  const out = gitLogText([commit({ subject: "x".repeat(200) })], 30)
  assert.ok(out.length < 60)
  assert.match(out, /…/)
})

// ─── the diff pager ───

const patch = Array.from({ length: 200 }, (_, i) => `+ line ${i}`).join("\n")

test("a patch that fits is returned whole, with nothing after it", () => {
  const { body, next } = diffWindow("short\npatch", 0, 1000)
  assert.equal(body, "short\npatch")
  assert.equal(next, null)
})

test("a window cuts on a line boundary", () => {
  const { body } = diffWindow(patch, 0, 100)
  assert.ok(body.length <= 100)
  assert.ok(!body.endsWith("\n"), "the newline itself is not carried into the page")
  assert.ok(patch.startsWith(body))
  // every line in the page is a whole line of the patch
  for (const line of body.split("\n")) assert.match(line, /^\+ line \d+$/)
})

test("paging through a patch reproduces it exactly", () => {
  // the property that matters: no character is shown twice, and none is lost
  const pages: string[] = []
  let off: number | null = 0
  let guard = 0
  while (off !== null) {
    const { body, next } = diffWindow(patch, off, 137)
    pages.push(body)
    off = next
    assert.ok(guard++ < 100, "the pager must terminate")
  }
  assert.equal(pages.join("\n"), patch)
  assert.ok(pages.length > 1, "this patch really is longer than one page")
})

test("a page with no line break in it still advances", () => {
  const unbroken = "x".repeat(500)
  const { body, next } = diffWindow(unbroken, 0, 100)
  assert.equal(body.length, 100, "a hard cut, rather than no progress at all")
  assert.equal(next, 100)
})

test("a negative offset is read as the start", () => {
  const { body } = diffWindow("abc", -50, 10)
  assert.equal(body, "abc")
})
