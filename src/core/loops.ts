import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { loopMarker } from "./transcript.ts"

export { loopMarker, readLoopMarker } from "./transcript.ts"

// A loop is a conversation that keeps going by itself: after every turn a
// verifier decides whether the goal is met, and until it is, jep queues the
// next instruction. The decisions are pure so every client drives the same
// loop; only the turn queue differs (the gateway today, Telegram next).
//
// This is the forced-continuation pattern with the guards the field learned the
// hard way: a machine-checkable stop, a hard turn cap, a verifier that runs
// outside the model, and state that survives compaction because the goal is
// repeated in every continuation.

export interface LoopSpec {
  /** what done looks like, in the user's words — repeated every turn */
  goal: string
  /** total turns, the goal turn included. The cap is the safety net */
  max: number
  /** shell command run in the workspace; exit 0 means done */
  verify?: string
  /** text the reply must contain for done, when there is no command */
  until?: string
}

export interface LoopVerify {
  ok: boolean
  /** the command's exit code, null when it never exited (timeout, signal) */
  code: number | null
  /** the tail of stdout+stderr, ANSI stripped — what the next turn is told */
  output: string
}

export type LoopStatus = "running" | "done" | "exhausted" | "stopped" | "failed"

export interface LoopState {
  sessionID: string
  workspace: string
  spec: LoopSpec
  /** turns completed; the goal turn is 1 */
  iteration: number
  status: LoopStatus
  startedAt: number
  updatedAt: number
  lastVerify?: LoopVerify
  /** why it stopped, when it did not stop because the goal was met */
  error?: string
}

export const LOOP_MIN_TURNS = 1
export const LOOP_MAX_TURNS = 50
export const LOOP_DEFAULT_TURNS = 8
export const LOOP_VERIFY_TIMEOUT_MS = 120_000

const OUTPUT_TAIL = 2000

export type LoopVerdict = { done: boolean; reason: "verified" | "marker" | "exhausted" | "continue" }

/** Whether the just-finished turn closes the loop. `iteration` includes it. */
export function evaluateLoop(input: {
  iteration: number
  spec: LoopSpec
  lastText: string
  verify?: LoopVerify
}): LoopVerdict {
  const { iteration, spec, lastText, verify } = input
  const exhausted = iteration >= spec.max
  if (verify) {
    if (verify.ok) return { done: true, reason: "verified" }
    return exhausted ? { done: true, reason: "exhausted" } : { done: false, reason: "continue" }
  }
  const until = spec.until?.trim()
  if (until) {
    if (lastText.includes(until)) return { done: true, reason: "marker" }
    return exhausted ? { done: true, reason: "exhausted" } : { done: false, reason: "continue" }
  }
  return exhausted ? { done: true, reason: "exhausted" } : { done: false, reason: "continue" }
}

/**
 * The next turn's words. The goal rides along every time, because compaction
 * folds the history the goal first lived in; the verifier's failure is quoted
 * so the turn starts from evidence, not from the model's memory of it.
 */
export function continuationText(state: LoopState, verify?: LoopVerify): string {
  const { spec, iteration } = state
  const lines = [
    loopMarker(iteration, spec.max),
    `Continue the loop. This is turn ${iteration} of ${spec.max}.`,
    "",
    `Goal: ${spec.goal}`,
  ]
  if (verify) {
    const exit = verify.code === null ? "" : ` (exit ${verify.code})`
    lines.push("", `The verifier \`${spec.verify}\` still fails${exit}:`, "```", verify.output || "(no output)", "```")
  } else if (spec.until) {
    lines.push("", `When the goal is fully met, include the exact text ${JSON.stringify(spec.until)} in your reply.`)
  }
  lines.push(
    "",
    "Make the next change that moves the goal forward. Do not restate the goal or the plan. Stop after the change.",
  )
  return lines.join("\n")
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g

const tail = (text: string): string => {
  const clean = text.replace(ANSI, "").trim()
  return clean.length > OUTPUT_TAIL ? `…${clean.slice(-OUTPUT_TAIL)}` : clean
}

/** Run the stop condition the way a person would: in the workspace, with a
 *  ceiling, capturing only the tail the next turn can act on. */
export async function runVerifier(command: string, cwd: string, timeoutMs = LOOP_VERIFY_TIMEOUT_MS): Promise<LoopVerify> {
  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 << 20,
    })
    return { ok: true, code: 0, output: tail(`${stdout}\n${stderr}`) }
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string }
    const code = typeof e.code === "number" ? e.code : null
    const raw = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim()
    const output = raw || (e.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : String(e.message ?? "failed"))
    return { ok: false, code, output: tail(output) }
  }
}

const execFileAsync = promisify(execFile)
