import type { WatchSpec } from "./watches.ts"

// A restart of the daemon must not cost anyone their work. Three parts keep it
// safe, and none of them depends on an agent knowing the rules:
//
//   1. `jep-restart` asks the daemon to restart once every turn has ended, so
//      an agent never has to schedule, sleep or poll around its own death.
//   2. A journal of the turns that are running lets the next start pick up the
//      ones a restart (or a crash) cut off.
//   3. Watches are kept on disk, so a restart does not forget what an agent was
//      waiting for.
//
// This file is the pure part: what is written, how it is read back, how long a
// restart may wait. The gateway does the I/O.

export const RESTART_DEFAULT_WAIT_MS = 10 * 60_000
export const RESTART_CAP_WAIT_MS = 60 * 60_000

export interface RestartRequest {
  wait_minutes?: unknown
}

/** how long a requested restart waits for turns to end before it goes ahead anyway */
export function restartWaitMs(req: RestartRequest): number {
  const minutes = typeof req.wait_minutes === "number" && Number.isFinite(req.wait_minutes) ? req.wait_minutes : NaN
  if (!(minutes > 0)) return RESTART_DEFAULT_WAIT_MS
  return Math.min(Math.round(minutes * 60_000), RESTART_CAP_WAIT_MS)
}

/** the turn that picks up where a restart cut one off */
export const RESUME_TEXT =
  "The jep daemon restarted while you were working, so your last turn was cut off. " +
  "Check what is already done and carry on from there. Do not restart the daemon again; " +
  "if it needs another restart, run `jep-restart` and end your turn."

/** a turn that was running: `resume` is true when it was itself a pick-up */
export interface JournalEntry {
  key: string
  resume: boolean
}

export function parseJournal(raw: string): JournalEntry[] {
  try {
    const rows = JSON.parse(raw) as unknown
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row) =>
      row && typeof row === "object" && typeof (row as JournalEntry).key === "string" && (row as JournalEntry).key
        ? [{ key: (row as JournalEntry).key, resume: (row as JournalEntry).resume === true }]
        : [],
    )
  } catch {
    return []
  }
}

/**
 * The conversations to pick up. A turn that was itself a pick-up is not picked
 * up again: if a conversation keeps dying at the same point, a second automatic
 * try would loop, and a person should decide.
 */
export function toResume(entries: JournalEntry[]): string[] {
  return [...new Set(entries.filter((e) => !e.resume).map((e) => e.key))]
}

export interface SavedWatch {
  key: string
  spec: WatchSpec
  startedAt: number
}

export function parseSavedWatches(raw: string): SavedWatch[] {
  try {
    const rows = JSON.parse(raw) as unknown
    if (!Array.isArray(rows)) return []
    return rows.flatMap((row) => {
      const r = row as Partial<SavedWatch> | null
      const s = r?.spec as Partial<WatchSpec> | undefined
      if (!r || typeof r.key !== "string" || !r.key || typeof r.startedAt !== "number" || !s) return []
      if (typeof s.check !== "string" || !s.check || typeof s.note !== "string") return []
      if (typeof s.everyMs !== "number" || typeof s.maxMs !== "number") return []
      return [{ key: r.key, startedAt: r.startedAt, spec: { check: s.check, note: s.note, everyMs: s.everyMs, maxMs: s.maxMs } }]
    })
  } catch {
    return []
  }
}
