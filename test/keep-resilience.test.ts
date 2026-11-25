// A keep going survives what the world does to it (core/resilience.ts and the
// turn engine): failures in a row far past an ordinary loop's budget, a person
// typing in the middle of an outage, a loop that lost the step that would run
// its next turn. Its only endings are the agent's word, the clock, the idle
// brake and the person's stop.

import test from "node:test"
import assert from "node:assert/strict"
import { TurnEngine, type PendingTurn, type TurnEnv, type TurnResult } from "../src/core/turn-engine.ts"
import { LIVENESS } from "../src/core/liveness.ts"
import { fakeAdapter } from "./support/gateway.ts"
import type { LoopState } from "../src/core/loops.ts"
import {
  KEEP_RETRY_AUTH_CAP_MS,
  KEEP_RETRY_CAP_MS,
  classifyFailure,
  isOrphaned,
  keepRetryDelayMs,
  outageNote,
  shouldNoteOutage,
} from "../src/core/resilience.ts"

// ── the policy, with no engine ───────────────────────────────────────────

test("backoff grows to minutes and stops there", () => {
  const none = () => 0
  assert.equal(keepRetryDelayMs(1, "transient", none), 5_000)
  assert.equal(keepRetryDelayMs(2, "transient", none), 10_000)
  assert.equal(keepRetryDelayMs(6, "transient", none), 160_000)
  assert.equal(keepRetryDelayMs(7, "transient", none), KEEP_RETRY_CAP_MS)
  assert.equal(keepRetryDelayMs(500, "transient", none), KEEP_RETRY_CAP_MS)
  assert.equal(keepRetryDelayMs(500, "auth", none), KEEP_RETRY_AUTH_CAP_MS)
})

test("jitter stays within a fifth, so stalled conversations do not retry in step", () => {
  assert.equal(keepRetryDelayMs(1, "transient", () => 1), 6_000)
  for (let i = 0; i < 50; i++) {
    const d = keepRetryDelayMs(3, "transient")
    assert.ok(d >= 20_000 && d <= 24_000, String(d))
  }
})

test("a key or a balance is told apart from the weather", () => {
  for (const t of ["401 Unauthorized", "invalid api key", "You exceeded your current quota", "HTTP 403", "insufficient credits", "billing hard limit"]) {
    assert.equal(classifyFailure(t), "auth", t)
  }
  for (const t of ["Connection error.", "socket hang up", "502 Bad Gateway", "rate limited", "ECONNRESET", "no activity for 5m"]) {
    assert.equal(classifyFailure(t), "transient", t)
  }
})

test("the chat hears of an outage once it is not a blip, then rarely", () => {
  const told = [1, 2, 3, 4, 5, 15, 16, 28, 40].filter(shouldNoteOutage)
  assert.deepEqual(told, [4, 16, 28, 40])
  const note = outageNote("Connection error.", "transient", 4, 40_000)
  assert.match(note, /still being kept going/)
  assert.match(note, /Connection error\./)
  assert.match(outageNote("401", "auth", 4, 600_000), /key or a balance/)
})

test("a loop with nothing driving it is found, and a busy one is not", () => {
  const idle = { status: "running", running: false, waiting: 0, retryPending: false, idleMs: 120_000 }
  assert.equal(isOrphaned(idle), true)
  assert.equal(isOrphaned({ ...idle, running: true }), false)
  assert.equal(isOrphaned({ ...idle, waiting: 1 }), false)
  assert.equal(isOrphaned({ ...idle, retryPending: true }), false)
  assert.equal(isOrphaned({ ...idle, idleMs: 5_000 }), false)
  assert.equal(isOrphaned({ ...idle, status: "done" }), false)
})

// ── the engine ───────────────────────────────────────────────────────────

function rig(prompt: (text: string, n: number) => Promise<void>, extra: Partial<ConstructorParameters<typeof TurnEngine>[1]> = {}, policy: Partial<TurnEnv> = {}) {
  const base = fakeAdapter()
  const prompts: string[] = []
  const adapter = {
    ...base,
    async prompt(sessionID: string, text: string) {
      prompts.push(text)
      await prompt(text, prompts.length)
      return { id: "m" + prompts.length, sessionID, role: "assistant" as const, time: 1, parts: [{ kind: "tool" as const, tool: "bash", status: "completed" as const, input: {}, output: "" } as never, { kind: "text" as const, text: "ok" }] }
    },
  }
  const loops = new Map<string, LoopState>()
  const env: TurnEnv = {
    adapterOf: () => adapter,
    find: async () => adapter,
    settingsOf: () => undefined,
    openAsks: () => 0,
    recordChanged: () => {},
    loopChanged: () => {},
    ...policy,
  }
  const engine = new TurnEngine(env, { liveness: { ...LIVENESS, settleMs: 15 }, loops, retryDelayMs: () => 15, ...extra })
  const turn = (text: string, more: Partial<PendingTurn> = {}): PendingTurn => ({ text, filePaths: [], steer: false, resolve: () => {}, ...more })
  const until = async (ok: () => boolean, ms = 3000) => {
    const t = Date.now()
    while (!ok()) {
      if (Date.now() - t > ms) assert.fail(`timed out; prompts so far: ${JSON.stringify(prompts.map((p) => p.slice(0, 40)))}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { engine, prompts, loops, turn, until }
}

test("a keep going outlasts failures far past an ordinary loop's three tries", async () => {
  // declares done on the first turn that gets through
  let r!: ReturnType<typeof rig>
  r = rig(async (_t, n) => {
    if (n <= 8) throw new Error("Connection error.")
    r.engine.declareDone("s1")
  })
  r.engine.submit("s1", r.turn("do the work", { keepGoing: true }))
  await r.until(() => r.loops.get("s1")?.status === "done")
  assert.equal(r.prompts.length, 9)
  assert.equal(r.loops.get("s1")?.retryAt, undefined)
  r.engine.close()
})

test("the wait is visible: the reason and the next try are on the loop", async () => {
  let r!: ReturnType<typeof rig>
  r = rig(async (_t, n) => {
    if (n === 1) throw new Error("socket hang up")
    r.engine.declareDone("s1")
  }, { retryDelayMs: () => 400 })
  r.engine.submit("s1", r.turn("go", { keepGoing: true }))
  await r.until(() => r.loops.get("s1")?.retryAt != null)
  const loop = r.loops.get("s1")!
  assert.match(loop.error ?? "", /socket hang up/)
  assert.ok(loop.retryAt! > Date.now() - 50)
  await r.until(() => loop.status === "done")
  r.engine.close()
})

test("a person typing during an outage does not end the run", async () => {
  let r!: ReturnType<typeof rig>
  r = rig(async (text, n) => {
    if (n === 1) throw new Error("Connection error.")
    if (/Keep going/.test(text)) r.engine.declareDone("s1")
  }, { retryDelayMs: () => 120 })
  r.engine.submit("s1", r.turn("do the work", { keepGoing: true }))
  await r.until(() => r.loops.get("s1")?.retryAt != null)
  r.engine.submit("s1", r.turn("how is it going?"))
  await r.until(() => r.loops.get("s1")?.status === "done")
  assert.equal(r.prompts[1], "how is it going?")
  assert.match(r.prompts.at(-1)!, /^.*Keep going/s)
  r.engine.close()
})

test("their message in the middle of a turn is answered, then the run carries on", async () => {
  let r!: ReturnType<typeof rig>
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  r = rig(async (text, n) => {
    if (n === 1) await gate
    if (/Keep going/.test(text)) r.engine.declareDone("s1")
  })
  r.engine.submit("s1", r.turn("do the work", { keepGoing: true }))
  await r.until(() => r.prompts.length === 1)
  r.engine.submit("s1", r.turn("one more thing"))
  release()
  await r.until(() => r.loops.get("s1")?.status === "done")
  assert.equal(r.prompts[1], "one more thing")
  assert.match(r.prompts[2]!, /Keep going/)
  r.engine.close()
})

test("a loop that lost its next step is found and given one", async () => {
  let r!: ReturnType<typeof rig>
  r = rig(async () => { r.engine.declareDone("s1") }, { superviseMs: 20, orphanGraceMs: 40 })
  // running on paper, with nothing queued, running or armed: how a lost timer or a missed path leaves it
  r.loops.set("s1", {
    sessionID: "s1",
    workspace: "/tmp/ws",
    spec: { goal: "finish the thing", max: 200, stop: "tool" },
    iteration: 3,
    status: "running",
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
  })
  await r.until(() => r.loops.get("s1")?.status === "done")
  assert.match(r.prompts[0]!, /Keep going\. Turn 3/)
  r.engine.close()
})

test("stop ends a keep going even when it is the person's own turn that is running", async () => {
  let r!: ReturnType<typeof rig>
  let release!: () => void
  const gate = new Promise<void>((res) => (release = res))
  r = rig(async (text, n) => {
    if (n === 1) throw new Error("Connection error.")
    if (text === "mine") await gate
  }, { retryDelayMs: () => 5_000 })
  r.engine.submit("s1", r.turn("do the work", { keepGoing: true }))
  await r.until(() => r.loops.get("s1")?.retryAt != null)
  r.engine.submit("s1", r.turn("mine"))
  await r.until(() => r.prompts.includes("mine"))
  await r.engine.stop("s1", false, fakeAdapter())
  assert.equal(r.loops.get("s1")?.status, "stopped")
  assert.equal(r.loops.get("s1")?.retryAt, undefined)
  release()
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(r.prompts.filter((p) => /Keep going/.test(p)).length, 0)
  r.engine.close()
})

// ── a restart that cannot ask is not a conversation that is gone ──────────

function restartRig(exists: (id: string, ws: string) => Promise<"yes" | "no" | "unknown">, stop: "tool" | "none" = "tool", found = true) {
  const base = fakeAdapter()
  const prompts: string[] = []
  const adapter = {
    ...base,
    async prompt(sessionID: string, text: string) {
      prompts.push(text)
      return { id: "m", sessionID, role: "assistant" as const, time: 1, parts: [{ kind: "text" as const, text: "ok" }] }
    },
  }
  const loops = new Map<string, LoopState>()
  loops.set("s1", {
    sessionID: "s1",
    workspace: "/tmp/ws",
    spec: { goal: "finish it", max: 200, ...(stop === "tool" ? { stop } : {}) },
    iteration: 2,
    status: "running",
    startedAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
  })
  const env: TurnEnv = {
    adapterOf: () => adapter,
    find: async () => (found ? adapter : null),
    exists,
    settingsOf: () => undefined,
    openAsks: () => 0,
    recordChanged: () => {},
    loopChanged: () => {},
  }
  const engine = new TurnEngine(env, { liveness: { ...LIVENESS, settleMs: 15 }, loops, retryDelayMs: () => 30 })
  return { engine, loops, prompts }
}

test("a harness that cannot answer yet does not end the run: it waits and resumes", async () => {
  const r = restartRig(async () => "unknown")
  const resumed = await r.engine.resumeLoops()
  assert.deepEqual(resumed, ["s1"])
  assert.equal(r.loops.get("s1")?.status, "running")
  assert.ok(r.loops.get("s1")?.retryAt)
  assert.match(r.loops.get("s1")?.error ?? "", /could not be looked up/)
  await new Promise((res) => setTimeout(res, 150))
  assert.ok(r.prompts.some((p) => /Keep going/.test(p)), "the turn ran once the wait was over")
  r.engine.close()
})

test("only a conversation every harness denies is gone", async () => {
  const r = restartRig(async () => "no")
  assert.deepEqual(await r.engine.resumeLoops(), [])
  assert.equal(r.loops.get("s1")?.status, "failed")
  assert.match(r.loops.get("s1")?.error ?? "", /conversation is gone/)
  r.engine.close()
})

test("a conversation that is there resumes at once, with the restart explained", async () => {
  const r = restartRig(async () => "yes")
  assert.deepEqual(await r.engine.resumeLoops(), ["s1"])
  await new Promise((res) => setTimeout(res, 60))
  assert.match(r.prompts[0]!, /restarted/)
  r.engine.close()
})

test("an ordinary loop keeps the old lookup", async () => {
  const r = restartRig(async () => "unknown", "none", false)
  assert.deepEqual(await r.engine.resumeLoops(), [])
  assert.equal(r.loops.get("s1")?.status, "failed")
  r.engine.close()
})

import { keepGoingVerdict, keepGoingText, KEEP_GOING_IDLE_TURNS } from "../src/core/keepgoing.ts"
import { driveOf, withDrive, nextDrive } from "../src/core/settings.ts"

test("relentless: the agent's word and quiet turns do not end it", () => {
  const facts = { iteration: 3, declared: true, elapsedMs: 1000, idleTurns: KEEP_GOING_IDLE_TURNS, waitingOnHuman: true }
  assert.equal(keepGoingVerdict(facts).done, true)
  assert.equal(keepGoingVerdict({ ...facts, relentless: true }).done, false)
  assert.equal(keepGoingVerdict({ ...facts, relentless: true, elapsedMs: 25 * 3600_000 }).done, true)
})

test("relentless text says the agent cannot stop and to decide alone", () => {
  const t = keepGoingText({ goal: "ship it", iteration: 2, relentless: true })
  assert.match(t, /relentless/)
  assert.match(t, /executive decision/)
  assert.match(keepGoingText({ goal: "x", iteration: 2 }), /dropped after a few minutes/)
})

test("the mode cycles normal -> keep -> relentless and keeps the old flags meaning", () => {
  assert.equal(driveOf({ keep_going: true }), "keep")
  assert.equal(driveOf(withDrive(undefined, "relentless")), "relentless")
  assert.equal(driveOf(withDrive({ keep_going: true, relentless: true }, "normal")), "normal")
  assert.deepEqual(["normal", "keep", "relentless"].map((m) => nextDrive(m as never)), ["keep", "relentless", "normal"])
})

test("jep-end-turn is refused in a relentless run", async () => {
  const r = rig(async () => {}, {})
  const loop: LoopState = { sessionID: "s1", workspace: "/w", spec: { goal: "g", max: 200, stop: "tool" as const, relentless: true }, iteration: 1, status: "running", startedAt: Date.now(), updatedAt: Date.now() }
  r.loops.set("s1", loop)
  assert.deepEqual(r.engine.declareDone("s1"), { keeping: true, declared: false, relentless: true })
})

test("Keep going reads a changed condition on the next turn, and clearing it removes it", async (t) => {
  let condition = "the login tests pass"
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let r!: ReturnType<typeof rig>
  r = rig(async (_text, n) => {
    if (n === 1) await gate
    else r.engine.declareDone("s1")
  }, {}, { keepUntilOf: () => condition })
  t.after(() => r.engine.close())
  r.engine.submit("s1", r.turn("fix login", { keepGoing: true }))
  await r.until(() => r.prompts.length === 1)
  assert.match(r.prompts[0]!, /Keep going until: the login tests pass/)
  r.engine.declareDone("s1") // completion under the old condition is now stale
  condition = "the browser login works"
  r.engine.setDrive("s1", "keep")
  assert.equal(r.loops.get("s1")?.spec.keepUntil, condition)
  release()
  await r.until(() => r.loops.get("s1")?.status === "done")
  assert.match(r.prompts[1]!, /Keep going until: the browser login works/)
  assert.doesNotMatch(r.prompts[1]!, /the login tests pass/)
  condition = ""
  r.engine.submit("s1", r.turn("one more fix", { keepGoing: true }))
  await r.until(() => r.prompts.length >= 3)
  assert.doesNotMatch(r.prompts[2]!, /Keep going until:/)
})
