import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway } from "../src/clients/gateway/index.ts"
import { startContinuity } from "../src/app/continuity.ts"
import { pair } from "./support/gateway.ts"
import {
  KEEP_GOING_IDLE_TURNS,
  KEEP_GOING_MAX_MS,
  keepGoingStopNote,
  keepGoingText,
  keepGoingVerdict,
} from "../src/core/keepgoing.ts"
import { readLoopMarker } from "../src/core/transcript.ts"

// Keep going (core/keepgoing.ts): a conversation that carries on until the
// agent says it is finished. Nothing outside the model grades the work, so what
// is left to keep it honest is mechanical: its own word, time, and turns that
// ran no tool.

const doneFacts = {
  iteration: 3,
  declared: false,
  elapsedMs: 60_000,
  idleTurns: 0,
}

test("a declared stop ends it even past the deadline", () => {
  assert.deepEqual(keepGoingVerdict({ ...doneFacts, declared: true, elapsedMs: KEEP_GOING_MAX_MS + 1 }), { done: true, reason: "declared" })
})

test("out of time ends it when nothing declared", () => {
  assert.deepEqual(keepGoingVerdict({ ...doneFacts, elapsedMs: KEEP_GOING_MAX_MS }), { done: true, reason: "deadline" })
})

test("turns that ran no tool end it, one short of the limit does not", () => {
  assert.deepEqual(keepGoingVerdict({ ...doneFacts, idleTurns: KEEP_GOING_IDLE_TURNS }), { done: true, reason: "idle" })
  assert.deepEqual(keepGoingVerdict({ ...doneFacts, idleTurns: KEEP_GOING_IDLE_TURNS - 1 }), { done: false, reason: "continue" })
  // one tool-less turn is allowed: thinking before acting is not a spin
  assert.deepEqual(keepGoingVerdict({ ...doneFacts, idleTurns: 1 }), { done: false, reason: "continue" })
})

test("an open ask ends it: it is waiting on the person, not thinking", () => {
  assert.deepEqual(keepGoingVerdict({ ...doneFacts, waitingOnHuman: true }), { done: true, reason: "idle" })
})

test("the continuation repeats the request and names the way out", () => {
  const text = keepGoingText({ goal: "Fix the login redirect", iteration: 4, max: 200, elapsedMs: 90 * 60_000, idleTurns: 1 })
  assert.ok(text.includes("Fix the login redirect"), "the request rides along every turn: compaction folds it away")
  assert.ok(text.includes("jep-end-turn"), "the way out is named every turn, not only in the first header")
  assert.deepEqual(readLoopMarker(text), { iteration: 4, max: 200 })
  assert.match(text, /Turn 4\. Running for 1\.5h/)
  // the failure this is guarding against: an agent that answers again instead
  // of declaring, because "when it is done" is easy to read as later
  assert.ok(text.includes("nothing left to change"), "a no-op turn must be told to end it, not to keep talking")
  assert.ok(text.includes("starts another"), "and told what not declaring costs")
})

test("a turn that ran no tool is told so, and told to stop describing", () => {
  const text = keepGoingText({ goal: "ship it", iteration: 2, idleTurns: 1 })
  assert.match(text, /ran no tool/)
  assert.match(text, /instead of describing it/)
})

test("the completion condition survives continuation and restart instructions", () => {
  const text = keepGoingText({ goal: "fix login", iteration: 4, until: "the login tests pass", restarted: true })
  assert.match(text, /Keep going until: the login tests pass/)
  assert.match(text, /completion condition/)
  assert.match(text, /daemon restarted/)
  assert.doesNotMatch(keepGoingText({ goal: "fix login", iteration: 4, until: "  " }), /Keep going until:/)
  assert.doesNotMatch(keepGoingText({ goal: "fix login", iteration: 4, until: "done", relentless: true }), /Keep going until:/)
})

test("stopping itself leaves a note a person can act on", () => {
  const note = keepGoingStopNote("deadline", 12, 25 * 60 * 60_000)
  assert.match(note, /going for 25h/)
  assert.match(note, /12 turns/)
  assert.match(keepGoingStopNote("idle", 2, 60_000), /turning in place/)
})

// ─── through the daemon ───────────────────────────────────────────────

// A fake that holds every turn until the test lets it end, so a keep going does
// not run a hundred turns before the assertion gets there.
function holding() {
  const calls: string[] = []
  let held: (() => void) | null = null
  const adapter = {
    id: "fake",
    workspace: "/tmp/ws",
    endpoint: "",
    async health() {
      return { healthy: true, version: "0" }
    },
    async createSession() {
      return { id: "s1", title: "Test", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
    },
    async getSession() {
      return { id: "s1", title: "Test", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
    },
    async listSessions() {
      return [{ id: "s1", title: "Test", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }]
    },
    async prompt(_id: string, text: string) {
      calls.push(text)
      await new Promise<void>((r) => {
        held = r
      })
      return {
        id: `m${calls.length}`,
        sessionID: "s1",
        role: "assistant",
        time: 2,
        // a tool ran, so this turn is not counted as one that did nothing
        parts: [
          { kind: "tool" as const, id: "t1", name: "edit", input: {}, output: "ok", status: "completed" as const },
          { kind: "text" as const, text: "done one more step" },
        ],
      }
    },
    async messages() {
      return []
    },
    async abort() {
      held?.()
      return true
    },
    async deleteSession() {
      return true
    },
    async respondAsk() {
      return true
    },
    async rejectAsk() {
      return true
    },
    async *events() {},
    async close() {},
  }
  return {
    calls,
    adapter,
    /** let the turn that is running finish */
    go: (): void => held?.(),
  }
}

const ask = (dataHome: string, req: object) =>
  new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
    const c = net.createConnection(join(dataHome, "control.sock"))
    let buf = ""
    c.on("connect", () => c.write(`${JSON.stringify(req)}\n`))
    c.on("data", (d) => (buf += d.toString()))
    c.on("end", () => resolve(JSON.parse(buf)))
    c.on("error", reject)
  })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!what() && Date.now() < end) await sleep(20)
  assert.ok(what(), `timed out waiting for a condition`)
}

function loopState(dataHome: string): { status: string; iteration: number; error?: string } {
  return JSON.parse(readFileSync(join(dataHome, "gateway-loops.json"), "utf8"))["fake-ws:s1"] ?? JSON.parse(readFileSync(join(dataHome, "gateway-loops.json"), "utf8"))["s1"]
}

async function boot() {
  const dataHome = mkdtempSync(join(tmpdir(), "keepgoing-"))
  const h = holding()
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: h.adapter as never }],
    dataHome,
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  const c = await startContinuity({ dataHome, turns: g.turns })
  const base = `http://127.0.0.1:${g.port}`
  const token = await pair(base, "TESTCODE")
  return {
    base,
    h,
    dataHome,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    close: async () => {
      c.close()
      await g.close()
    },
  }
}

const prompt = async (t: Awaited<ReturnType<typeof boot>>, body: object) =>
  fetch(`${t.base}/prompt`, { method: "POST", headers: t.headers, body: JSON.stringify({ id: "s1", text: "make the change", ...body }) })

test("keep going carries on after the turn ends, and stops when the agent says it is done", { timeout: 30_000 }, async () => {
  const t = await boot()
  try {
    const first = prompt(t, { keep: true })
    await until(() => t.h.calls.length === 1)
    t.h.go()
    assert.equal((await first).status, 200)
    // the turn the person asked for ended; jep started the next one itself
    await until(() => t.h.calls.length === 2)
    assert.match(t.h.calls[1]!, /have not called .jep-end-turn/)
    assert.equal(loopState(t.dataHome).status, "running")

    const said = await ask(t.dataHome, { op: "end-turn", done: true, session: "s1", cwd: process.cwd() })
    assert.equal(said.ok, true)
    t.h.go()
    await until(() => loopState(t.dataHome).status === "done")

    const ran = t.h.calls.length
    await sleep(400)
    assert.equal(t.h.calls.length, ran, "nothing else starts after the agent says it is finished")
  } finally {
    await t.close()
  }
})

test("an ordinary prompt does not keep going: one turn, then quiet", { timeout: 30_000 }, async () => {
  const t = await boot()
  try {
    const first = prompt(t, {})
    await until(() => t.h.calls.length === 1)
    t.h.go()
    assert.equal((await first).status, 200)
    await sleep(400)
    assert.equal(t.h.calls.length, 1)
  } finally {
    await t.close()
  }
})
