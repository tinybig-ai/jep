// A quote is a jep concept: sent beside the words, handed to the harness as a
// plain "> " block the model reads as a quote, and lifted back out of the
// record so no client shows it as markdown typed into the message.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { splitQuote, withQuote } from "../src/core/transcript.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import type { HarnessAdapter } from "../src/core/ports.ts"
import type { Message, SessionSummary } from "../src/core/types.ts"

test("a quote goes to the harness as a quote block and comes back whole", () => {
  const sent = withQuote("do the second one", "first line\n\nsecond line")
  assert.equal(sent, "> first line\n>\n> second line\n\ndo the second one")
  assert.deepEqual(splitQuote(sent), { quote: "first line\n\nsecond line", text: "do the second one" })
})

test("no quote, nothing added", () => {
  assert.equal(withQuote("hello"), "hello")
  assert.equal(withQuote("hello", "  "), "hello")
})

test("only a leading block with words after it is a quote", () => {
  // a message that is all quote was typed that way
  assert.deepEqual(splitQuote("> just this"), { text: "> just this" })
  // a quote in the middle is the person's own markdown
  assert.deepEqual(splitQuote("look:\n> this\n\nok"), { text: "look:\n> this\n\nok" })
  assert.deepEqual(splitQuote("plain"), { text: "plain" })
})

test("the gateway hands the quote on, and serves it back as its own part", async () => {
  const session: SessionSummary = { id: "s1", title: "T", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
  const record: Message[] = []
  const adapter = {
    id: "fake",
    workspace: "/tmp/ws",
    endpoint: "",
    async health() { return { healthy: true, version: "0" } },
    async createSession() { return session },
    async getSession(id: string) { return id === "s1" ? session : null },
    async listSessions() { return [session] },
    async prompt(_id: string, text: string) {
      record.push({ id: "u1", sessionID: "s1", role: "user", time: 1, parts: [{ kind: "text", text }] })
      return { id: "a1", sessionID: "s1", role: "assistant", time: 2, parts: [{ kind: "text", text: "ok" }] } as Message
    },
    async deleteSession() { return true },
    async messages() { return record },
    async abort() { return true },
    async respondAsk() { return true },
    async rejectAsk() { return true },
    async *events() {},
    async close() {},
  } as unknown as HarnessAdapter
  const g = await startGateway({
    adapters: () => [{ name: "ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-quote-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const pair = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "TESTCODE" }) })
    const { token } = (await pair.json()) as { token: string }
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ id: "s1", text: "yes, that", quote: "shall I?" }) })
    assert.equal((record[0]!.parts[0] as { text: string }).text, "> shall I?\n\nyes, that")

    const h = await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })
    const { messages } = (await h.json()) as { messages: Message[] }
    assert.deepEqual(messages[0]!.parts, [
      { kind: "quote", text: "shall I?" },
      { kind: "text", text: "yes, that" },
    ])
  } finally {
    await g.close()
  }
})
