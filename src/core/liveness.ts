// Turn liveness: when a turn that has gone quiet is given up on.
//
// A turn has no absolute deadline — a real agent turn can work for half an
// hour, and any fixed ceiling eventually cuts one off mid-task. What ends one
// is inactivity, judged here, in one place, for every client. It used to be
// written twice (Telegram and the gateway), and the copies drifted: only one of
// them ever learned to give up on a wedged tool.

export interface LivenessConfig {
  /** a turn waiting on tokens that says nothing for this long has stalled */
  turnIdleMs: number
  /** while a tool runs: builds and test runs are legitimately silent for minutes */
  toolIdleMs: number
  /** a tool running this long with no event at all is wedged, not working —
   *  opencode's bash hanging on a launchctl child, a git op on a dead remote.
   *  Streaming output resets the idle clock, so a busy tool never trips it. */
  wildernessMs: number
  /** after the harness says the session is idle, how long the blocking prompt
   *  call gets to return before the turn is finalized from what streamed */
  idleGraceMs: number
  /** how often a watchdog looks */
  tickMs: number
}

const fromEnv = (name: string, fallback: number): number => Number(process.env[name] ?? "") || fallback

/** the defaults, each overridable by its env knob */
export const LIVENESS: LivenessConfig = {
  turnIdleMs: fromEnv("JEP_TURN_IDLE_MS", 5 * 60_000),
  toolIdleMs: fromEnv("JEP_TOOL_IDLE_MS", 20 * 60_000),
  wildernessMs: fromEnv("JEP_TOOL_WILDERNESS_MS", 6 * 60_000),
  idleGraceMs: 5_000,
  tickMs: 15_000,
}

export interface RunningTool {
  name: string
  /** when the harness says it started, if it says */
  startedAt?: number
}

export type Verdict =
  | { stalled: false }
  | {
      stalled: true
      elapsedMs: number
      ceilingMs: number
      /** the tool to name: the wedged one, else the longest-running */
      tool?: string
      /** set when a tool was given up on as wedged, with how long it had run */
      wedgedMs?: number
    }

/**
 * Has this turn stalled? `lastActivity` is the last event of any kind on the
 * session; `waitingOnHuman` is a pending ask, which is never a stall — the turn
 * is being polite, and no ceiling applies until it is answered.
 */
export function judgeTurn(opts: {
  now: number
  lastActivity: number
  waitingOnHuman: boolean
  tools: RunningTool[]
  config?: LivenessConfig
}): Verdict {
  const cfg = opts.config ?? LIVENESS
  if (opts.waitingOnHuman) return { stalled: false }
  const elapsed = opts.now - opts.lastActivity
  let ceiling = opts.tools.length > 0 ? cfg.toolIdleMs : cfg.turnIdleMs
  let tool: string | undefined
  let wedgedMs: number | undefined
  let oldest = Infinity
  for (const t of opts.tools) {
    const started = t.startedAt ?? Infinity
    if (started < oldest) {
      oldest = started
      tool = t.name
    }
  }
  if (tool === undefined && opts.tools.length > 0) tool = opts.tools[0]!.name
  for (const t of opts.tools) {
    if (typeof t.startedAt !== "number") continue
    const age = opts.now - t.startedAt
    if (age >= cfg.wildernessMs && elapsed >= cfg.wildernessMs) {
      ceiling = Math.min(ceiling, cfg.wildernessMs)
      tool = t.name
      wedgedMs = age
      break
    }
  }
  if (elapsed < ceiling) return { stalled: false }
  return { stalled: true, elapsedMs: elapsed, ceilingMs: ceiling, ...(tool ? { tool } : {}), ...(wedgedMs !== undefined ? { wedgedMs } : {}) }
}
