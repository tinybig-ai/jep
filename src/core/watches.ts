import { runVerifier, type LoopVerify } from "./loops.ts"

// A watch is how an agent waits for something slow. Under jep a turn is one
// `claude -p` process, and a background job started inside it dies with the
// process, so "tell me when it ends" never arrives. The agent hands the wait
// to the daemon instead: a shell check that exits 0 when the thing is done.
// The daemon polls it, outside any turn, and queues a new turn when it passes
// or runs out of time.

export interface WatchSpec {
  /** shell command run in the workspace; exit 0 means the thing is done */
  check: string
  /** what is being waited for, in the agent's words — told back in the new turn */
  note: string
  everyMs: number
  /** give up after this long and say so */
  maxMs: number
}

export interface WatchRequest {
  check?: unknown
  note?: unknown
  every_seconds?: unknown
  max_minutes?: unknown
}

export const WATCH_MIN_EVERY_MS = 5_000
export const WATCH_DEFAULT_EVERY_MS = 30_000
export const WATCH_DEFAULT_MAX_MS = 60 * 60_000
export const WATCH_CAP_MAX_MS = 24 * 60 * 60_000
/** one session may wait on this many things at once */
export const WATCH_MAX_PER_SESSION = 5

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** The request as the tool received it, made safe; null when there is no check. */
export function parseWatch(req: WatchRequest): WatchSpec | null {
  const check = typeof req.check === "string" ? req.check.trim() : ""
  if (!check) return null
  // A check is a *command*: its first word must be a program. `jep-watch --help`
  // (or --list, or any flag the caller got wrong) used to arrive here as a check,
  // be run as `/bin/sh -c --help`, and hold a watch slot for an hour while the
  // shell printed its own usage. A bare flag is never runnable, so refuse it.
  if (check.startsWith("-")) return null
  const every = Number(req.every_seconds)
  const max = Number(req.max_minutes)
  return {
    check,
    note: (typeof req.note === "string" ? req.note.trim() : "") || check,
    everyMs: Number.isFinite(every) && every > 0 ? clamp(every * 1000, WATCH_MIN_EVERY_MS, WATCH_CAP_MAX_MS) : WATCH_DEFAULT_EVERY_MS,
    maxMs: Number.isFinite(max) && max > 0 ? clamp(max * 60_000, 60_000, WATCH_CAP_MAX_MS) : WATCH_DEFAULT_MAX_MS,
  }
}

export type WatchOutcome = { kind: "done"; verify: LoopVerify } | { kind: "timeout"; verify?: LoopVerify }

/** One look. The check runs in the workspace with the loop verifier's ceiling. */
export async function lookAtWatch(spec: WatchSpec, cwd: string): Promise<LoopVerify> {
  return runVerifier(spec.check, cwd)
}

/** The words of the turn the daemon starts when the wait is over. */
export function watchText(spec: WatchSpec, outcome: WatchOutcome): string {
  const lines = [
    outcome.kind === "done"
      ? `The thing you asked jep to watch has finished: ${spec.note}`
      : `jep stopped watching after ${Math.round(spec.maxMs / 60_000)} min and it had not finished: ${spec.note}`,
    "",
    `Check: \`${spec.check}\``,
  ]
  const out = outcome.verify?.output
  if (out) lines.push("```", out, "```")
  lines.push("", outcome.kind === "done" ? "Carry on from here." : "Look into why, or watch again with a longer time.")
  return lines.join("\n")
}
