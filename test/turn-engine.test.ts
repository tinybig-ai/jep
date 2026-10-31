import test from "node:test"
import assert from "node:assert/strict"
import { TurnEngine, type PendingTurn, type TurnEnv, type TurnResult } from "../src/core/turn-engine.ts"
import { LIVENESS } from "../src/core/liveness.ts"
import { fakeAdapter } from "./support/gateway.ts"
import type { LoopState } from "../src/core/loops.ts"

// The engine with no HTTP in sight: a fake harness and the smallest environment.

function engineOf(opts: { prompt?: (text: string) => Promise<void> } = {}) {
  const base = fakeAdapter()
  const prompts: string[] = []
  const adapter = {
    ...base,
    async prompt(sessionID: string, text: string) {
      prompts.push(text)
      await opts.prompt?.(text)
      return { id: "m", sessionID, role: "assistant" as const, time: 1, parts: [{ kind: "text" as const, text: `echo: ${text}` }] }
    },
  }
  const loops = new Map<string, LoopState>()
  const changed: string[] = []
  const env: TurnEnv = {
    adapterOf: () => adapter,
    find: async () => adapter,
    settingsOf: () => undefined,
    openAsks: () => 0,
    recordChanged: () => {},
    loopChanged: (_all, id) => void changed.push(id),
  }
  const engine = new TurnEngine(env, { liveness: { ...LIVENESS, settleMs: 20 }, loops })
  return { engine, prompts, adapter, changed }
}

const pending = (text: string, extra: Partial<PendingTurn> = {}): { turn: PendingTurn; done: Promise<TurnResult> } => {
  let resolve!: (r: TurnResult) => void
  const done = new Promise<TurnResult>((r) => (resolve = r))
  return { turn: { text, filePaths: [], steer: false, resolve, ...extra }, done }
}

test("a submitted prompt runs and its answer comes back", async () => {
  const { engine, prompts } = engineOf()
  const p = pending("hello")
  engine.submit("s1", p.turn)
  const result = await p.done
  assert.equal(result.status, 200)
  assert.deepEqual(prompts, ["hello"])
  engine.close()
})

test("prompts that wait behind a running turn run together as one", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { engine, prompts } = engineOf({ prompt: (text) => (text === "first" ? gate : Promise.resolve()) })
  const first = pending("first")
  engine.submit("s1", first.turn)
  await new Promise((r) => setTimeout(r, 30))
  const a = pending("second", { clientID: "a" })
  const b = pending("third", { clientID: "b" })
  engine.submit("s1", a.turn)
  engine.submit("s1", b.turn)
  assert.deepEqual(engine.queueOf("s1").map((q) => q.clientID), ["a", "b"])
  assert.equal(engine.isBusy("s1"), true)
  release()
  await Promise.all([first.done, a.done, b.done])
  assert.equal(prompts.length, 2, "the two waiting prompts ran as one turn")
  assert.match(prompts[1]!, /second[\s\S]*third/)
  engine.close()
})

test("a queued prompt can be cancelled, edited and moved until it runs", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { engine } = engineOf({ prompt: (text) => (text === "first" ? gate : Promise.resolve()) })
  engine.submit("s1", pending("first").turn)
  await new Promise((r) => setTimeout(r, 30))
  const a = pending("a", { clientID: "a" })
  const b = pending("b", { clientID: "b" })
  engine.submit("s1", a.turn)
  engine.submit("s1", b.turn)
  assert.deepEqual(engine.editQueued("s1", "a", "  "), { status: 400, error: "text required" })
  assert.equal(engine.editQueued("s1", "a", "a2"), null)
  assert.deepEqual(engine.cancelQueued("s1", "nope"), { status: 404, error: "not queued" })
  const moved = engine.moveQueued("s1", "b", 0)
  assert.ok("queue" in moved && moved.queue[0]?.clientID === "b")
  assert.deepEqual(engine.moveQueued("s1", "b", "x"), { status: 400, error: "to required" })
  assert.equal(engine.cancelQueued("s1", "a"), null)
  assert.equal((await a.done).cancelled, true)
  release()
  engine.close()
})

test("the daemon's services see what the engine runs, and a turn it cuts off at shutdown", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { engine } = engineOf({ prompt: () => gate })
  const events: string[] = []
  engine.observe({ started: (k) => events.push(`start ${k}`), ended: (k, cutOff) => events.push(`end ${k} ${cutOff}`) })
  engine.submit("s1", pending("x").turn)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(engine.busy(), 1)
  engine.close()
  assert.equal(engine.closing(), true)
  release()
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(events, ["start s1", "end s1 true"])
})

test("stopping a loop takes back what it queued", async () => {
  const { engine, changed } = engineOf()
  const loop: LoopState = { sessionID: "s1", workspace: "/tmp", spec: { goal: "g", max: 3 }, iteration: 0, status: "running", startedAt: 1, updatedAt: 1 }
  const first = pending("g", { loop: true })
  engine.startLoop(loop, first.turn)
  await first.done
  assert.equal(engine.loopOf("s1")?.status, "running")
  const stopped = engine.stopLoopByPerson("s1")
  assert.equal(stopped?.status, "stopped")
  assert.ok(changed.includes("s1"), "clients are told to read it again")
  engine.close()
})
