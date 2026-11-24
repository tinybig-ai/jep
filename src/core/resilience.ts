// What keeps a keep-going run alive.
//
// A keep going is a long job with nobody watching the terminal, so the rule is
// the opposite of an ordinary loop's: nothing the world does to it may end it.
// A provider that is down, a daemon that restarted, a socket that dropped, a
// compaction that ran long, a person who typed while it waited — each is a
// pause, not a verdict. Its only endings are the ones that say something about
// the work (core/keepgoing.ts: the agent's own word, the deadline, the idle
// brake, the backstop) and the person's own stop.
//
// Three parts, all decisions with no I/O so they can be tested alone:
//   - how long to wait before trying again (an outage lasts minutes, not seconds)
//   - which failures are the person's to fix (a key, a balance), so the wait
//     says so instead of leaving a spinner that never explains itself
//   - when a loop that is "running" has in fact nothing driving it

/** the first wait; doubles each time, so a blip costs seconds */
export const KEEP_RETRY_BASE_MS = 5_000
/** an outage is waited out, not hammered: the longest single wait */
export const KEEP_RETRY_CAP_MS = 5 * 60_000
/** a key or a balance only changes when a person acts: look less often, tell them */
export const KEEP_RETRY_AUTH_CAP_MS = 10 * 60_000
/** a loop with nothing driving it for this long is repaired */
export const KEEP_ORPHAN_GRACE_MS = 90_000
/** how often the engine looks for such loops */
export const KEEP_SUPERVISE_MS = 30_000
/** after this many failures in a row the chat is told, once, then every so often */
export const KEEP_NOTE_AFTER = 4
export const KEEP_NOTE_EVERY = 12

export type FailureKind = "transient" | "auth"

// A key, a plan or a balance: waiting does not fix it, a person does. Matched on
// the words providers use; anything else is treated as the weather.
const AUTH = /\b(401|402|403)\b|unauthori[sz]ed|invalid[ _-]?(api[ _-]?)?key|api[ _-]?key|authentication|credential|billing|insufficient|quota|credit|payment|forbidden|subscription/i

export function classifyFailure(text: string): FailureKind {
  return AUTH.test(text) ? "auth" : "transient"
}

/**
 * Seconds-to-minutes backoff with jitter. `attempt` counts failures in a row
 * (1 = the first). The jitter keeps nine stalled conversations from all
 * retrying the same second and re-triggering the rate limit that stalled them.
 */
export function keepRetryDelayMs(attempt: number, kind: FailureKind = "transient", rand: () => number = Math.random): number {
  const cap = kind === "auth" ? KEEP_RETRY_AUTH_CAP_MS : KEEP_RETRY_CAP_MS
  const base = Math.min(cap, KEEP_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(base * (1 + 0.2 * rand()))
}

/** whether the chat is told about this failure: the 4th in a row, then every 12th */
export function shouldNoteOutage(attempt: number): boolean {
  return attempt === KEEP_NOTE_AFTER || (attempt > KEEP_NOTE_AFTER && (attempt - KEEP_NOTE_AFTER) % KEEP_NOTE_EVERY === 0)
}

export function outageNote(reason: string, kind: FailureKind, attempt: number, retryInMs: number): string {
  const mins = Math.max(1, Math.round(retryInMs / 60_000))
  const next = retryInMs < 90_000 ? `${Math.round(retryInMs / 1000)}s` : `${mins}m`
  const what = kind === "auth" ? "The model provider is refusing the request, which usually needs a key or a balance fixed" : "The model provider is not answering"
  return [
    `${what} (${attempt} failures in a row: ${reason.slice(0, 160).trim()}).`,
    "",
    `This conversation is still being kept going. It tries again in ${next}, and carries on by itself when the provider answers. Send stop to end it.`,
  ].join("\n")
}

export interface LoopFacts {
  /** the loop's own status */
  status: string
  /** a turn is in flight */
  running: boolean
  /** anything at all is queued behind it */
  waiting: number
  /** a backoff timer is armed */
  retryPending: boolean
  /** ms since the loop's record last changed */
  idleMs: number
}

/**
 * A loop is "running" on paper but nothing will ever run its next turn: no turn
 * in flight, nothing queued, no retry armed. Every path that ends a turn
 * schedules the next one, so this means a path was missed (a timer lost, an
 * exception in the middle of advancing, a person's turn that ended the line).
 * Repairing it here is what makes "survives everything" true of the paths
 * nobody thought of.
 */
export function isOrphaned(f: LoopFacts, graceMs: number = KEEP_ORPHAN_GRACE_MS): boolean {
  return f.status === "running" && !f.running && f.waiting === 0 && !f.retryPending && f.idleMs >= graceMs
}
