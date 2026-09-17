// Reads a working tree with git, for /git.
//
// Deliberately not a HarnessAdapter port: an adapter's `diff` only knows the
// files *that harness* touched in *that session*, which is a different and
// smaller question. This reads the repo itself, so it also sees what you
// changed in an editor, what is already staged, and where the branch stands
// against its upstream — the things you need before you can decide whether to
// land any of it.
//
// Every call is read-only except `push`, which is the one write and is the
// last function in the file. Nothing else touches the index, the tree or a
// ref: `git add -N` would make untracked files easier to diff and is exactly
// the kind of quiet mutation a "status" command must not do. Committing is
// not here either — it needs judgment about what and why, which the agent has
// and a button doesn't. Pushing needs none: the commits already exist.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

const execFileAsync = promisify(execFile)

// execFile's 1MB default truncates a real diff into a thrown error; a refactor
// of any size clears that on its own.
const MAX_BUFFER = 16 * 1024 * 1024
const TIMEOUT_MS = 15_000
// past this an untracked file isn't worth counting lines in just to render a
// "+N" — and reading it whole would be the expensive part of the whole command
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024

export interface GitFile {
  path: string
  /** git's own letter: M A D R C U, or ? for untracked */
  code: string
  /** the change is in the index, not just the working tree */
  staged: boolean
  additions: number
  deletions: number
  /** binary, or too big to count — additions/deletions are meaningless */
  binary: boolean
  /** where a rename came from */
  from?: string
}

export interface GitCommit {
  hash: string
  subject: string
  /** author date, epoch ms — humanizing it is the front end's job */
  at: number
  author: string
}

export interface GitStatus {
  dir: string
  /** the remote a push would go to: the upstream's, else the first configured one */
  remote: string | null
  /** branch name, or "(detached)" */
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  /**
   * Commits on HEAD that no remote has, for a branch with no upstream yet —
   * where git reports ahead/behind as 0 because it has nothing to compare
   * against. Which is exactly the branch you most want to push.
   */
  unpushed: number
  files: GitFile[]
  additions: number
  deletions: number
  commits: GitCommit[]
  /** HEAD resolves — false in a repo that has no commits yet */
  born: boolean
}

// Never throws and never inspects an exit code on the caller's behalf:
// `git diff --no-index` exits 1 precisely when it has output, so "failed" and
// "said something" are independent facts here.
async function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd: dir, maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS })
    return { ok: true, out: stdout, err: stderr }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: e.stdout ?? "", err: (e.stderr || e.message || "").trim() }
  }
}

/** configured remotes, in git's own order */
export async function remotes(dir: string): Promise<string[]> {
  const r = await git(dir, ["remote"])
  return r.ok ? r.out.split("\n").map((l) => l.trim()).filter(Boolean) : []
}

export async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--git-dir"])).ok
}

/** the repo root, so a workspace pointed at a subdirectory still names itself right */
export async function repoRoot(dir: string): Promise<string | null> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"])
  return r.ok ? r.out.trim() || null : null
}

// porcelain v2 is the only status format with a documented, stable grammar —
// v1's XY columns can't be told apart from a path that starts with a space.
// Exported because this grammar is the fiddly part and belongs in a test.
export function parsePorcelain(out: string): { files: GitFile[]; branch: string; upstream: string | null; ahead: number; behind: number; detached: boolean } {
  const files: GitFile[] = []
  let branch = "(unknown)"
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let detached = false
  for (const line of out.split("\n")) {
    if (!line) continue
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim()
      detached = v === "(detached)"
      branch = v
      continue
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim()
      continue
    }
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
      continue
    }
    if (line.startsWith("# ")) continue
    const kind = line[0]
    if (kind === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = line.split(" ")
      const xy = f[1] ?? ".."
      const path = f.slice(8).join(" ")
      if (path) files.push(entry(path, xy))
      continue
    }
    if (kind === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <score> <path>\t<origPath>
      const f = line.split(" ")
      const xy = f[1] ?? ".."
      const tail = f.slice(9).join(" ")
      const [path, from] = tail.split("\t")
      if (path) files.push({ ...entry(path, xy), ...(from ? { from } : {}) })
      continue
    }
    if (kind === "u") {
      const f = line.split(" ")
      const path = f.slice(10).join(" ")
      if (path) files.push({ path, code: "U", staged: false, additions: 0, deletions: 0, binary: false })
      continue
    }
    if (kind === "?") {
      files.push({ path: line.slice(2), code: "?", staged: false, additions: 0, deletions: 0, binary: false })
    }
  }
  return { files, branch, upstream, ahead, behind, detached }
}

// X is the index, Y the working tree. One letter has to stand for the file, so
// prefer whichever side actually changed it — and say staged only when X did.
function entry(path: string, xy: string): GitFile {
  const x = xy[0] ?? "."
  const y = xy[1] ?? "."
  const code = x !== "." ? x : y !== "." ? y : "M"
  return { path, code, staged: x !== ".", additions: 0, deletions: 0, binary: false }
}

// NUL-separated records: "12\t3\tpath", or "-\t-\tpath" for a binary file. A
// rename is the reason for -z: without it the path prints as "old => new",
// which matches no status path, and the edit that came with the rename would
// silently count as zero. In -z the record ends after the counts and the two
// paths follow as their own tokens; the change belongs to the new one.
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const m = new Map<string, { additions: number; deletions: number; binary: boolean }>()
  const tok = out.split("\0")
  for (let i = 0; i < tok.length; i++) {
    const rec = tok[i]!
    if (!rec.trim()) continue
    const [a, d, ...rest] = rec.split("\t")
    if (a === undefined || d === undefined) continue
    const counts = { additions: Number(a) || 0, deletions: Number(d) || 0, binary: a === "-" }
    const inline = rest.join("\t")
    if (inline) {
      m.set(inline, counts)
      continue
    }
    // rename: <counts>\0<old>\0<new>
    const to = tok[i + 2]
    if (to) m.set(to, counts)
    i += 2
  }
  return m
}

// An untracked file is every line added, but git won't say so without being
// told to stage it. Counting newlines is cheap and, unlike `git add -N`,
// changes nothing.
async function untrackedAdditions(dir: string, path: string): Promise<{ additions: number; binary: boolean }> {
  try {
    const full = join(dir, path)
    const info = await stat(full)
    if (info.isDirectory()) return { additions: 0, binary: false }
    if (info.size > UNTRACKED_MAX_BYTES) return { additions: 0, binary: true }
    const buf = await readFile(full)
    if (buf.subarray(0, 8192).includes(0)) return { additions: 0, binary: true }
    if (buf.length === 0) return { additions: 0, binary: false }
    let lines = 0
    for (const b of buf) if (b === 10) lines++
    // a file with no trailing newline still has a last line
    if (buf[buf.length - 1] !== 10) lines++
    return { additions: lines, binary: false }
  } catch {
    return { additions: 0, binary: false }
  }
}

const COMMIT_SEP = "\x1f"
const COMMIT_FMT = ["%h", "%s", "%at", "%an"].join(COMMIT_SEP)

/** `skip` pages backwards through history, so the log view stays one bounded message */
export async function commits(dir: string, limit: number, skip = 0): Promise<GitCommit[]> {
  const r = await git(dir, [
    "log",
    `-n${Math.max(1, limit)}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    `--format=${COMMIT_FMT}`,
  ])
  if (!r.ok) return [] // an unborn branch has no log, and that isn't an error
  return r.out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const [hash, subject, at, author] = l.split(COMMIT_SEP)
      return { hash: hash ?? "", subject: subject ?? "", at: (Number(at) || 0) * 1000, author: author ?? "" }
    })
}

// `dir` is a workspace, which may be any directory *inside* a repo. Porcelain
// paths are always relative to the repo root, so everything below works from
// the root instead — otherwise a workspace one level down would name files it
// can't find, and GitStatus.dir would label the view with the wrong folder.
export async function repoStatus(workspace: string, commitLimit = 5): Promise<GitStatus> {
  const dir = (await repoRoot(workspace)) ?? workspace
  const [porcelain, head] = await Promise.all([
    // -uall lists new files individually; the default collapses a new folder
    // into one "dir/" row, which can't be diffed and hides what's in it
    git(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]),
    git(dir, ["rev-parse", "--verify", "HEAD"]),
  ])
  if (!porcelain.ok) throw new Error(porcelain.err || "git status failed")
  const born = head.ok
  const { files, branch, upstream, ahead, behind, detached } = parsePorcelain(porcelain.out)
  // vs HEAD, so staged and unstaged edits to one file land in a single row —
  // which is what "what have I changed here" means. Before the first commit
  // there is no HEAD to compare against, so the index is the whole story.
  const remoteList = await remotes(dir)
  // only asked when it is the number that matters: with an upstream, `ahead`
  // is already the answer, and on a repo with no remotes this would count the
  // entire history as "unpushed"
  const unpushed =
    born && remoteList.length && !upstream
      ? Number((await git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"])).out.trim()) || 0
      : 0
  const numstat = await git(dir, born ? ["diff", "--numstat", "-z", "HEAD"] : ["diff", "--numstat", "-z", "--cached"])
  const counts = parseNumstat(numstat.out)
  for (const f of files) {
    const n = counts.get(f.path)
    if (n) {
      f.additions = n.additions
      f.deletions = n.deletions
      f.binary = n.binary
    } else if (f.code === "?") {
      const u = await untrackedAdditions(dir, f.path)
      f.additions = u.additions
      f.binary = u.binary
    }
  }
  // staged first, then the rest — reading top to bottom then matches how the
  // change is going to be committed
  files.sort((a, b) => Number(b.staged) - Number(a.staged) || a.path.localeCompare(b.path))
  return {
    dir,
    // the upstream names its own remote ("origin/main" -> "origin"); with no
    // upstream yet, the first configured remote is where a push would go
    remote: upstream?.includes("/") ? upstream.split("/")[0]! : (remoteList[0] ?? null),
    branch,
    detached,
    upstream,
    ahead,
    behind,
    unpushed,
    files,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    commits: await commits(dir, commitLimit),
    born,
  }
}

/** one file's patch — including an untracked one, which `git diff` alone won't show */
export async function fileDiff(dir: string, f: GitFile, born: boolean): Promise<string> {
  if (f.code === "?") {
    // exits 1 whenever it has output, so ok is not the test here
    const r = await git(dir, ["diff", "--no-index", "--", "/dev/null", f.path])
    return r.out || (r.err ? `(${r.err})` : "")
  }
  const r = await git(dir, born ? ["diff", "HEAD", "--", f.path] : ["diff", "--cached", "--", f.path])
  return r.ok ? r.out : r.out || `(${r.err})`
}

/** every change in the tree as one patch, untracked files included */
export async function fullDiff(dir: string, files: GitFile[], born: boolean): Promise<string> {
  const tracked = files.some((f) => f.code !== "?")
    ? (await git(dir, born ? ["diff", "HEAD"] : ["diff", "--cached"])).out
    : ""
  const untracked: string[] = []
  for (const f of files.filter((f) => f.code === "?")) {
    const d = await fileDiff(dir, f, born)
    if (d.trim()) untracked.push(d)
  }
  return [tracked, ...untracked].filter((s) => s.trim()).join("\n")
}

/**
 * The write. Pushes the current branch to its upstream, or sets one up when
 * it has none — which is the common case for a branch made on this machine,
 * and the only part of pushing that is a decision, so the caller has to ask
 * for it explicitly.
 *
 * Never force, never `--all`, never a refspec the caller didn't name: the
 * point is to send commits that already exist, and nothing else.
 *
 * git reports progress and rejections on stderr, so both streams come back —
 * "Updates were rejected because the remote contains work that you do not
 * have locally" is the useful half of a failure.
 */
export async function push(
  dir: string,
  opts: { branch?: string; setUpstream?: boolean; remote?: string } = {},
): Promise<{ ok: boolean; message: string }> {
  const args = ["push"]
  if (opts.setUpstream) {
    if (!opts.remote || !opts.branch) return { ok: false, message: "no remote to push to" }
    args.push("--set-upstream", opts.remote, opts.branch)
  }
  const r = await git(dir, args)
  const message = [r.err, r.out]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
  return { ok: r.ok, message }
}
