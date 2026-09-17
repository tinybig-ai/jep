// PURE FORMATTERS — the small string shapers the front end shares.
//
// No I/O, no state, no Telegram: string (or number) in, display string out.
// They lived in bot.ts, which made them unreachable from a test and from the
// renderers that need them. `timeAgo` and `fmtDuration` read the clock, which
// is the one impurity here — both take the instant as an argument so a test
// doesn't have to wait for one.

import { basename } from "node:path"
import { homedir } from "node:os"

// 45_000 -> "45s", 5_400_000 -> "2h" — a duration at a glance, one unit, no
// decimals. Coarse on purpose: the point is the order of magnitude.
export const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

// 12_430 -> "12.4K", 1_834_219 -> "1.8M" — compact like a status bar, not a spreadsheet
export const fmtCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  return String(n)
}

// A list row is one line on a phone, shared with the harness icon, the age
// and sometimes a workspace tag. Codex titles in particular are whole opening
// prompts, and an untrimmed one pushes everything after it off the end.
export const clipTitle = (t: string, max = 30): string => {
  const flat = t.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

// "how long since this conversation last moved", for list rows. Coarse on
// purpose: the point is to tell yesterday's thread from the one you were in
// ten minutes ago, not to report a duration.
export const timeAgo = (ts: number, now = Date.now()): string => {
  const ms = now - ts
  if (!ts || ms < 0) return ""
  const min = Math.round(ms / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.round(day / 7)
  if (wk < 5) return `${wk}w ago`
  return `${Math.round(day / 30)}mo ago`
}

// display form of a workspace directory: just the folder name
export const fmtWsPath = (dir: string): string => basename(dir)

// full path, but with $HOME folded back to "~" — the browser shows whole
// paths (you need to know where you are) and a phone screen is narrow.
export const fmtHome = (dir: string, home = homedir()): string =>
  dir === home ? "~" : dir.startsWith(home + "/") ? `~${dir.slice(home.length)}` : dir
