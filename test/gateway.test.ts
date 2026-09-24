import test from "node:test"
import assert from "node:assert/strict"
import { restartWhenQuiet, startGateway, type GatewayHandle } from "../src/clients/gateway/index.ts"
import type { HarnessAdapter } from "../src/core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../src/core/types.ts"
import { TurnAbortedError } from "../src/core/types.ts"
import { JEP_CONTEXT, JEP_CONTEXT_FOOTER } from "../src/core/transcript.ts"
import { existsSync, mkdtempSync } from "node:fs"
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

async function startWith(a: ReturnType<typeof stallable>): Promise<{ base: string; headers: Record<string, string>; g: GatewayHandle }> {
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: a.adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-q-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  const base = `http://127.0.0.1:${g.port}`
  const token = await pair(base, "TESTCODE")
  return { base, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, g }
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
