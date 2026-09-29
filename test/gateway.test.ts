import test from "node:test"
import assert from "node:assert/strict"
import { positiveInt, restartWhenQuiet, revokeGatewayTokens, startGateway, type GatewayHandle } from "../src/clients/gateway/index.ts"
import type { HarnessAdapter } from "../src/core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../src/core/types.ts"
import { TurnAbortedError } from "../src/core/types.ts"
import { JEP_CONTEXT, JEP_CONTEXT_FOOTER } from "../src/core/transcript.ts"
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A fake driven adapter: enough of the port for the gateway's surface —
// listings, history, one streamed turn, an ask to answer. No network, no
// harness, so the tests run in milliseconds.
function fakeAdapter(): HarnessAdapter {
  const session: SessionSummary = { id: "s1", title: "Test", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
  return {
    id: "fake",
    workspace: "/tmp/ws",
    endpoint: "",
    async health() {
      return { healthy: true, version: "0" }
    },
    async createSession() {
      return session
    },
    async getSession(id: string) {
      return id === "s1" ? session : null
    },
    async listSessions() {
      return [session]
    },
async prompt(_sessionID, text) {
      const message: Message = {
        id: "m1",
        sessionID: "s1",
        role: "assistant",
        time: 2,
        parts: [{ kind: "text", text: `echo: ${text}` }],
      }
      return message
    },
    async deleteSession() {
      return true
    },
    async messages() {
      return [{ id: "m0", sessionID: "s1", role: "user", time: 1, parts: [{ kind: "text", text: "hi" }] }]
    },
    async abort() {
      return true
    },
    async respondAsk() {
      return true
    },
    async rejectAsk() {
      return true
    },
    async *events() {
      yield { type: "message.created", sessionID: "s1", messageID: "m1", role: "assistant" } as DomainEvent
      yield { type: "part.delta", sessionID: "s1", messageID: "m1", partID: "p1", text: "hel" } as DomainEvent
    },
    async close() {},
  }
}

function spawnGateway(): { gw: Promise<GatewayHandle> } {
  const adapter = fakeAdapter()
  return {
    gw: startGateway({
      adapters: () => [{ name: "fake-ws", adapter }],
      dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
      port: 0,
      pairCode: "TESTCODE",
      pairLimit: 100,
    }),
  }
}

async function pair(base: string, code: string): Promise<string> {
  const res = await fetch(`${base}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  assert.equal(res.status, 200)
  const { token } = (await res.json()) as { token: string }
  return token
}

// A turn that stays in flight until released or aborted, and an event feed a
// test can push into — enough to exercise the queue, steering and force.
function stallable() {
  const releases = new Map<string, () => void>()
  const pendingEvents: DomainEvent[] = []
  let wakeFeed: (() => void) | null = null
  const calls: string[] = []
  const base = fakeAdapter()
  const adapter: HarnessAdapter = {
    ...base,
    async prompt(_id, text, opts) {
      calls.push(text)
      // only the turn that is meant to stay in flight waits; the rest answer at once
      if (text === "first") {
        await new Promise<void>((resolve, reject) => {
          releases.set(text, resolve)
          opts?.signal?.addEventListener("abort", () => reject(new TurnAbortedError()), { once: true })
        })
      }
      return {
        id: `m-${text}`,
        sessionID: "s1",
        role: "assistant",
        time: 2,
        parts: [{ kind: "text", text: `echo: ${text}` }],
      } as Message
    },
    async *events(signal?: AbortSignal) {
      while (!signal?.aborted) {
        if (pendingEvents.length === 0) {
          await Promise.race([
            new Promise<void>((r) => { wakeFeed = r }),
            new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true })),
          ])
        }
        if (signal?.aborted) return
        while (pendingEvents.length) yield pendingEvents.shift()!
      }
    },
  }
  return {
    adapter,
    calls,
    release: (text: string) => releases.get(text)?.(),
    feed: (e: DomainEvent) => {
      pendingEvents.push(e)
      wakeFeed?.()
      wakeFeed = null
    },
  }
}

async function startWith(
  a: ReturnType<typeof stallable>,
  workspace = a.adapter.workspace,
  liveness?: { turnIdleMs?: number; toolIdleMs?: number; idleGraceMs?: number; tickMs?: number },
): Promise<{ base: string; headers: Record<string, string>; g: GatewayHandle; dataHome: string }> {
  const dataHome = mkdtempSync(join(tmpdir(), "gw-q-"))
  const g = await startGateway({
    // the workspace the served roots are built from, so a test can point the
    // adapter at a real directory when resolution matters
    adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace } }],
    dataHome,
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
    ...(liveness ? { liveness } : {}),
  })
  const base = `http://127.0.0.1:${g.port}`
  const token = await pair(base, "TESTCODE")
  return { base, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, g, dataHome }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const textOf = (j: { message?: Message }) => (j.message?.parts[0] as { text?: string } | undefined)?.text

test("a prompt sent mid-turn is queued, not refused, and runs when the turn ends", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    const post = (text: string, force = false) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text, force }) })
    const first = post("first")
    await sleep(50)
    const second = post("second")
    await sleep(50)
    assert.deepEqual(a.calls, ["first"], "the second waits rather than starting or being refused")
    a.release("first")
    const j1 = (await (await first).json()) as { message?: Message }
    const j2 = (await (await second).json()) as { message?: Message }
    assert.equal(textOf(j1), "echo: first")
    assert.equal(textOf(j2), "echo: second")
    assert.deepEqual(a.calls, ["first", "second"])
  } finally {
    await g.close()
  }
})

test("a waiting prompt steers in at the next step boundary", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    const post = (text: string) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text }) })
    const first = post("first")
    await sleep(50)
    const second = post("second")
    await sleep(50)
    // the running turn reaches a tool boundary with something waiting: superseded
    a.feed({ type: "part.updated", sessionID: "s1", messageID: "m1", partID: "p1", partType: "step-finish", part: { kind: "other", nativeType: "step-finish" } } as DomainEvent)
    const j1 = (await (await first).json()) as { aborted?: boolean }
    assert.equal(j1.aborted, true, "the running turn is stopped")
    a.release("second")
    const j2 = (await (await second).json()) as { message?: Message }
    assert.equal(textOf(j2), "echo: second")
  } finally {
    await g.close()
  }
})

test("a forced prompt aborts the running turn and runs now", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    const post = (text: string, force = false) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text, force }) })
    const first = post("first")
    await sleep(50)
    const forced = post("second", true)
    const j1 = (await (await first).json()) as { aborted?: boolean }
    assert.equal(j1.aborted, true)
    a.release("second")
    const j2 = (await (await forced).json()) as { message?: Message }
    assert.equal(textOf(j2), "echo: second")
  } finally {
    await g.close()
  }
})

test("a queued prompt can be cancelled before it runs", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    const post = (text: string, extra: Record<string, unknown> = {}) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text, ...extra }) })
    const first = post("first")
    await sleep(50)
    const second = post("second", { clientID: "c2" })
    await sleep(50)
    const cancel = await fetch(`${base}/queue/cancel`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "s1", clientID: "c2" }),
    })
    assert.equal(cancel.status, 200)
    const j2 = (await (await second).json()) as { cancelled?: boolean }
    assert.equal(j2.cancelled, true, "the held request is answered as cancelled")
    assert.deepEqual(a.calls, ["first"], "the cancelled prompt never ran")
    a.release("first")
    await first
  } finally {
    await g.close()
  }
})

test("a prompt asked to wait for the end is not steered in", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    const post = (text: string, steer = true) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text, steer }) })
    const first = post("first")
    await sleep(50)
    const second = post("second", false)
    await sleep(50)
    // a tool boundary arrives, but this prompt asked to wait: nothing is aborted
    a.feed({ type: "part.updated", sessionID: "s1", messageID: "m1", partID: "p1", partType: "step-finish", part: { kind: "other", nativeType: "step-finish" } } as DomainEvent)
    await sleep(50)
    assert.deepEqual(a.calls, ["first"], "the running turn is left alone")
    a.release("first")
    const j1 = (await (await first).json()) as { message?: Message }
    assert.equal(textOf(j1), "echo: first")
    const j2 = (await (await second).json()) as { message?: Message }
    assert.equal(textOf(j2), "echo: second")
  } finally {
    await g.close()
  }
})

test("a queued prompt can be forced to run now", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    const post = (text: string, extra: Record<string, unknown> = {}) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text, ...extra }) })
    const first = post("first")
    await sleep(50)
    const second = post("second", { clientID: "c2" })
    await sleep(50)
    const force = await fetch(`${base}/queue/force`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "s1", clientID: "c2" }),
    })
    assert.equal(force.status, 200)
    const j1 = (await (await first).json()) as { aborted?: boolean }
    assert.equal(j1.aborted, true, "the running turn is stopped")
    const j2 = (await (await second).json()) as { message?: Message }
    assert.equal(textOf(j2), "echo: second")
  } finally {
    await g.close()
  }
})

// ── turn liveness ────────────────────────────────────────────────────────────
// Every gateway turn runs with no absolute deadline, so these are the only
// things that end a turn whose harness went quiet. Without them a stalled turn
// stayed "running" forever and every prompt behind it waited with it — the bug
// that had the phone's stop button as its only cure.
const FAST = { turnIdleMs: 120, toolIdleMs: 600, idleGraceMs: 40, tickMs: 20 }

test("the watchdog ends a turn whose harness went silent, and says so", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a, a.adapter.workspace, FAST)
  try {
    const first = fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    // nothing is fed: no events at all, which is exactly the stall
    const j = (await (await first).json()) as { error?: string }
    assert.match(j.error ?? "", /no activity for/, "the stall names itself instead of reading as a stop")
  } finally {
    await g.close()
  }
})

test("a stalled turn releases the queue behind it", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a, a.adapter.workspace, FAST)
  try {
    const post = (text: string) =>
      fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text }) })
    const first = post("first")
    await sleep(20)
    const second = post("second")
    // the stalled turn is given up on, and the prompt waiting behind it runs
    const j2 = (await (await second).json()) as { message?: Message }
    assert.equal(textOf(j2), "echo: second", "the queue is not pinned by a dead turn")
    await first
    assert.deepEqual(a.calls, ["first", "second"])
  } finally {
    await g.close()
  }
})

test("session.error ends the turn in the harness's own words", async () => {
  const a = stallable()
  // ceilings far out of reach: the event, not a timeout, must be what ends this
  const { base, headers, g } = await startWith(a, a.adapter.workspace, { ...FAST, turnIdleMs: 60_000 })
  try {
    const first = fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    await sleep(50)
    a.feed({ type: "session.error", sessionID: "s1", message: "every candidate model failed" } as DomainEvent)
    const j = (await (await first).json()) as { error?: string }
    assert.equal(j.error, "every candidate model failed")
  } finally {
    await g.close()
  }
})

test("a named provider failure beats a silent stall", async () => {
  const a = stallable()
  // the adapter knows why the turn died — opencode logged a usage cap that never
  // reached the event stream — so the watchdog must report that, not "no activity"
  const withError: ReturnType<typeof stallable> = {
    ...a,
    adapter: {
      ...a.adapter,
      providerError: () => ({ name: "AI_APICallError", message: "Go usage limit exceeded", provider: "opencode-go", model: "glm-5.3-flash" }),
    },
  }
  const { base, headers, g } = await startWith(withError, withError.adapter.workspace, FAST)
  try {
    const first = fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    const j = (await (await first).json()) as { error?: string }
    assert.match(j.error ?? "", /Go usage limit exceeded/)
    assert.match(j.error ?? "", /opencode-go\/glm-5\.3-flash/, "the failure names the endpoint that produced it")
    assert.doesNotMatch(j.error ?? "", /no activity/, "a known cause is never reported as an unexplained stall")
  } finally {
    await g.close()
  }
})

test("session.idle finalizes a turn whose prompt() hangs, from the transcript", async () => {
  const a = stallable()
  const finished: Message = { id: "m9", sessionID: "s1", role: "assistant", time: 9, parts: [{ kind: "text", text: "all done" }] }
  const withRecord: ReturnType<typeof stallable> = {
    ...a,
    adapter: { ...a.adapter, async messages() { return [finished] } },
  }
  // the ceiling is unreachable: session.idle plus the grace period is what ends this
  const { base, headers, g } = await startWith(withRecord, withRecord.adapter.workspace, { ...FAST, turnIdleMs: 60_000 })
  try {
    const first = fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    await sleep(50)
    // the harness says the turn is over while the blocking POST never returns
    a.feed({ type: "session.idle", sessionID: "s1" } as DomainEvent)
    const j = (await (await first).json()) as { message?: Message; aborted?: boolean; error?: string }
    assert.equal(textOf(j), "all done", "a finished turn reads as success, not as a stop")
    assert.ok(!j.aborted && !j.error)
  } finally {
    await g.close()
  }
})

test("a turn parked on a permission ask is not a stalled turn", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a, a.adapter.workspace, FAST)
  try {
    const first = fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    await sleep(20)
    a.feed({
      type: "ask.requested",
      sessionID: "s1",
      ask: { id: "ask1", sessionID: "s1", title: "Run rm -rf?", options: [{ id: "yes", label: "Yes" }] },
    } as DomainEvent)
    let settled = false
    void first.then(() => { settled = true })
    // well past turnIdleMs: waiting on a human is not stalling
    await sleep(300)
    assert.equal(settled, false, "the watchdog holds its fire while the ask is unanswered")
    // answering hands the turn back to the model, and the clock starts again
    await fetch(`${base}/respond`, { method: "POST", headers, body: JSON.stringify({ askID: "ask1", optionID: "yes" }) })
    const j = (await (await first).json()) as { error?: string; aborted?: boolean }
    assert.match(j.error ?? "", /no activity for/, "once answered, an unresponsive turn is subject to the ceiling again")
  } finally {
    await g.close()
  }
})

test("a running tool buys the longer ceiling", async () => {
  const a = stallable()
  // turnIdleMs would have killed this several times over; the tool ceiling holds
  const { base, headers, g } = await startWith(a, a.adapter.workspace, { ...FAST, turnIdleMs: 60, toolIdleMs: 60_000 })
  try {
    const first = fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    await sleep(20)
    a.feed({
      type: "part.updated",
      sessionID: "s1",
      messageID: "m1",
      partID: "t1",
      partType: "tool",
      part: { kind: "tool", id: "t1", name: "bash", input: {}, output: null, status: "running", startedAt: Date.now() },
    } as DomainEvent)
    await sleep(250)
    let settled = false
    void first.then(() => { settled = true })
    await sleep(50)
    assert.equal(settled, false, "a silent but running tool is working, not wedged")
    a.release("first")
    const j = (await (await first).json()) as { message?: Message }
    assert.equal(textOf(j), "echo: first")
  } finally {
    await g.close()
  }
})

test("pair gates: wrong code rejected, right code yields a working token", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const base = `http://127.0.0.1:${g.port}`
    const bad = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: "nope" }) })
    assert.equal(bad.status, 403)
    const token = await pair(base, "TESTCODE")
    const unauthed = await fetch(`${base}/sessions`, { method: "POST" })
    assert.equal(unauthed.status, 401)
    const authed = await fetch(`${base}/sessions`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
    assert.equal(authed.status, 200)
  } finally {
    await g.close()
  }
})

test("agents come from the adapter, and an unknown id is refused", async () => {
  const adapter = fakeAdapter()
  adapter.agents = async () => [
    { id: "build", label: "Build", default: true },
    { id: "plan", label: "Plan" },
  ]
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const list = (await (
      await fetch(`${base}/agents`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    ).json()) as { agents: Array<{ id: string }>; default: string | null }
    assert.deepEqual(
      list.agents.map((a) => a.id),
      ["build", "plan"],
    )
    assert.equal(list.default, "build")

    // an id the harness doesn't offer is refused rather than stored, so it
    // can't fail the next turn
    const bad = await fetch(`${base}/setagent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "s1", agent: "nope" }),
    })
    assert.equal(bad.status, 400)

    const ok = await fetch(`${base}/setagent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "s1", agent: "plan" }),
    })
    assert.equal(ok.status, 200)
  } finally {
    await g.close()
  }
})

test("the gateway reports its pairing state through the admin port", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const before = g.pairingAdmin.status()
    assert.equal(before.client, "gateway")
    assert.equal(before.code, "TESTCODE")
    assert.equal(before.owner, null)
    assert.equal(before.devices, 0)
    assert.equal(before.port, g.port, "the port a pairing QR needs")

    let changes = 0
    g.pairingAdmin.onChange = () => {
      changes++
    }
    await pair(`http://127.0.0.1:${g.port}`, "TESTCODE")

    const after = g.pairingAdmin.status()
    assert.equal(after.devices, 1)
    assert.notEqual(after.code, "TESTCODE", "pairing spends the code")
    assert.ok(changes >= 1, "spending the code notifies the aggregate writer")
  } finally {
    await g.close()
  }
})

test("sessions merge adapter names; history replays from the harness", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const res = await fetch(`${base}/sessions`, { method: "POST", headers: { authorization: `Bearer ${token}` } })
    const { items } = (await res.json()) as { items: Array<{ id: string; adapter: string }> }
    assert.equal(items.length, 1)
    assert.equal(items[0]?.adapter, "fake-ws")
    const history = await fetch(`${base}/history`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "s1" }),
    })
    const { messages, hasMore } = (await history.json()) as { messages: Message[]; hasMore: boolean }
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.parts[0]?.kind, "text")
    assert.equal(hasMore, false)
  } finally {
    await g.close()
  }
})

test("history strips jep's injected context, showing what the user typed", async () => {
  const adapter = fakeAdapter()
  const injected = `${JEP_CONTEXT}\n\n${JEP_CONTEXT_FOOTER}\n\nfix the reddit bug`
  adapter.messages = async () => [
    { id: "u0", sessionID: "s1", role: "user", time: 1, parts: [{ kind: "text", text: injected }] },
    { id: "a1", sessionID: "s1", role: "assistant", time: 2, parts: [{ kind: "text", text: "on it" }] },
  ]
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const res = await fetch(`${base}/history`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "s1" }),
    })
    const { messages } = (await res.json()) as { messages: Message[] }
    assert.equal(messages.length, 2)
    const first = messages[0]!.parts[0]!
    assert.equal(first.kind, "text")
    assert.equal(first.kind === "text" ? first.text : "", "fix the reddit bug")
  } finally {
    await g.close()
  }
})

test("subagents lists a conversation's children under `items`, like /sessions", async () => {
  const adapter = fakeAdapter()
  adapter.subagents = async () => [{ id: "s2", title: "Sub", workspace: "/tmp/ws", createdAt: 3, updatedAt: 4 }]
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const res = await fetch(`${base}/subagents`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    // the shape is the client's contract — `items`, exactly as /sessions. A
    // silent mismatch here once made the app say "no subagents" while the
    // list showed one.
    const body = (await res.json()) as { items: SessionSummary[] }
    assert.deepEqual(Object.keys(body), ["items"])
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0]?.id, "s2")
  } finally {
    await g.close()
  }
})

test("subagents is an empty list when the harness has no such notion", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const res = await fetch(`${base}/subagents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "s1" }),
    })
    const body = (await res.json()) as { items: SessionSummary[] }
    assert.deepEqual(body.items, [])
  } finally {
    await g.close()
  }
})

test("history pages the newest limit; before walks older windows; hasMore flips", async () => {
  const adapter = fakeAdapter()
  const history: Message[] = []
  for (let i = 0; i < 5; i++) {
    history.push({ id: `m${i}`, sessionID: "s1", role: i === 0 ? "user" : "assistant", time: i + 1, parts: [{ kind: "text", text: `msg ${i}` }] })
  }
  adapter.messages = async () => history
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const first = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1", limit: 2 }) })
    const page1 = (await first.json()) as { messages: Message[]; hasMore: boolean }
    assert.deepEqual(page1.messages.map((m) => m.id), ["m3", "m4"])
    assert.equal(page1.hasMore, true)
    const second = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1", limit: 2, before: page1.messages[0]!.time }) })
    const page2 = (await second.json()) as { messages: Message[]; hasMore: boolean }
    assert.deepEqual(page2.messages.map((m) => m.id), ["m1", "m2"])
    assert.equal(page2.hasMore, true)
    const third = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1", limit: 2, before: page2.messages[0]!.time }) })
    const page3 = (await third.json()) as { messages: Message[]; hasMore: boolean }
    assert.deepEqual(page3.messages.map((m) => m.id), ["m0"])
    assert.equal(page3.hasMore, false)
  } finally {
    await g.close()
  }
})

test("prompt resolves to the harness's final message; a double prompt is 409", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const res = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "hi" }) })
    assert.equal(res.status, 200)
    const { message } = (await res.json()) as { message: Message }
    assert.equal(message.role, "assistant")
  } finally {
    await g.close()
  }
})

test("rename overlays a client-side title; delete removes; attach feeds the next prompt", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

    const renamed = await fetch(`${base}/rename`, { method: "POST", headers, body: JSON.stringify({ id: "s1", title: "My Chat" }) })
    assert.equal(renamed.status, 200)
    const sess = await fetch(`${base}/sessions`, { method: "POST", headers })
    const { items } = (await sess.json()) as { items: Array<{ id: string; title: string }> }
    assert.equal(items[0]?.title, "My Chat")

    const up = await fetch(`${base}/attach?id=s1&name=screen.png`, { method: "POST", headers, body: new Uint8Array([1, 2, 3, 4]) })
    assert.equal(up.status, 200)
    const { id: attachID } = (await up.json()) as { id: string }
    const promptRes = await fetch(`${base}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: "s1", text: "look", files: [attachID] }),
    })
    assert.equal(promptRes.status, 200)

    const del = await fetch(`${base}/delete`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    assert.equal(del.status, 200)
  } finally {
    await g.close()
  }
})

test("workspaces list, /new selects the named one, and a set model flows into the prompt", async () => {
  const a = fakeAdapter()
  const b = fakeAdapter()
  // give the second adapter its own identity so selection is observable
  ;(b as { id: string }).id = "other"
  let createdIn = ""
  a.createSession = async () => {
    createdIn = "a"
    return { id: "sa", title: "", workspace: "a-ws", createdAt: 1, updatedAt: 1 }
  }
  b.createSession = async () => {
    createdIn = "b"
    return { id: "sb", title: "", workspace: "b-ws", createdAt: 1, updatedAt: 1 }
  }
  let promptedModel: { providerID: string; modelID: string } | undefined
  b.prompt = async (_id, text, opts) => {
    promptedModel = opts?.model
    return { id: "m1", sessionID: "sb", role: "assistant", time: 1, parts: [{ kind: "text", text }] }
  }
  b.models = async () => [{ providerID: "open", modelID: "big" }]
  const g = await startGateway({
    adapters: () => [{ name: "a-ws", adapter: a }, { name: "b-ws", adapter: b }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

    const ws = await fetch(`${base}/workspaces`, { method: "POST", headers })
    const { items } = (await ws.json()) as { items: Array<{ name: string; harness: string }> }
    assert.deepEqual(items, [
      { name: "a-ws", harness: "fake", dir: "/tmp/ws" },
      { name: "b-ws", harness: "other", dir: "/tmp/ws" },
    ])

    // creation-time selection: naming the workspace picks its adapter
    const nw = await fetch(`${base}/new`, { method: "POST", headers, body: JSON.stringify({ workspace: "b-ws" }) })
    const { session } = (await nw.json()) as { session: SessionSummary }
    assert.equal(createdIn, "b")
    assert.equal(session.id, "sb")

    const models = await fetch(`${base}/models`, { method: "POST", headers, body: JSON.stringify({ id: "sb" }) })
    const before = (await models.json()) as { models: Array<{ modelID: string }>; current: string | null }
    assert.equal(before.current, null)
    assert.equal(before.models[0]?.modelID, "big")

    await fetch(`${base}/setmodel`, { method: "POST", headers, body: JSON.stringify({ id: "sb", model: "open/big" }) })
    const after = await fetch(`${base}/models`, { method: "POST", headers, body: JSON.stringify({ id: "sb" }) })
    assert.equal(((await after.json()) as { current: string | null }).current, "open/big")

    await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "sb", text: "hi" }) })
    assert.deepEqual(promptedModel, { providerID: "open", modelID: "big" })
  } finally {
    await g.close()
  }
})

test("agent, usage, diff and model capabilities ride the gateway", async () => {
  const a = fakeAdapter()
  a.models = async () => [
    { providerID: "open", modelID: "vision" },
    { providerID: "open", modelID: "plain" },
  ]
  a.capabilities = async () =>
    new Map([["open/vision", { image: true, attachment: true, contextLimit: 200_000 }]])
  a.defaultModel = async () => "open/vision"
  a.diff = async () => [{ file: "src/a.ts", additions: 3, deletions: 1, status: "modified" as const }]
  a.messages = async () => [
    {
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      time: 1,
      parts: [],
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
      cost: 0.02,
      model: "open/vision",
    },
  ]
  let promptedAgent: string | undefined
  a.prompt = async (_id, text, opts) => {
    promptedAgent = opts?.agent
    return { id: "m1", sessionID: "s1", role: "assistant", time: 1, parts: [{ kind: "text", text }] }
  }
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

    type Models = { models: Array<{ modelID: string; image: boolean; contextLimit: number }>; default: string | null }
    const md = (await (
      await fetch(`${base}/models`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    ).json()) as Models
    assert.equal(md.default, "open/vision")
    assert.equal(md.models.find((m) => m.modelID === "vision")?.image, true)
    assert.equal(md.models.find((m) => m.modelID === "vision")?.contextLimit, 200_000)
    assert.equal(md.models.find((m) => m.modelID === "plain")?.image, false)

    await fetch(`${base}/setagent`, { method: "POST", headers, body: JSON.stringify({ id: "s1", agent: "plan" }) })
    const ag = (await (await fetch(`${base}/agent`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })).json()) as { current: string | null }
    assert.equal(ag.current, "plan")
    await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "hi" }) })
    assert.equal(promptedAgent, "plan")

    const usage = (await (
      await fetch(`${base}/usage`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    ).json()) as { usage: { turns: number; input: number; cost: number } }
    assert.equal(usage.usage.turns, 1)
    assert.equal(usage.usage.input, 10)
    assert.equal(usage.usage.cost, 0.02)

    const diff = (await (
      await fetch(`${base}/diff`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    ).json()) as { files: Array<{ file: string }> }
    assert.equal(diff.files[0]?.file, "src/a.ts")
  } finally {
    await g.close()
  }
})

test("harnesses, a bounded directory browse, and /new spawning a workspace by path", async () => {
  const a = fakeAdapter()
  let added: string | null = null
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    harnesses: () => ({ ids: ["fake", "other"], default: "fake" }),
    addWorkspace: async (dir, harness) => {
      added = `${dir}:${harness}`
      return { name: "added", adapter: a }
    },
    browseRoot: "/tmp",
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }

    const hs = (await (
      await fetch(`${base}/harnesses`, { method: "POST", headers, body: "{}" })
    ).json()) as { harnesses: string[]; default: string }
    assert.deepEqual(hs.harnesses, ["fake", "other"])
    assert.equal(hs.default, "fake")

    // "/etc" is above the /tmp root, so it is clamped — the browser can't wander
    const br = (await (
      await fetch(`${base}/browse`, { method: "POST", headers, body: JSON.stringify({ path: "/etc" }) })
    ).json()) as { cwd: string; root: string; dirs: unknown[] }
    assert.equal(br.cwd, "/tmp")
    assert.ok(Array.isArray(br.dirs))

    const nw = (await (
      await fetch(`${base}/new`, { method: "POST", headers, body: JSON.stringify({ path: "/tmp/newdir", harness: "other" }) })
    ).json()) as { session: SessionSummary }
    assert.equal(added, "/tmp/newdir:other")
    assert.equal(nw.session.id, "s1")
  } finally {
    await g.close()
  }
})

test("history asks the harness for a window, never the whole conversation", async () => {
  // A forked conversation of 3151 messages is 199 MB, and fetching, parsing and
  // mapping all of it to serve 30 messages is what kept taking the daemon down.
  const asked: Array<number | undefined> = []
  const inner = fakeAdapter()
  const a: HarnessAdapter = {
    ...inner,
    async messages(id: string, opts?: { limit?: number }) {
      asked.push(opts?.limit)
      return inner.messages(id)
    },
  }
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const hist = (body: Record<string, unknown>) =>
      fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify(body) })

    await hist({ id: "s1", limit: 30 })
    // an older page says how much the phone already holds: one window, not all
    await hist({ id: "s1", limit: 30, before: 1, have: 30 })
    assert.deepEqual(asked, [31, 61])
  } finally {
    await g.close()
  }
})

test("/mkdir creates a folder under the browse root, and only there", async () => {
  const root = mkdtempSync(join(tmpdir(), "gw-mkdir-"))
  const g = await startGateway({
    adapters: () => [],
    browseRoot: root,
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const mk = (body: Record<string, unknown>) =>
      fetch(`${base}/mkdir`, { method: "POST", headers, body: JSON.stringify(body) })

    assert.equal((await mk({ name: "fresh" })).status, 200)
    assert.ok(existsSync(join(root, "fresh")))

    // the same name twice is a conflict, not a silent success
    assert.equal((await mk({ name: "fresh" })).status, 409)
    // a slash would escape the level it was asked for
    assert.equal((await mk({ name: "a/b" })).status, 400)
    assert.equal((await mk({ name: "" })).status, 400)
    // and the root bound holds: /etc is outside it
    assert.equal((await mk({ path: "/etc", name: "jep-should-not-exist" })).status, 403)
    assert.equal(existsSync("/etc/jep-should-not-exist"), false)
  } finally {
    await g.close()
  }
})

test("an archived conversation leaves the list and appears under /archived", async () => {
  const a = fakeAdapter()
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const post = async (path: string, body: Record<string, unknown> = {}) =>
      ((await (await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) })).json()) as {
        items?: SessionSummary[]
      })

    assert.equal((await post("/sessions")).items?.length, 1)
    await post("/archive", { id: "s1" })
    assert.equal((await post("/sessions")).items?.length, 0)
    const filed = await post("/archived")
    assert.equal(filed.items?.length, 1)
    assert.equal(filed.items?.[0]?.id, "s1")
    await post("/unarchive", { id: "s1" })
    assert.equal((await post("/sessions")).items?.length, 1)
    assert.equal((await post("/archived")).items?.length, 0)
  } finally {
    await g.close()
  }
})

test("a pinned conversation leads the list whatever its age", async () => {
  const older: SessionSummary = { id: "old", title: "Older", workspace: "/tmp/ws", createdAt: 1, updatedAt: 10 }
  const newer: SessionSummary = { id: "new", title: "Newer", workspace: "/tmp/ws", createdAt: 1, updatedAt: 999 }
  const a = fakeAdapter()
  const adapter = { ...a, listSessions: async () => [newer, older] }
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-pin-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    type Row = SessionSummary & { pinned?: boolean }
    const post = async (path: string, body: Record<string, unknown> = {}) =>
      ((await (await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) })).json()) as {
        items?: Row[]
        pinned?: boolean
      })

    // untouched: newest first
    assert.deepEqual((await post("/sessions")).items?.map((s) => s.id), ["new", "old"])

    assert.equal((await post("/pin", { id: "old" })).pinned, true)
    // the pin outranks recency: the older conversation leads now
    const pinnedList = (await post("/sessions")).items ?? []
    assert.deepEqual(pinnedList.map((s) => s.id), ["old", "new"])
    assert.equal(pinnedList[0]?.pinned, true)
    assert.equal(pinnedList[1]?.pinned, false)

    await post("/unpin", { id: "old" })
    assert.deepEqual((await post("/sessions")).items?.map((s) => s.id), ["new", "old"])
  } finally {
    await g.close()
  }
})

test("/compact advances to the harness and 501s when it isn't offered", async () => {
  const a = fakeAdapter()
  const calls: string[] = []
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const post = async (path: string) =>
      await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })

    // no adapter-declared compact: the control is hidden, not broken — 501 says so
    assert.equal((await post("/compact")).status, 501)

    a.compact = async (sessionID) => {
      calls.push(sessionID)
      return true
    }
    const ok = await post("/compact")
    assert.equal(ok.status, 200)
    assert.deepEqual(calls, ["s1"])

    // a harness refusing (a turn mid-flight) is a 409, not a 500
    a.compact = async () => false
    assert.equal((await post("/compact")).status, 409)

    // A summarize that ran out of time is not a refusal: reporting it as one
    // sent the phone chasing a harness that had done nothing wrong.
    a.compact = async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    }
    const slow = await post("/compact")
    assert.equal(slow.status, 504)
    assert.match(((await slow.json()) as { error?: string }).error ?? "", /took too long/)
  } finally {
    await g.close()
  }
})

test("/new asking for a second harness on a served workspace spawns it", async () => {
  const a = fakeAdapter() // name "a-ws", harness "fake", dir /tmp/ws
  let added: string | null = null
  const g = await startGateway({
    adapters: () => [{ name: "a-ws", adapter: a }],
    addWorkspace: async (dir, harness) => {
      added = `${dir}:${harness}`
      return { name: "a-ws", adapter: a }
    },
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    // a-ws is served by "fake"; asking for it under "other" must not 400
    const res = await fetch(`${base}/new`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspace: "a-ws", harness: "other" }),
    })
    assert.equal(res.status, 200)
    assert.equal(added, "/tmp/ws:other")
  } finally {
    await g.close()
  }
})

test("import goes through the port, and only offers sessions in served dirs", async () => {
  const a = fakeAdapter() // workspace /tmp/ws
  let forked: string | null = null
  const g = await startGateway({
    adapters: () => [{ name: "a-ws", adapter: a }],
    import: {
      harness: "opencode",
      list: async () => [
        { harness: "opencode", id: "keep", title: "Keep", dir: "/tmp/ws", updatedAt: 2 },
        { harness: "opencode", id: "drop", title: "Drop", dir: "/elsewhere", updatedAt: 1 },
      ],
      fork: async (id) => {
        forked = id
        return { ok: true, dir: "/tmp/ws" }
      },
    },
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const list = await fetch(`${base}/importable`, { method: "POST", headers, body: "{}" })
    const { sessions } = (await list.json()) as { sessions: Array<{ id: string; harness: string }> }
    assert.deepEqual(sessions.map((s) => s.id), ["keep"])
    assert.equal(sessions[0]?.harness, "opencode")
    const res = await fetch(`${base}/import`, { method: "POST", headers, body: JSON.stringify({ id: "keep" }) })
    assert.equal(res.status, 200)
    assert.equal(forked, "keep")
  } finally {
    await g.close()
  }
})

test("the terminal goes through the port (policy stays in the gateway)", async () => {
  const a = fakeAdapter() // workspace /tmp/ws
  const calls: string[] = []
  const prev = process.env.JEP_TERMINAL
  process.env.JEP_TERMINAL = "1"
  const g = await startGateway({
    adapters: () => [{ name: "a-ws", adapter: a }],
    terminal: {
      open: async (_id, dir) => {
        calls.push(`open:${dir}`)
      },
      frame: async () => "screen-here",
      send: async (_id, input) => {
        calls.push(`send:${input.key ?? input.text}`)
      },
      close: async () => {
        calls.push("close")
      },
    },
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    // pairing spends the code, so capture the fresh one for the unlock
    const paired = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: "TESTCODE" }) })
    const { token, nextCode } = (await paired.json()) as { token: string; nextCode: string }
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    // gated: a device token alone can't open a shell
    const locked = await fetch(`${base}/term/open`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    assert.equal(locked.status, 403)
    await fetch(`${base}/term/unlock`, { method: "POST", headers, body: JSON.stringify({ code: nextCode }) })
    const open = await fetch(`${base}/term/open`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    assert.equal(open.status, 200)
    const framed = (await (
      await fetch(`${base}/term/frame`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    ).json()) as { text: string }
    assert.equal(framed.text, "screen-here")
    await fetch(`${base}/term/input`, { method: "POST", headers, body: JSON.stringify({ id: "s1", key: "Enter" }) })
    assert.ok(calls.some((c) => c.startsWith("open:")), `open not called: ${calls}`)
    assert.ok(calls.includes("send:Enter"), `send not called: ${calls}`)
  } finally {
    await g.close()
    if (prev === undefined) delete process.env.JEP_TERMINAL
    else process.env.JEP_TERMINAL = prev
  }
})

test("the push feed carries harness events to every connected device", async () => {
  const { gw } = spawnGateway()
  const g = await gw
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    // start two devices, both authenticated
    const dead = await fetch(`${base}/stream?token=${token}`)
    const live = await fetch(`${base}/stream?token=${token}`)
    const deadReader = dead.body!.getReader()
    // device one disconnects mid-stream — the harness keeps running, and the
    // pump keeps feeding device two. This is the decoupling promise: client
    // connectivity never throttles or stops the machine side.
    await deadReader.read()
    deadReader.releaseLock()

    const reader = live.body!.getReader()
    let seen = ""
    const deadline = Date.now() + 3000
    while (!seen.includes("part.delta") && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      seen += new TextDecoder().decode(value)
    }
    assert.ok(seen.includes('"message.created"'), `push feed missing events, got: ${seen.slice(0, 200)}`)
    assert.ok(seen.includes('"part.delta"'), `push feed missing deltas, got: ${seen.slice(0, 200)}`)
    assert.equal(seen.split('"part.delta"').length, 2, "device two should still get events after the other left")

    // and the turn factory is untouched by the disconnect: prompt still works
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const res = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "hi" }) })
    assert.equal(res.status, 200)
  } finally {
    await g.close()
  }
})

test("a restart's quiet window and cap are clamped, never NaN", () => {
  // the route parses these from the query string or the JSON body, so a typo
  // must not produce a NaN timer (which never fires) or an unbounded wait
  const cases: [string | null, number, number, number][] = [
    ["10", 5, 1, 60], // query/body value
    [null, 5, 1, 60], // absent -> default
    ["0", 5, 1, 60], // zero -> default
    ["-3", 5, 1, 60], // negative -> default
    ["abc", 5, 1, 60], // junk -> default
    ["9999", 5, 1, 60], // clamped to hi
    ["1", 5, 1, 60], // at lo
    ["7.4", 5, 1, 60], // rounded
  ]
  for (const [raw, fallback, lo, hi] of cases) {
    const got = positiveInt(raw, fallback, lo, hi)
    assert.equal(Number.isFinite(got), true, `${raw} must not produce NaN`)
    assert.ok(got >= lo && got <= hi, `${raw} -> ${got} must be within [${lo},${hi}]`)
  }
})

test("an ask is answered by its own id, with no session id — what the phone sends", async () => {
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  try {
    // the pump surfaces the ask and remembers which session it belongs to
    a.feed({
      type: "ask.requested",
      sessionID: "s1",
      ask: {
        id: "per_ask1",
        sessionID: "s1",
        title: "external_directory",
        detail: "ls /etc",
        options: [{ id: "always", label: "Always allow" }],
      },
    } as DomainEvent)
    await sleep(60)

    // The app posts only askID + optionID. Demanding a session id here is what
    // silently 400'd every approval from the phone: the card cleared, the turn
    // stayed blocked, and nothing was logged.
    const res = await fetch(`${base}/respond`, {
      method: "POST",
      headers,
      body: JSON.stringify({ askID: "per_ask1", optionID: "always" }),
    })
    assert.equal(res.status, 200, `the ask must be answerable without a session id, got ${res.status}`)

    // an ask this process never surfaced still fails cleanly — as an unknown
    // ask, not as a missing session id
    const unknown = await fetch(`${base}/respond`, {
      method: "POST",
      headers,
      body: JSON.stringify({ askID: "per_never", optionID: "always" }),
    })
    assert.equal(unknown.status, 404)
    assert.equal(((await unknown.json()) as { error: string }).error, "unknown ask")
  } finally {
    await g.close()
  }
})

test("standing an ask down needs only its id, and tells the harness", async () => {
  // Answering in your own words spends the card, but the harness is still holding
  // the turn open on the ask — the question tool has not returned. Without this
  // the turn never ends and the phone has to stop it by hand, which is exactly
  // what a spent card must never need.
  const a = stallable()
  const rejected: string[] = []
  a.adapter.rejectAsk = async (_sid, askID) => {
    rejected.push(askID)
    return true
  }
  const { base, headers, g } = await startWith(a)
  try {
    a.feed({
      type: "ask.requested",
      sessionID: "s1",
      ask: {
        id: "que_ask1",
        sessionID: "s1",
        title: "Next up",
        kind: "question",
        options: [{ id: "0:Yes", label: "Yes" }],
      },
    } as DomainEvent)
    await sleep(60)
    const res = await fetch(`${base}/reject`, {
      method: "POST",
      headers,
      body: JSON.stringify({ askID: "que_ask1" }),
    })
    assert.equal(res.status, 200, `the ask must be standable without a session id, got ${res.status}`)
    assert.deepEqual(rejected, ["que_ask1"], "the ask must reach the harness, or the turn stays parked")

    const unknown = await fetch(`${base}/reject`, {
      method: "POST",
      headers,
      body: JSON.stringify({ askID: "que_never" }),
    })
    assert.equal(unknown.status, 404)
    assert.equal(((await unknown.json()) as { error: string }).error, "unknown ask")
  } finally {
    await g.close()
  }
})

test("a relative link is read from the session's own workspace", async () => {
  // The transcript links `[notes](docs/notes.md)`. "docs/notes.md" only means
  // something relative to the workspace that session belongs to — resolved here,
  // by the process that knows which workspace that is, and then held to the same
  // roots check as everything else. Resolving it against the daemon's own
  // working directory (the first attempt) made every link unreadable.
  const ws = mkdtempSync(join(tmpdir(), "gw-ws-"))
  mkdirSync(join(ws, "docs"))
  writeFileSync(join(ws, "docs", "notes.md"), "# notes\n\nhello from the workspace\n")
  const a = stallable()
  const { base, headers, g } = await startWith(a, ws)
  try {
    const read = async (path: string) => {
      const res = await fetch(`${base}/read`, {
        method: "POST",
        headers,
        body: JSON.stringify({ id: "s1", path }),
      })
      return { status: res.status, body: (await res.json()) as { text?: string; error?: string } }
    }

    const ok = await read("docs/notes.md")
    assert.equal(ok.status, 200, `expected the file to be readable, got ${ok.status} ${ok.body.error ?? ""}`)
    assert.match(ok.body.text ?? "", /hello from the workspace/)

    // a path that escapes the workspace is still refused
    const escape = await read("../../../../etc/hosts")
    assert.equal(escape.status, 403, "the roots check still applies to a relative path")

    const missing = await read("docs/nope.md")
    assert.equal(missing.status, 404)
  } finally {
    await g.close()
  }
})

test("the served roots hold workspaces and uploads, never jep's own stores or a symlink out", async () => {
  // dataHome also holds the device tokens and the mirrored provider
  // credentials; a paired phone must not be able to read either
  const ws = mkdtempSync(join(tmpdir(), "gw-ws-"))
  const outside = mkdtempSync(join(tmpdir(), "gw-out-"))
  writeFileSync(join(outside, "secret.txt"), "not yours")
  writeFileSync(join(ws, "notes.md"), "in the workspace")
  symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"))
  const a = stallable()
  const { base, headers, g, dataHome } = await startWith(a, ws)
  mkdirSync(join(dataHome, "opencode"), { recursive: true })
  writeFileSync(join(dataHome, "opencode", "auth.json"), "{\"key\":\"sk-test\"}")
  mkdirSync(join(dataHome, "uploads"), { recursive: true })
  writeFileSync(join(dataHome, "uploads", "photo.png"), "png")
  try {
    const file = async (p: string) => {
      const res = await fetch(`${base}/file?p=${Buffer.from(p).toString("base64url")}`, { headers })
      return { status: res.status, text: await res.text() }
    }
    const read = async (path: string) =>
      (await fetch(`${base}/read`, { method: "POST", headers, body: JSON.stringify({ id: "s1", path }) })).status

    assert.equal((await file(join(ws, "notes.md"))).text, "in the workspace")
    assert.equal((await file(join(dataHome, "uploads", "photo.png"))).text, "png")
    assert.equal((await file(join(dataHome, "opencode", "auth.json"))).status, 403)
    assert.equal((await file(join(dataHome, "gateway-tokens.json"))).status, 403)
    assert.equal((await file(join(ws, "link.txt"))).status, 403)
    // a relative path is in the named session's workspace, and still roots-checked
    const rel = async (p: string) =>
      (await fetch(`${base}/file?p=${Buffer.from(p).toString("base64url")}&id=s1`, { headers })).text()
    assert.equal(await rel("notes.md"), "in the workspace")
    assert.equal((await fetch(`${base}/file?p=${Buffer.from("link.txt").toString("base64url")}&id=s1`, { headers })).status, 403)
    assert.equal(await read("link.txt"), 403)
    assert.equal(await read(join(dataHome, "gateway-tokens.json")), 403)
    // the server is still healthy after a served file (no second response)
    assert.equal((await fetch(`${base}/health`)).status, 200)
  } finally {
    await g.close()
  }
})

test("a restart waits for quiet instead of cutting a live turn off", async () => {
  // Restarting at the wrong moment kills a turn in flight and leaves the user
  // to wake the agent up by hand. So the restart is armed: it waits until the
  // daemon is quiet, and only then exits.
  let last = Date.now()
  let exited = false
  const cancel = restartWhenQuiet({
    quietMs: 300,
    maxWaitMs: 10_000,
    activity: () => last,
    exit: () => {
      exited = true
    },
    intervalMs: 20,
  })
  try {
    // a turn is running: events keep arriving, so the restart must not fire
    for (let i = 0; i < 6; i++) {
      await sleep(60)
      last = Date.now()
      assert.equal(exited, false, "a busy daemon must not restart")
    }
    await sleep(500) // the turn ends and the daemon goes quiet
    assert.equal(exited, true, "a quiet daemon must restart")
  } finally {
    cancel()
  }
})

test("a restart gives up waiting rather than wedging the deploy forever", async () => {
  // the cap is the safety net: even a daemon that never goes quiet restarts,
  // because a restart must never be what makes things worse
  let exited = false
  const cancel = restartWhenQuiet({
    quietMs: 60_000,
    maxWaitMs: 200,
    activity: () => Date.now(), // never quiet
    exit: () => {
      exited = true
    },
    intervalMs: 20,
  })
  try {
    await sleep(450)
    assert.equal(exited, true, "the cap must fire even when never quiet")
  } finally {
    cancel()
  }
})

test("/history carries every ask the conversation raised, and how each ended", async () => {
  // An ask is part of the record. When it only lived in the event stream, the
  // next ask replaced its card, and a phone that was offline when one arrived
  // never learned the turn was parked on it.
  const a = stallable()
  const { base, headers, g } = await startWith(a)
  const ask = (id: string, at: number) =>
    ({
      type: "ask.requested",
      sessionID: "s1",
      ask: { id, sessionID: "s1", title: "bash", options: [{ id: "once", label: "Allow once" }], messageID: "m1", at },
    }) as DomainEvent
  try {
    a.feed(ask("per_1", 10))
    a.feed(ask("per_2", 20))
    a.feed(ask("per_3", 30))
    a.feed(ask("per_1", 10)) // the same ask surfaced twice is still one ask
    await sleep(60)
    const answered = await fetch(`${base}/respond`, { method: "POST", headers, body: JSON.stringify({ askID: "per_1", optionID: "once" }) })
    assert.equal(answered.status, 200)
    // settled somewhere else — another client, the harness's own UI, a turn that ended
    a.feed({ type: "ask.resolved", sessionID: "s1", askID: "per_2" } as DomainEvent)
    // and the harness confirming the answer /respond gave must not erase which option it was
    a.feed({ type: "ask.resolved", sessionID: "s1", askID: "per_1" } as DomainEvent)
    await sleep(60)

    const res = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    const { asks } = (await res.json()) as { asks: Array<{ id: string; state: string; answer?: string; messageID?: string; at?: number }> }
    assert.deepEqual(
      asks.map((x) => [x.id, x.state, x.answer ?? null]),
      [
        ["per_1", "answered", "once"],
        ["per_2", "closed", null],
        ["per_3", "pending", null],
      ],
    )
    assert.equal(asks[2]!.messageID, "m1", "the anchor rides along, so the card can be placed")
    assert.equal(asks[2]!.at, 30)
  } finally {
    await g.close()
  }
})

test("what was seen is kept by the daemon, so every device agrees on unread", async () => {
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: fakeAdapter() }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const post = async (path: string, body: object) => (await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<any>
    const seenAt = async () => (await post("/sessions", {})).items.find((s: any) => s.id === "s1").seenAt
    assert.equal(await seenAt(), 0, "never seen")
    await post("/seen", { id: "s1", at: 500 })
    await post("/seen", { id: "s1", at: 300 }) // a device with a slow clock
    assert.equal(await seenAt(), 500, "the later mark stands")
    await post("/seen", { id: "s1", at: 0 })
    assert.equal(await seenAt(), 0, "marked unread again")
  } finally {
    await g.close()
  }
})

test("an attachment list in a user message comes back as file parts, not text", async () => {
  // claude's print mode takes attachments as a path list in the prompt; the
  // list is stripped from what is shown, and without file parts in its place
  // the phone's thumbnail vanished once the record replaced its own copy
  const a = fakeAdapter()
  a.messages = async () => [
    {
      id: "u1",
      sessionID: "s1",
      role: "user",
      time: 1,
      parts: [{ kind: "text", text: "look at this\n\nAttached files:\n- /data/attachments/att-1-shot.jpg" }],
    },
  ]
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const res = await fetch(`${base}/history`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "s1" }),
    })
    const { messages } = (await res.json()) as { messages: Message[] }
    assert.deepEqual(messages[0]!.parts, [
      { kind: "text", text: "look at this" },
      { kind: "file", filePath: "/data/attachments/att-1-shot.jpg", fileName: "att-1-shot.jpg", mimeType: "image/jpeg" },
    ])
  } finally {
    await g.close()
  }
})

test("/history answers an unchanged window in a few bytes when the client holds it", async () => {
  // The phone polls this every 1.2s during a turn; most answers repeat the last.
  const a = fakeAdapter()
  let text = "hi"
  a.messages = async () => [{ id: "m0", sessionID: "s1", role: "user", time: 1, parts: [{ kind: "text", text }] }]
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const history = async (etag?: string) => {
      const res = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1", ...(etag ? { etag } : {}) }) })
      const raw = await res.text()
      return { raw, body: JSON.parse(raw) as { etag: string; unchanged?: boolean; messages?: unknown[] } }
    }
    const first = await history()
    assert.equal(first.body.messages?.length, 1)
    assert.ok(first.body.etag, "every answer is tagged")
    const again = await history(first.body.etag)
    assert.deepEqual(again.body, { unchanged: true, etag: first.body.etag })
    assert.ok(again.raw.length < first.raw.length, "the unchanged answer is the small one")
    text = "hi there" // the record moved on: the tag the client holds is stale
    const moved = await history(first.body.etag)
    assert.equal(moved.body.unchanged, undefined)
    assert.notEqual(moved.body.etag, first.body.etag)
    assert.equal(moved.body.messages?.length, 1)
  } finally {
    await g.close()
  }
})

test("/git reads the workspace through core/git, and says so when there is no repo", async () => {
  const { execFileSync } = await import("node:child_process")
  const repo = mkdtempSync(join(tmpdir(), "gw-git-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" })
  git("init", "-q", "-b", "main")
  git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first commit")
  writeFileSync(join(repo, "new.txt"), "hello\n")
  const plain = mkdtempSync(join(tmpdir(), "gw-nogit-"))
  let where = repo
  const a = { ...fakeAdapter(), get workspace() { return where } } as HarnessAdapter
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const view = async () => (await (await fetch(`${base}/git`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })).json()) as any
    const v = await view()
    assert.equal(v.isRepository, true)
    assert.equal(v.branch, "main")
    assert.equal(v.changedFiles, 1, "the new file counts, as it does on Telegram's /git")
    assert.equal(v.commits.length, 1)
    assert.equal(v.head.subject, "first commit")
    assert.equal(v.head.shortHash, v.head.hash)
    assert.ok(v.head.time > 1_700_000_000, "seconds, as the phone expects")
    where = plain
    assert.deepEqual(await view(), { isRepository: false, branch: null, head: null, changedFiles: 0, commits: [] })
  } finally {
    await g.close()
  }
})

test("/harness-settings says whether the conversation's harness can compact", async () => {
  const a = fakeAdapter()
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-test-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const token = await pair(base, "TESTCODE")
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const ask = async () => ((await (await fetch(`${base}/harness-settings`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })).json()) as { compact: boolean }).compact
    assert.equal(await ask(), false, "no compact port: the phone shows no Compact row")
    a.compact = async () => true
    assert.equal(await ask(), true)
  } finally {
    await g.close()
  }
})

test("unpair revokes every device token without a restart", async () => {
  const { base, headers, g, dataHome } = await startWith(stallable())
  try {
    assert.equal((await fetch(`${base}/sessions`, { method: "POST", headers })).status, 200)
    await sleep(20) // a distinct mtime from the pairing write
    assert.equal(await revokeGatewayTokens(dataHome), 1)
    assert.equal((await fetch(`${base}/sessions`, { method: "POST", headers })).status, 401)
  } finally {
    await g.close()
  }
})

test("the gateway listens on the configured host", async () => {
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: fakeAdapter() }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-bind-")),
    port: 0,
    host: "127.0.0.1",
    pairCode: "TESTCODE",
  })
  try {
    const res = await fetch(`http://127.0.0.1:${g.port}/health`)
    assert.equal(res.status, 200)
  } finally {
    await g.close()
  }
})
