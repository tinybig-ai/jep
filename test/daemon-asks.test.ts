import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway, type GatewayHandle } from "../src/clients/gateway/index.ts"
import type { AskRequest } from "../src/core/types.ts"
import { fakeAdapter, pair } from "./support/gateway.ts"

// A card the daemon raises itself (an agent asks to read or message another conversation) has
// no harness behind it. The gateway's own broadcast reaches only its own clients, so Telegram
// never showed the card, and the agent waited out its ten minutes and was denied. Every client
// that can show a card now hears it through the daemon ask port.

async function gateway(): Promise<GatewayHandle> {
  return startGateway({
    adapters: () => [{ name: "fake-ws", adapter: fakeAdapter() }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-ask-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
}

const card = { title: "Read another conversation?", detail: "A wants to read B.", options: [{ id: "allow", label: "Allow once" }, { id: "reject", label: "Deny" }] }

test("a card the daemon raises reaches a client that is not the gateway's own", async () => {
  const g = await gateway()
  try {
    const seen: AskRequest[] = []
    g.daemonAsks.onRequested((ask) => void seen.push(ask))
    const answer = g.chats.askPerson("claude://a", card, 60_000)
    assert.equal(seen.length, 1, "the other client was handed the card")
    assert.equal(seen[0]!.sessionID, "claude://a")
    assert.match(seen[0]!.id, /^jep-ask-/)
    assert.deepEqual(seen[0]!.options.map((o) => o.id), ["allow", "reject"])
    assert.equal(g.daemonAsks.answer(seen[0]!.id, "allow"), true)
    assert.equal(await answer, "allow", "the agent waiting on the card got the answer")
  } finally {
    await g.close()
  }
})

test("a card answered on one client is stood down on the others, and cannot be answered twice", async () => {
  const g = await gateway()
  try {
    const ended: Array<[string, string | null]> = []
    const seen: AskRequest[] = []
    g.daemonAsks.onRequested((ask) => void seen.push(ask))
    g.daemonAsks.onResolved((id, option) => void ended.push([id, option]))
    const answer = g.chats.askPerson("claude://a", card, 60_000)
    const id = seen[0]!.id
    assert.equal(g.daemonAsks.answer(id, "reject"), true)
    assert.deepEqual(ended, [[id, "reject"]], "every client hears how it ended")
    assert.equal(g.daemonAsks.answer(id, "allow"), false, "a second answer finds it settled")
    assert.equal(await answer, "reject")
  } finally {
    await g.close()
  }
})

test("a card nobody answers ends as no answer, and the clients are told", async () => {
  const g = await gateway()
  try {
    const ended: Array<string | null> = []
    g.daemonAsks.onResolved((_id, option) => void ended.push(option))
    assert.equal(await g.chats.askPerson("claude://a", card, 30), null)
    assert.deepEqual(ended, [null])
  } finally {
    await g.close()
  }
})

test("a client that stops listening hears nothing more, and one that throws does not block the rest", async () => {
  const g = await gateway()
  try {
    let quiet = 0
    let heard = 0
    let id = ""
    const stop = g.daemonAsks.onRequested(() => void quiet++)
    g.daemonAsks.onRequested(() => {
      throw new Error("this client is broken")
    })
    g.daemonAsks.onRequested(() => void heard++)
    g.daemonAsks.onRequested((ask) => void (id = ask.id))
    stop()
    const answer = g.chats.askPerson("claude://a", card, 60_000)
    assert.equal(quiet, 0, "a client that stopped listening hears nothing")
    assert.equal(heard, 1, "a broken client did not stop the next one from getting the card")
    assert.equal(g.daemonAsks.answer("jep-ask-unknown", "allow"), false, "an id nobody raised is not answerable")
    assert.equal(g.daemonAsks.answer(id, "allow"), true)
    assert.equal(await answer, "allow")
  } finally {
    await g.close()
  }
})

test("the broadcast the gateway's own clients read carries the conversation it is for", async () => {
  const g = await gateway()
  const base = `http://127.0.0.1:${g.port}`
  const token = await pair(base, "TESTCODE")
  const ac = new AbortController()
  try {
    const stream = await fetch(`${base}/stream?token=${token}`, { signal: ac.signal })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    void g.chats.askPerson("claude://a", card, 60_000)
    let buffer = ""
    let event: { type?: string; sessionID?: string; ask?: { id?: string } } | null = null
    const deadline = Date.now() + 5_000
    while (!event && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value)
      for (const frame of buffer.split("\n\n")) {
        const line = frame.split("\n").find((l) => l.startsWith("data: "))
        if (!line) continue
        try {
          const parsed = JSON.parse(line.slice(6))
          if (parsed.type === "ask.requested") event = parsed
        } catch {
          // a partial frame: the rest arrives with the next read
        }
      }
    }
    assert.ok(event, "the ask reached the stream")
    assert.equal(event!.sessionID, "claude://a", "the event names its conversation, as its type says")
    assert.match(event!.ask?.id ?? "", /^jep-ask-/)
  } finally {
    ac.abort()
    await g.close()
  }
})
