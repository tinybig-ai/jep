// PURE RENDERER — a GitStatus becomes the markdown the /git screens are built
// from. No I/O, no state, no Telegram calls: the same rule html.ts and rich.ts
// follow, so every layout decision here is checkable from a test.
//
// bot.ts owns the screens themselves (which buttons, which message, what a tap
// does). This file owns what they say.

import { basename } from "node:path"
import { mdTable } from "./rich.ts"
import { clipTitle, fmtDuration, fmtWsPath } from "./fmt.ts"
import type { GitCommit, GitFile, GitStatus } from "../core/git.ts"

// What /git shows at once, and what a "see more" tap adds. Small on purpose:
// this is a phone screen, and the view's job is to answer "what is in this
// tree" at a glance, with the long form one tap away.
export const GIT_ROWS = 12 // file rows in the changes table
export const GIT_FILE_BTNS = 6 // per-file diff buttons under it
export const GIT_COMMITS = 5 // commits in the status view
export const GIT_LOG = 15 // commits per page of the log view
// One screenful of patch. Kept well inside MAX_MSG because the diff shares a
// message with its heading and buttons, and a rejected message shows nothing
// at all — the pager, not the cap, is what makes a big diff readable here.
export const GIT_DIFF_CHARS = 2400

// The path is the widest cell in the changes table and the least readable when
// it wraps. The tail is the part that identifies the file, so keep that end.
export const clipPath = (p: string, max = 30): string => (p.length <= max ? p : `…${p.slice(-(max - 1))}`)

// git's own letter for the change, plus a dot when it is already in the index:
// the two facts a status row has to carry, in the width of a table cell.
export const gitMark = (f: GitFile): string => `${f.staged ? "●" : ""}${f.code}`

// Branch, where it stands against its upstream, and the size of the change —
// the three things you want before deciding whether to look closer.
export function gitStatusText(st: GitStatus): string {
  const track = !st.born
    ? "no commits yet"
    : !st.upstream
      ? "no upstream"
      : st.ahead || st.behind
        ? [st.ahead ? `↑${st.ahead}` : "", st.behind ? `↓${st.behind}` : "", `vs ${st.upstream}`].filter(Boolean).join(" ")
        : `in sync with ${st.upstream}`
  const out = [
    `## ⎇ ${st.detached ? "detached HEAD" : st.branch}`,
    `${fmtWsPath(st.dir)} · ${track}`,
    st.files.length ? `**${st.files.length} changed** · +${st.additions} −${st.deletions}` : "✓ clean — nothing to commit",
  ]
  const shown = st.files.slice(0, GIT_ROWS)
  if (shown.length) {
    out.push(
      "",
      mdTable(
        ["File", "+", "−"],
        shown.map((f) => [
          `${gitMark(f)} ${clipPath(f.from ? `${f.path} ⟵ ${basename(f.from)}` : f.path)}`,
          f.binary ? "bin" : f.additions ? String(f.additions) : "",
          f.binary ? "" : f.deletions ? String(f.deletions) : "",
        ]),
      ),
    )
    if (st.files.length > shown.length) out.push(`… and ${st.files.length - shown.length} more`)
    // only worth explaining when a row actually carries the dot
    if (st.files.some((f) => f.staged)) out.push("● staged")
  }
  return out.join("\n")
}

// Monospace, because a log is a column of hashes and ages that only reads as a
// log when they line up. Ages are the same coarse form the pin and /ls use.
export function gitLogText(cs: GitCommit[], width = 40, now = Date.now()): string {
  if (!cs.length) return "(no commits yet)"
  const manyAuthors = new Set(cs.map((c) => c.author)).size > 1
  return cs
    .map((c) => {
      const age = c.at ? fmtDuration(Math.max(now - c.at, 1000)).padStart(3) : "  ?"
      const who = manyAuthors && c.author ? ` · ${clipTitle(c.author, 14)}` : ""
      return `${c.hash}  ${age}  ${clipTitle(c.subject, width)}${who}`
    })
    .join("\n")
}

// A patch is the one thing here with no natural size, so it is paged rather
// than truncated. Cuts land on a line boundary — half a hunk header is worse
// than one line fewer.
export function diffWindow(patch: string, off: number, max: number): { body: string; next: number | null } {
  const from = Math.max(0, off)
  const rest = patch.slice(from)
  if (rest.length <= max) return { body: rest, next: null }
  const nl = rest.lastIndexOf("\n", max)
  const end = nl > max / 2 ? nl : max
  return { body: rest.slice(0, end), next: from + end + (rest[end] === "\n" ? 1 : 0) }
}
