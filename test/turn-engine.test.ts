import test from "node:test"
import assert from "node:assert/strict"
import { TurnEngine, type PendingTurn, type QueueStore, type SavedQueue, type TurnEnv, type TurnResult } from "../src/core/turn-engine.ts"
import { LIVENESS } from "../src/core/liveness.ts"
import { fakeAdapter } from "./support/gateway.ts"
import type { LoopState } from "../src/core/loops.ts"

// The engine with no HTTP in sight: a fake harness and the smallest environment.

/** a queue store that keeps what was saved, as the file does between two daemon runs */
function memoryStore(): QueueStore & { saved: () => SavedQueue } {
  let last: SavedQueue = {}
  return {
    load: () => JSON.parse(JSON.stringify(last)) as SavedQueue,
    save: (queue) => void (last = JSON.parse(JSON.stringify(queue)) as SavedQueue),
    saved: () => last,
  }
}

function engineOf(opts: { prompt?: (text: string) => Promise<void>; queueStore?: QueueStore; driveOf?: TurnEnv["driveOf"]; modelOf?: TurnEnv["modelOf"] } = {}) {
  const base = fakeAdapter()
  const prompts: string[] = []
  const models: Array<PendingTurn["model"]> = []
  const adapter = {
    ...base,
    async prompt(sessionID: string, text: string, options?: { model?: PendingTurn["model"] }) {
      prompts.push(text)
      models.push(options?.model)
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
    ...(opts.driveOf ? { driveOf: opts.driveOf } : {}),
    ...(opts.modelOf ? { modelOf: opts.modelOf } : {}),
    openAsks: () => 0,
    recordChanged: () => {},
    loopChanged: (_all, id) => void changed.push(id),
  }
  const engine = new TurnEngine(env, { liveness: { ...LIVENESS, settleMs: 20 }, loops, ...(opts.queueStore ? { queueStore: opts.queueStore } : {}) })
  return { engine, prompts, models, adapter, changed, loops }
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

test("an error returned by the harness is a failed send, not a successful empty reply", async () => {
  const { engine, adapter } = engineOf()
  adapter.prompt = async (sessionID: string) => ({ id: "m", sessionID, role: "assistant" as const, time: 1, parts: [], error: { name: "CodexError", message: "No prompt provided via stdin" } })
  const p = pending("my screenshot")
  engine.submit("s1", p.turn)
  const result = await p.done
  assert.equal(result.status, 502)
  assert.match(result.error ?? "", /No prompt provided via stdin/)
  assert.equal(result.message, undefined)
  engine.close()
})

test("conversation mode arms a queued prompt without attaching mode to its message", async () => {
  let mode: "normal" | "keep" | "relentless" = "normal"
  let releaseFirst!: () => void
  let releaseSecond!: () => void
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve))
  const r = engineOf({
    driveOf: () => mode,
    prompt: async (text) => {
      if (text === "first") await firstGate
      if (text === "second") await secondGate
    },
  })
  const first = pending("first")
  const second = pending("second")
  r.engine.submit("s1", first.turn)
  await new Promise((resolve) => setTimeout(resolve, 30))
  r.engine.submit("s1", second.turn)
  mode = "relentless"
  r.engine.setDrive("s1", mode)
  releaseFirst()
  await first.done
  for (let i = 0; i < 100 && r.prompts.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(r.prompts, ["first", "second"])
  assert.equal(r.loops.get("s1")?.spec.relentless, true)
  releaseSecond()
  await second.done
  r.engine.stopLoop("s1", "stopped")
  r.engine.close()
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

test("stopping everything holds the queue: nothing is dropped, nothing starts", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { engine, adapter, prompts } = engineOf({ prompt: (text) => (text === "first" ? gate : Promise.resolve()) })
  engine.submit("s1", pending("first").turn)
  await new Promise((r) => setTimeout(r, 30))
  engine.submit("s1", pending("mine", { clientID: "m1" }).turn)
  const stopped = await engine.stop("s1", true, adapter)
  // Stop never throws the queue away, so there is nothing to hand back
  assert.deepEqual(stopped.dropped, [])
  release()
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(engine.queueOf("s1").map((q) => q.clientID), ["m1"], "the queue is still there")
  assert.deepEqual(prompts, ["first"], "and it did not start on its own")
  engine.close()
})

test("the prompt sent after a stop goes first, and the held queue follows it", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { engine, adapter, prompts } = engineOf({ prompt: (text) => (text === "first" ? gate : Promise.resolve()) })
  engine.submit("s1", pending("first").turn)
  await new Promise((r) => setTimeout(r, 30))
  engine.submit("s1", pending("queued one", { clientID: "q1" }).turn)
  await engine.stop("s1", true, adapter)
  release()
  await new Promise((r) => setTimeout(r, 120))
  const next = pending("next")
  engine.submit("s1", next.turn)
  await next.done
  await new Promise((r) => setTimeout(r, 120))
  // waiting prompts run together as one turn, as they do without a stop: the new
  // prompt leads and the held queue follows it
  assert.match(prompts[1] ?? "", /^next[\s\S]*queued one/, "the new prompt is first and the held queue follows it")
  engine.close()
})

test("sending after Stop releases a held Keep Going or Relentless conversation", async (t) => {
  for (const mode of ["keep", "relentless"] as const) {
    await t.test(mode, async () => {
      const r = engineOf({ driveOf: () => mode })
      try {
        const first = pending("old request")
        r.engine.submit("s1", first.turn)
        await first.done
        await r.engine.stop("s1", true, r.adapter)
        const next = pending("new request")
        r.engine.submit("s1", next.turn)
        for (let i = 0; i < 50 && !r.prompts.includes("new request"); i++) await new Promise((resolve) => setTimeout(resolve, 5))
        assert.ok(r.prompts.includes("new request"), "the new message must reach the harness instead of staying held")
        await next.done
        assert.deepEqual(r.prompts.slice(0, 2), ["old request", "new request"])
      } finally {
        r.engine.stopLoop("s1", "stopped")
        r.engine.close()
      }
    })
  }
})

test("automatic continuation uses the conversation's current model", async () => {
  let selected = { providerID: "litellm", modelID: "gpt-6.1-sol" }
  const r = engineOf({ driveOf: () => "keep", modelOf: () => selected })
  try {
    const first = pending("work", { model: selected })
    r.engine.submit("s1", first.turn)
    await first.done
    selected = { providerID: "litellm", modelID: "chatgpt/gpt-5.6-luna" }
    for (let i = 0; i < 100 && r.models.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(r.models.length >= 2)
    assert.deepEqual(r.models[1], selected, "the continuation must not fall back to Pi's previous provider")
  } finally {
    r.engine.stopLoop("s1", "stopped")
    r.engine.close()
  }
})

test("the waiting queue is saved as it changes and comes back after a restart", async () => {
  const store = memoryStore()
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const one = engineOf({ prompt: () => gate, queueStore: store })
  one.engine.submit("s1", pending("running").turn)
  await new Promise((r) => setTimeout(r, 30))
  one.engine.submit("s1", pending("waits for the restart", { clientID: "w1" }).turn)
  assert.deepEqual(store.saved().s1?.waiting.map((p) => p.text), ["waits for the restart"])
  // the daemon goes down: a new engine reads what the old one saved
  one.engine.close()
  release()
  const two = engineOf({ queueStore: store })
  assert.deepEqual(two.engine.queueOf("s1"), [], "nothing runs or shows until the harness is up")
  await two.engine.resumeQueues()
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(two.prompts, ["waits for the restart"])
  two.engine.close()
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

test("a notice runs alone and is not the person's to edit, move or force", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const { engine, prompts } = engineOf({ prompt: (text) => (text === "first" ? gate : Promise.resolve()) })
  engine.submit("s1", pending("first").turn)
  await new Promise((r) => setTimeout(r, 30))
  const mine = pending("what I typed", { clientID: "a" })
  engine.submit("s1", mine.turn)
  // the daemon's own wake-up lands behind their prompt
  engine.enqueue("s1", "<!-- jep:notice done -->\nthe wait is over", { notice: true })
  const notice = engine.queueOf("s1").find((q) => q.notice)!
  assert.match(notice.clientID ?? "", /^notice-/)
  assert.deepEqual(engine.queueOf("s1").map((q) => q.notice), [false, true])
  assert.deepEqual(engine.editQueued("s1", notice.clientID!, "x"), { status: 409, error: "jep's own note cannot be edited" })
  const moved = engine.moveQueued("s1", notice.clientID!, 0)
  assert.ok("error" in moved && moved.status === 409)
  assert.deepEqual(engine.forceQueued("s1", notice.clientID!), { status: 409, error: "jep's own note is not yours to run now" })
  release()
  await mine.done
  // the notice is a turn of its own, never folded into their words
  const deadline = Date.now() + 2_000
  while (prompts.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(prompts, ["first", "what I typed", "<!-- jep:notice done -->\nthe wait is over"])
  engine.close()
})

// A steer folds in at the next boundary: opencode reports step ends, the other harnesses only
// report tool calls, and for them a finished tool call is the boundary.
function steerable(reportsSteps: boolean) {
  const base = fakeAdapter()
  const prompts: string[] = []
  const adapter = {
    ...base,
    ...(reportsSteps ? { reportsSteps: true } : {}),
    async prompt(sessionID: string, text: string, opts?: { signal?: AbortSignal }) {
      prompts.push(text)
      if (text === "first")
        await new Promise<void>((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
      return { id: "m", sessionID, role: "assistant" as const, time: 1, parts: [{ kind: "text" as const, text: `echo: ${text}` }] }
    },
  }
  const env: TurnEnv = {
    adapterOf: () => adapter,
    find: async () => adapter,
    settingsOf: () => undefined,
    openAsks: () => 0,
    recordChanged: () => {},
    loopChanged: () => {},
  }
  const engine = new TurnEngine(env, { liveness: { ...LIVENESS, settleMs: 20 }, loops: new Map() })
  return { engine, prompts, adapter }
}

const toolDone = { type: "part.updated" as const, sessionID: "s1", messageID: "m1", partID: "t1", partType: "tool", part: { kind: "tool" as const, id: "t1", name: "bash", input: {}, output: "ok", status: "completed" as const } }
const stepEnd = { type: "part.updated" as const, sessionID: "s1", messageID: "m1", partID: "f1", partType: "other", part: { kind: "other" as const, nativeType: "step-finish" } }

test("a steer folds in when a tool call finishes, on a harness that reports no steps", async () => {
  const { engine, prompts, adapter } = steerable(false)
  engine.submit("s1", pending("first").turn)
  await new Promise((r) => setTimeout(r, 30))
  engine.submit("s1", pending("second", { steer: true, clientID: "c" }).turn)
  engine.onEvent(toolDone as never, adapter as never)
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(prompts.some((p) => p.includes("second")), `second ran: ${JSON.stringify(prompts)}`)
  engine.close()
})

test("on a harness that reports steps, a finished tool waits for the step to end", async () => {
  const { engine, prompts, adapter } = steerable(true)
  engine.submit("s1", pending("first").turn)
  await new Promise((r) => setTimeout(r, 30))
  engine.submit("s1", pending("second", { steer: true, clientID: "c" }).turn)
  engine.onEvent(toolDone as never, adapter as never)
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(!prompts.some((p) => p.includes("second")), "not before the step ends")
  engine.onEvent(stepEnd as never, adapter as never)
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(prompts.some((p) => p.includes("second")), `second ran: ${JSON.stringify(prompts)}`)
  engine.close()
})
