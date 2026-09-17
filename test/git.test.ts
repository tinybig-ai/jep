// core/git.ts — the porcelain/numstat grammars as unit tests, then one real
// repository built in a temp dir, because the interesting cases (a rename that
// also changed, an unborn HEAD, a read from a subdirectory) are exactly the
// ones a hand-written fixture would get wrong in the same way the parser does.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileDiff, fullDiff, isRepo, parseNumstat, parsePorcelain, push, repoStatus } from "../src/core/git.ts"

test("porcelain: branch, upstream and ahead/behind", () => {
  const out = [
    "# branch.oid 9d1532c",
    "# branch.head feat/thing",
    "# branch.upstream origin/feat/thing",
    "# branch.ab +3 -2",
  ].join("\n")
  const p = parsePorcelain(out)
  assert.equal(p.branch, "feat/thing")
  assert.equal(p.upstream, "origin/feat/thing")
  assert.equal(p.ahead, 3)
  assert.equal(p.behind, 2)
  assert.equal(p.detached, false)
  assert.deepEqual(p.files, [])
})

test("porcelain: a detached head says so, and has no upstream", () => {
  const p = parsePorcelain("# branch.head (detached)\n")
  assert.equal(p.detached, true)
  assert.equal(p.upstream, null)
  assert.equal(p.ahead, 0)
  assert.equal(p.behind, 0)
})

test("porcelain: the letter comes from whichever side changed the file", () => {
  const p = parsePorcelain(
    [
      // staged modification (X=M), clean worktree
      "1 M. N... 100644 100644 100644 aaa bbb staged.ts",
      // unstaged modification (Y=M)
      "1 .M N... 100644 100644 100644 aaa bbb dirty.ts",
      // staged delete
      "1 D. N... 100644 000000 000000 aaa 000 gone.ts",
    ].join("\n"),
  )
  assert.deepEqual(
    p.files.map((f) => [f.path, f.code, f.staged]),
    [
      ["staged.ts", "M", true],
      ["dirty.ts", "M", false],
      ["gone.ts", "D", true],
    ],
  )
})

test("porcelain: a rename keeps the path it came from", () => {
  const p = parsePorcelain("2 RM N... 100644 100644 100644 aaa bbb R100 new/name.ts\told/name.ts\n")
  assert.equal(p.files.length, 1)
  assert.deepEqual(
    { path: p.files[0]!.path, from: p.files[0]!.from, code: p.files[0]!.code },
    { path: "new/name.ts", from: "old/name.ts", code: "R" },
  )
})

test("porcelain: untracked and unmerged entries", () => {
  const p = parsePorcelain("? some/new.ts\nu UU N... 1 2 3 4 aaa bbb ccc conflict.ts\n")
  assert.deepEqual(
    p.files.map((f) => [f.path, f.code]),
    [
      ["some/new.ts", "?"],
      ["conflict.ts", "U"],
    ],
  )
})

test("porcelain: a path containing spaces survives", () => {
  const p = parsePorcelain("1 .M N... 100644 100644 100644 aaa bbb my notes/a file.md\n")
  assert.equal(p.files[0]!.path, "my notes/a file.md")
})

test("numstat: counts, binaries, and the rename record", () => {
  // -z: records are NUL-separated, and a rename's two paths follow the counts
  const raw = ["1\t2\tplain.ts", "-\t-\tlogo.png", "5\t0\t", "old.ts", "new.ts", ""].join("\0")
  const m = parseNumstat(raw)
  assert.deepEqual(m.get("plain.ts"), { additions: 1, deletions: 2, binary: false })
  assert.deepEqual(m.get("logo.png"), { additions: 0, deletions: 0, binary: true })
  // the change belongs to where the file ended up, not where it started
  assert.deepEqual(m.get("new.ts"), { additions: 5, deletions: 0, binary: false })
  assert.equal(m.get("old.ts"), undefined)
})

// ─── against a real repository ───

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    encoding: "utf8",
  })

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "jep-git-test-"))
  git(dir, "init", "-q", "-b", "main", ".")
  return dir
}

test("a directory that is not a repo says so", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jep-plain-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(await isRepo(dir), false)
})

test("before the first commit: unborn HEAD, untracked files still counted", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n")
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]))

  const st = await repoStatus(dir)
  assert.equal(st.born, false, "no commit yet")
  assert.equal(st.branch, "main")
  assert.equal(st.upstream, null)
  assert.deepEqual(st.commits, [], "an unborn branch has no log, and that is not an error")

  const a = st.files.find((f) => f.path === "a.txt")!
  assert.equal(a.code, "?")
  assert.equal(a.additions, 2, "every line of a new file is an addition")
  const bin = st.files.find((f) => f.path === "blob.bin")!
  assert.equal(bin.binary, true, "a NUL in the first bytes means don't count lines")
  assert.equal(bin.additions, 0)
})

test("a rename that also changed counts the change", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "old.txt"), "a\nb\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  git(dir, "mv", "old.txt", "new.txt")
  writeFileSync(join(dir, "new.txt"), "a\nb\nc\n")

  const st = await repoStatus(dir)
  const f = st.files.find((x) => x.path === "new.txt")!
  assert.equal(f.code, "R")
  assert.equal(f.from, "old.txt")
  assert.equal(f.additions, 1, "the +1 must not be lost to the rename")
  assert.equal(f.deletions, 0)
})

test("status reads the same from a subdirectory as from the root", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "top.txt"), "x\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  mkdirSync(join(dir, "deep", "deeper"), { recursive: true })
  writeFileSync(join(dir, "deep", "deeper", "buried.txt"), "y\n")
  writeFileSync(join(dir, "top.txt"), "x\nz\n")

  const fromRoot = await repoStatus(dir)
  const fromSub = await repoStatus(join(dir, "deep", "deeper"))
  assert.deepEqual(fromSub.files, fromRoot.files)
  assert.equal(fromSub.dir, fromRoot.dir, "both anchor on the repo root")
  // paths stay root-relative, which is what makes them resolvable at all
  assert.ok(fromSub.files.some((f) => f.path === "deep/deeper/buried.txt"))
})

test("staged and unstaged edits to one file are one row", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "f.txt"), "1\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  writeFileSync(join(dir, "f.txt"), "1\n2\n")
  git(dir, "add", "f.txt")
  writeFileSync(join(dir, "f.txt"), "1\n2\n3\n")

  const st = await repoStatus(dir)
  const rows = st.files.filter((f) => f.path === "f.txt")
  assert.equal(rows.length, 1, "one file, one row")
  assert.equal(rows[0]!.staged, true)
  assert.equal(rows[0]!.additions, 2, "counted against HEAD, so both edits show")
})

test("staged rows sort first", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "a.txt"), "1\n")
  writeFileSync(join(dir, "b.txt"), "1\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  writeFileSync(join(dir, "a.txt"), "2\n")
  writeFileSync(join(dir, "b.txt"), "2\n")
  git(dir, "add", "b.txt")

  const st = await repoStatus(dir)
  assert.equal(st.files[0]!.path, "b.txt", "the staged one leads")
  assert.equal(st.files[0]!.staged, true)
})

test("an untracked file has a patch, and the whole-tree diff contains it", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "kept.txt"), "old\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")
  writeFileSync(join(dir, "kept.txt"), "new\n")
  writeFileSync(join(dir, "fresh.txt"), "hello\n")

  const st = await repoStatus(dir)
  const fresh = st.files.find((f) => f.path === "fresh.txt")!
  const patch = await fileDiff(st.dir, fresh, st.born)
  assert.match(patch, /\+hello/, "git diff alone would show nothing for an untracked file")

  const whole = await fullDiff(st.dir, st.files, st.born)
  assert.match(whole, /\+hello/, "untracked files belong in the whole-tree patch")
  assert.match(whole, /\+new/, "and so do tracked ones")
})

test("commits come back newest first, and paging skips", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const n of ["one", "two", "three"]) {
    writeFileSync(join(dir, `${n}.txt`), `${n}\n`)
    git(dir, "add", ".")
    git(dir, "commit", "-qm", n)
  }
  const st = await repoStatus(dir, 2)
  assert.deepEqual(
    st.commits.map((c) => c.subject),
    ["three", "two"],
  )
  assert.ok(st.commits[0]!.at > 0, "an author date, as epoch ms")
  assert.equal(st.commits[0]!.author, "T")

  const { commits } = await import("../src/core/git.ts")
  const page2 = await commits(st.dir, 2, 2)
  assert.deepEqual(
    page2.map((c) => c.subject),
    ["one"],
    "skip pages backwards through history",
  )
})

test("a clean tree reports nothing changed", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, "f.txt"), "1\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "init")

  const st = await repoStatus(dir)
  assert.deepEqual(st.files, [])
  assert.equal(st.additions, 0)
  assert.equal(st.deletions, 0)
  assert.equal(st.born, true)
})

// ─── the one write ───

test("a branch with no upstream still knows what it would push", async (t) => {
  const bare = mkdtempSync(join(tmpdir(), "jep-remote-"))
  const dir = tempRepo()
  t.after(() => {
    rmSync(bare, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  execFileSync("git", ["init", "-q", "--bare", "."], { cwd: bare })
  writeFileSync(join(dir, "a.txt"), "one\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "first")
  git(dir, "remote", "add", "origin", bare)

  const st = await repoStatus(dir)
  assert.equal(st.upstream, null, "nothing has been pushed yet")
  assert.equal(st.ahead, 0, "git reports ahead 0 without an upstream to compare against")
  assert.equal(st.unpushed, 1, "which is why unpushed exists")
  assert.equal(st.remote, "origin", "and it knows where it would go")
})

test("pushing sends the commits and leaves the branch in sync", async (t) => {
  const bare = mkdtempSync(join(tmpdir(), "jep-remote-"))
  const dir = tempRepo()
  t.after(() => {
    rmSync(bare, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
  execFileSync("git", ["init", "-q", "--bare", "."], { cwd: bare })
  writeFileSync(join(dir, "a.txt"), "one\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "first")
  git(dir, "remote", "add", "origin", bare)

  const first = await push(dir, { setUpstream: true, remote: "origin", branch: "main" })
  assert.equal(first.ok, true, first.message)
  assert.match(
    execFileSync("git", ["log", "--format=%s", "-1", "main"], { cwd: bare, encoding: "utf8" }),
    /first/,
    "the remote really has it",
  )

  const after = await repoStatus(dir)
  assert.equal(after.upstream, "origin/main", "the upstream is set now")
  assert.equal(after.ahead, 0)
  assert.equal(after.unpushed, 0)

  // a second commit needs no --set-upstream, and the plain form finds its way
  writeFileSync(join(dir, "b.txt"), "two\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "second")
  assert.equal((await repoStatus(dir)).ahead, 1)
  const again = await push(dir)
  assert.equal(again.ok, true, again.message)
  assert.equal((await repoStatus(dir)).ahead, 0)
})

test("a rejected push comes back with git's own explanation", async (t) => {
  const bare = mkdtempSync(join(tmpdir(), "jep-remote-"))
  const dir = tempRepo()
  const other = mkdtempSync(join(tmpdir(), "jep-other-"))
  t.after(() => {
    for (const d of [bare, dir, other]) rmSync(d, { recursive: true, force: true })
  })
  execFileSync("git", ["init", "-q", "--bare", "."], { cwd: bare })
  writeFileSync(join(dir, "a.txt"), "one\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "first")
  git(dir, "remote", "add", "origin", bare)
  await push(dir, { setUpstream: true, remote: "origin", branch: "main" })

  // somebody else pushes on top. -b main because the bare repo's own HEAD
  // still points at master: a plain clone checks out nothing and then commits
  // to the wrong branch, which is not a conflict at all.
  execFileSync("git", ["clone", "-q", "-b", "main", bare, "."], { cwd: other })
  writeFileSync(join(other, "theirs.txt"), "theirs\n")
  git(other, "add", ".")
  git(other, "commit", "-qm", "theirs")
  git(other, "push", "-q")

  // and now ours diverges
  writeFileSync(join(dir, "mine.txt"), "mine\n")
  git(dir, "add", ".")
  git(dir, "commit", "-qm", "mine")
  const r = await push(dir)
  assert.equal(r.ok, false)
  assert.match(r.message, /reject|fetch first|non-fast-forward/i, `unhelpful failure: ${r.message}`)
})

test("push refuses to guess when there is no upstream and no remote named", async (t) => {
  const dir = tempRepo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const r = await push(dir, { setUpstream: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /no remote/)
})
