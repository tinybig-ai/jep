import test from "node:test"
import assert from "node:assert/strict"
import { startGateway, type GatewayHandle } from "../src/gateway.ts"
import type { HarnessAdapter } from "../src/core/ports.ts"
import type { DomainEvent, Message, SessionSummary } from "../src/core/types.ts"
import { mkdtempSync } from "node:fs"
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
    async deleteSession() {
      return true
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
