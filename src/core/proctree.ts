import { execFileSync } from "node:child_process"
import type { ChildProcess } from "node:child_process"

// The processes under a harness's own: the tools it started. A harness waits for its tool before it will
// go on, so a tool that never returns holds the whole turn. Reading and ending that tree is how jep frees
// a turn without ending it, and how a stop ends one that will not leave.

export interface Proc {
  pid: number
  ppid: number
  /** seconds since it started */
  ageS: number
}

/** `ps` elapsed time ("45", "03:21", "2:10:05", "1-02:10:05") in seconds */
export const parseElapsed = (text: string): number => {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text]
  const parts = rest!.split(":").map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, s] = parts as [number, number, number]
  return Number(days) * 86_400 + h * 3600 + m * 60 + s
}

/** every process under `pid`, deepest first */
export function descendants(pid: number): Proc[] {
  let table = ""
  try {
    table = execFileSync("ps", ["-axo", "pid=,ppid=,etime="], { encoding: "utf8", timeout: 3_000 })
  } catch {
    return []
  }
  const kids = new Map<number, Proc[]>()
  for (const line of table.split("\n")) {
    const [c, p, age] = line.trim().split(/\s+/)
    if (!c || !p || !age) continue
    const proc = { pid: Number(c), ppid: Number(p), ageS: parseElapsed(age) }
    kids.set(proc.ppid, [...(kids.get(proc.ppid) ?? []), proc])
  }
  const out: Proc[] = []
  const walk = (n: number) => {
    for (const c of kids.get(n) ?? []) {
      walk(c.pid)
      out.push(c)
    }
  }
  walk(pid)
  return out
}

export const signalAll = (pids: number[], signal: NodeJS.Signals): void => {
  for (const p of pids) {
    try {
      process.kill(p, signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Free a turn stuck on a tool, without ending it: kill what the harness started since `sinceMs` ago
 * (when its last sign of life was). A long-lived helper the harness started at the beginning, such as an
 * extension server, is older than that and is left alone; the stuck tool is not. The harness then sees
 * its tool fail and carries on. Returns whether anything was killed.
 */
export function killStuckTools(harness: ChildProcess | undefined, sinceMs: number, slackS = 10): boolean {
  if (!harness?.pid) return false
  const stuck = descendants(harness.pid).filter((p) => p.ageS <= sinceMs / 1000 + slackS)
  if (!stuck.length) return false
  signalAll(stuck.map((p) => p.pid), "SIGKILL")
  return true
}

/** how long a stopped harness gets to leave on SIGTERM before everything under it is killed outright */
export const STOP_GRACE_MS = 3_000

/**
 * Stop a harness run now. A polite SIGTERM is not enough: it waits for the tool it is running before it
 * will leave. The harness and everything it started get SIGTERM at once (a tool left alive would let it
 * carry on to its next step), and whatever is still there after a short grace is killed outright.
 */
export function stopTree(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  const tree = descendants(pid).map((p) => p.pid)
  child.kill("SIGTERM")
  signalAll(tree, "SIGTERM")
  const timer = setTimeout(() => {
    signalAll([...descendants(pid).map((p) => p.pid), ...tree], "SIGKILL")
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }, STOP_GRACE_MS)
  timer.unref()
  child.once("close", () => clearTimeout(timer))
}
