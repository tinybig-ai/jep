// A quote is a jep concept: sent beside the words, handed by each adapter to
// its harness in the most structured form that harness takes, and given back
// by messages() as a quote part. The gateway only passes it through.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { quoteBlock, readQuoteBlock, splitQuoteText, withQuoteText } from "../src/core/transcript.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import type { HarnessAdapter } from "../src/core/ports.ts"
import type { Message, SessionSummary } from "../src/core/types.ts"

test("the block the model reads is headed, and reads back whole", () => {
  const block = quoteBlock("first line\n\nsecond line")
  assert.equal(block, "[in reply to]\n> first line\n>\n> second line")
  assert.equal(readQuoteBlock(block), "first line\n\nsecond line")
  // anything else is not one
  assert.equal(readQuoteBlock("> first line"), null)
  assert.equal(readQuoteBlock("[in reply to]\n> a\nnot quoted"), null)
})

test("a text-only harness gets the block ahead of the message, and nothing else is taken back", () => {
  const sent = withQuoteText("do the second one", "shall I?")
  assert.equal(sent, "[in reply to]\n> shall I?\n\ndo the second one")
  assert.deepEqual(splitQuoteText(sent), { quote: "shall I?", text: "do the second one" })
  assert.equal(withQuoteText("hello"), "hello")
  assert.equal(withQuoteText("hello", "  "), "hello")
  // a blockquote you typed yourself is your own markdown, left alone
  assert.deepEqual(splitQuoteText("> my own quote\n\nand my words"), { text: "> my own quote\n\nand my words" })
})

test("the gateway hands the quote to the adapter and serves its quote part", async () => {
  const session: SessionSummary = { id: "s1", title: "T", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
  const record: Message[] = []
  let asked: { text: string; quote?: string } | undefined
  const adapter = {
    id: "fake",
    workspace: "/tmp/ws",
    endpoint: "",
    async health() { return { healthy: true, version: "0" } },
    async createSession() { return session },
    async getSession(id: string) { return id === "s1" ? session : null },
    async listSessions() { return [session] },
    async prompt(_id: string, text: string, opts?: { quote?: string }) {
      asked = { text, quote: opts?.quote }
      record.push({ id: "u1", sessionID: "s1", role: "user", time: 1, parts: [{ kind: "quote", text: opts?.quote ?? "" }, { kind: "text", text }] })
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
    // the words untouched, the quote beside them
    assert.deepEqual(asked, { text: "yes, that", quote: "shall I?" })

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
