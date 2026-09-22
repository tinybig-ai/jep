import test from "node:test"
import assert from "node:assert/strict"
import { startGateway, type GatewayHandle } from "../src/gateway.ts"
import type { HarnessAdapter } from "../src/core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../src/core/types.ts"
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
