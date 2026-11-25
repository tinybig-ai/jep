// Keep going: a conversation that continues by itself until the agent says it
// is finished with `jep-end-turn`.
//
// It is the loop's shape (core/loops.ts) with the stop condition handed to the
// model: an ordinary loop asks "is the goal met?" outside the model, with a
// verifier command or a marker in the reply, because the loop was built on the
// rule that an agent never grades its own work. Keep going gives that up on
// purpose, for asks where writing the check costs more than the work — so it
// buys it back with brakes that do not need the model to agree:
//
//   - a declared stop (`jep-end-turn`) is the only *normal* way out
//   - a deadline: no turn cap to race, but a wall clock that always ends it
//   - a no-progress stop: consecutive turns that ran no tool are a spin, not a
//     long task, and they cost a whole context reload each
//   - turns that open an ask are waiting on the person, not thinking
//
// Everything here is pure, so a client can show the same verdict the daemon
// reached, and the rules can be tested without a harness.
import { loopMarker } from "./transcript.ts"

/** how long a keep going may run before it stops by itself */
export const KEEP_GOING_MAX_MS = 24 * 60 * 60 * 1000
/** consecutive turns that ran no tool before it stops: 1 would end a turn that only thought */
export const KEEP_GOING_IDLE_TURNS = 2
/** the last brake, for when the guards above all miss. Not the intended limit:
 *  the loop marker carries it, so a client can say "turn 12 of 200" */
export const KEEP_GOING_MAX_TURNS = 200

/** how long a question may wait for a person before the agent is told to decide */
export const ASK_EXPIRY_KEEP_MS = 15 * 60 * 1000
export const ASK_EXPIRY_RELENTLESS_MS = 5 * 60 * 1000

/** what a conversation does after a turn: end it (normal), carry on until the
 *  agent says it is done (keep), or carry on whatever the agent says (relentless) */
export type DriveMode = "normal" | "keep" | "relentless"
export const DRIVE_MODES: DriveMode[] = ["normal", "keep", "relentless"]

export type KeepGoingReason =
  /** the agent called `jep-end-turn` */
  | "declared"
  /** out of time */
  | "deadline"
  /** turns that ran no tool: a spin, or waiting on the person without saying so */
  | "idle"
  /** the brake above the brakes */
  | "exhausted"
  | "continue"

export interface KeepGoingFacts {
  /** turns completed, this one included */
  iteration: number
  /** the agent declared itself done this turn */
  declared: boolean
  /** since the keep going began */
  elapsedMs: number
  /** consecutive turns that ran no tool, this one included */
  idleTurns: number
  /** the harness is holding an ask: the agent is waiting on the person */
  waitingOnHuman?: boolean
  /** the agent's word does not end this run, and neither does a quiet turn */
  relentless?: boolean
}

export type KeepGoingVerdict =
  | { done: true; reason: Exclude<KeepGoingReason, "continue"> }
  | { done: false; reason: "continue" }

// A declared stop wins even at the deadline: the point of the mode is that the
// agent's word ends it, and it could not have been earlier than its own turn.
export function keepGoingVerdict(facts: KeepGoingFacts): KeepGoingVerdict {
  const { iteration, declared, elapsedMs, idleTurns, waitingOnHuman = false, relentless = false } = facts
  if (relentless) {
    // Only the person's Stop, the wall clock and the backstop end it. A question
    // never parks it (asks expire), and a turn that ran no tool is pushed, not judged.
    if (elapsedMs >= KEEP_GOING_MAX_MS) return { done: true, reason: "deadline" }
    if (iteration >= KEEP_GOING_MAX_TURNS) return { done: true, reason: "exhausted" }
    return { done: false, reason: "continue" }
  }
  if (declared) return { done: true, reason: "declared" }
  if (elapsedMs >= KEEP_GOING_MAX_MS) return { done: true, reason: "deadline" }
  if (waitingOnHuman) return { done: true, reason: "idle" }
  if (idleTurns >= KEEP_GOING_IDLE_TURNS) return { done: true, reason: "idle" }
  if (iteration >= KEEP_GOING_MAX_TURNS) return { done: true, reason: "exhausted" }
  return { done: false, reason: "continue" }
}

export const keepGoingMaxOf = (max: number | undefined): number => max ?? KEEP_GOING_MAX_TURNS

export function keepGoingHours(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const hrs = mins / 60
  // a day-long run reads better rounded; the first hours of one do not
  return hrs >= 10 ? `${Math.round(hrs)}h` : `${hrs.toFixed(1)}h`
}

/**
 * The words that start a continuation. Everything the previous turn knew may
 * have been folded into a summary, so the request rides along every time — the
 * same reason a loop repeats its goal — and so does the one instruction the
 * mode rests on: nothing stops this conversation but `jep-end-turn`.
 */
export function keepGoingText(input: {
  goal: string
  iteration: number
  max?: number
  elapsedMs?: number
  idleTurns?: number
  /** picked up after a restart, so the last turn was cut off mid-work */
  restarted?: boolean
  relentless?: boolean
  until?: string
}): string {
  const { goal, iteration, max, elapsedMs, idleTurns = 0, restarted = false, relentless = false } = input
  if (relentless) return relentlessText({ goal, iteration, max, elapsedMs, idleTurns, restarted })
  const lines = [loopMarker(iteration, keepGoingMaxOf(max)), `Keep going. Turn ${iteration}.`]
  if (elapsedMs !== undefined) lines[1] += ` Running for ${keepGoingHours(elapsedMs)}.`
  lines.push("", `This is jep: you have not called \`jep-end-turn\`, so this conversation continues. What the person asked:`, "", goal.trim())
  if (input.until?.trim()) lines.push("", keepUntilInstruction(input.until))
  if (restarted) {
    lines.push(
      "",
      "The jep daemon restarted while you were working, so your last turn was cut off. Check what is already done and carry on from there. Do not restart the daemon yourself; if it needs another restart, run `jep-restart` and call `jep-end-turn`.",
    )
  }
  if (idleTurns > 0) {
    lines.push(
      "",
      "Your last turn ran no tool. If you are waiting for the person, or for something outside this machine, call `jep-end-turn` — otherwise make the next change now instead of describing it.",
    )
  }
  lines.push("", ASK_EXPIRY_LINE)
  lines.push(
    "",
    "Either make the next change, or end this now. Call `jep-end-turn` if everything asked for is already done — including when this turn had nothing left to change, when the request was only a question or a reply, or when the last turn already finished it. Every turn you end without calling it starts another, and each one reloads the whole conversation.",
    "",
    "Carry on from where you stopped: no restating the request, no summary of what you will do.",
  )
  return lines.join("\n")
}

/** Shared instruction for the first turn and every continuation. */
export const keepUntilInstruction = (until: string): string =>
  `Keep going until: ${until.trim()}\nUse this as the completion condition for the requested work. Call \`jep-end-turn\` when this condition is met. If it cannot be met, explain the blocker and call \`jep-end-turn\`.`

const ASK_EXPIRY_LINE =
  "Nobody is watching live. A question you ask the person is dropped after a few minutes with no answer: choose the most reasonable option yourself, say what you chose, and go on."

/** the words for the relentless mode: the run does not end because the agent says so */
function relentlessText(input: {
  goal: string
  iteration: number
  max?: number
  elapsedMs?: number
  idleTurns: number
  restarted: boolean
}): string {
  const { goal, iteration, max, elapsedMs, idleTurns, restarted } = input
  const lines = [loopMarker(iteration, keepGoingMaxOf(max)), `Keep going. Turn ${iteration}.`]
  if (elapsedMs !== undefined) lines[1] += ` Running for ${keepGoingHours(elapsedMs)}.`
  lines.push(
    "",
    "This is jep in relentless mode. You cannot end this conversation: `jep-end-turn` does nothing here, and a turn that stops only starts another. Only the person can stop it. What the person asked:",
    "",
    goal.trim(),
  )
  if (restarted) {
    lines.push("", "The jep daemon restarted while you were working, so your last turn was cut off. Check what is already done and carry on from there. Do not restart the daemon yourself; if it needs another restart, run `jep-restart`.")
  }
  if (idleTurns > 0) {
    lines.push("", "Your last turn ran no tool. Describing work is not work: make a change now.")
  }
  lines.push(
    "",
    "Make the result better than it is. Re-read what you built, test it, find what is wrong or missing and fix it. If the request is met, find the next most useful improvement nobody asked for yet: tests, edge cases, rough edges, docs, cleanup, performance. Do not wait for permission.",
    "If you need an answer you do not have, do not stop and do not wait: take the executive decision, record it in your reply, and go on.",
    "",
    ASK_EXPIRY_LINE,
    "",
    "Carry on from where you stopped: no restating the request, no summary of what you will do.",
  )
  return lines.join("\n")
}

/** the note the daemon leaves in the chat when it stops a keep going itself, so
 *  a run that ends alone never just goes quiet */
export function keepGoingStopNote(reason: KeepGoingReason, iteration: number, elapsedMs: number): string {
  const ran = keepGoingHours(elapsedMs)
  const why =
    reason === "deadline"
      ? `it has been going for ${ran}, past the ${keepGoingHours(KEEP_GOING_MAX_MS)} limit, and never called \`jep-end-turn\``
      : reason === "idle"
        ? `${KEEP_GOING_IDLE_TURNS} turns in a row ran no tool, so it was turning in place rather than working`
        : `it reached the ${KEEP_GOING_MAX_TURNS}-turn backstop after ${ran}`
  return [
    `Stopped keeping this conversation going: ${why}.`,
    "",
    `It ran ${iteration} turn${iteration === 1 ? "" : "s"}. Send anything to carry on from here.`,
  ].join("\n")
}
