// Harness recycling: when a long-lived harness server is restarted.
//
// A harness server that lives for days only grows. opencode serve's JS heap is
// never handed back, and a day of turns left it near 800 MB on a 16 GB machine
// that also runs local image and text models. A restart gives a fresh one, but
// a restart taken mid-turn cuts that turn in half, so the rule is strict: the
// server must be big and old, the daemon must have been quiet for a long
// while, and the harness itself must say nothing is running.

/** one harness server, as its adapter measures it */
export interface ServerLoad {
  pid: number
  ageMs: number
  /** resident memory; 0 when it could not be measured */
  rssMB: number
  /** a turn is running on it, or it could not be asked */
  busy: boolean
}

export interface RecycleConfig {
  /** a server at least this big is recycled; 0 turns recycling off */
  maxMB: number
  /** a younger server is left alone, so a big fresh one never restart-loops */
  minAgeMs: number
  /** how long every client must have been quiet */
  quietMs: number
  /** how often the daemon looks */
  tickMs: number
}

const fromEnv = (name: string, fallback: number): number => {
  const n = Number(process.env[name] ?? "")
  return process.env[name] && Number.isFinite(n) && n >= 0 ? n : fallback
}

/** the defaults, each overridable by its env knob */
export const RECYCLE: RecycleConfig = {
  maxMB: fromEnv("JEP_OPENCODE_RECYCLE_MB", 500),
  minAgeMs: (fromEnv("JEP_OPENCODE_RECYCLE_AGE_H", 6) || 6) * 3_600_000,
  quietMs: (fromEnv("JEP_OPENCODE_RECYCLE_QUIET_MIN", 20) || 20) * 60_000,
  tickMs: 10 * 60_000,
}

/**
 * Quiet long enough to consider a recycle at all. Cheap, so a caller asks this
 * before it measures any server.
 * @param quietSince when the last turn or harness event ended, from any client
 */
export function quietEnough(quietSince: number, now: number, config: RecycleConfig): boolean {
  return config.maxMB > 0 && now - quietSince >= config.quietMs
}

/** The server to recycle now, or null. */
export function pickRecycle(loads: ServerLoad[], quietSince: number, now: number, config: RecycleConfig): ServerLoad | null {
  if (!quietEnough(quietSince, now, config)) return null
  return loads.find((s) => !s.busy && s.rssMB >= config.maxMB && s.ageMs >= config.minAgeMs) ?? null
}
