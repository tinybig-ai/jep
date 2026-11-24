import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway } from "../src/clients/gateway/index.ts"
import type { Message } from "../src/core/types.ts"
import { fakeAdapter, pair } from "./support/gateway.ts"

// The phone pages a conversation 30 at a time: it sends the time of the oldest message it holds
// and how many it holds, and the daemon answers with the page before it. Some rows have no words
// left after cleaning (a user message that was only jep's context) and are not sent. The window
// the daemon asked the harness for was sized by the phone's count, which leaves those rows out,
// so the window came up short: a real conversation gave 17 of 30, then 9, then "nothing older",
// on web and Android alike, with 500 messages still unread. The window now grows until a full
// page is shown.

const PAGE = 30

/** `shown` messages a person can read, with hidden rows between them in the proportions given */
function conversation(shown: number, hiddenEvery: number): { rows: Message[]; visible: number } {
  const rows: Message[] = []
  let time = 1_000
  let visible = 0
  for (let i = 0; i < shown; i++) {
    rows.push({ id: `m${i}`, sessionID: "s1", role: i % 2 ? "assistant" : "user", time: time++, parts: [{ kind: "text", text: `message ${i}` }] })
    visible++
    // a user row with nothing left to show: the daemon does not send it
    for (let h = 0; h < hiddenEvery; h++) rows.push({ id: `h${i}-${h}`, sessionID: "s1", role: "user", time: time++, parts: [] })
  }
  return { rows, visible }
}

async function walk(rows: Message[]): Promise<{ firstPage: number; held: Message[]; pages: number }> {
  const base = fakeAdapter()
  const adapter = {
    ...base,
    // a harness with a real window, as opencode and goose have: the newest `limit` rows
    async messages(_id: string, opts?: { limit?: number }) {
      return opts?.limit ? rows.slice(-opts.limit) : rows
    },
  }
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter }],
    dataHome: mkdtempSync(join(tmpdir(), "gw-page-")),
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  try {
    const url = `http://127.0.0.1:${g.port}`
    const token = await pair(url, "TESTCODE")
    const call = async (body: object) =>
      (await (await fetch(`${url}/history`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "s1", ...body }) })).json()) as {
        messages: Message[]
        hasMore: boolean
      }
    // what the web client does: the newest page, then older ones until there is nothing older
    const first = await call({ limit: PAGE })
    let held = first.messages
    let hasMore = first.hasMore
    let pages = 0
    while (hasMore && pages < 200) {
      const data = await call({ limit: PAGE, before: held[0]!.time, have: held.length })
      held = [...data.messages.filter((m) => m.time < held[0]!.time), ...held]
      hasMore = data.hasMore
      pages++
    }
    return { firstPage: first.messages.length, held, pages }
  } finally {
    await g.close()
  }
}

test("a conversation with hidden rows still pages all the way back, a full page at a time", async () => {
  // two hidden rows after every shown one: the window the phone's count implies is far too short
  const { rows, visible } = conversation(200, 2)
  const out = await walk(rows)
  assert.equal(out.firstPage, PAGE, "the newest page is a full page, not what is left after the hidden rows")
  assert.equal(out.held.length, visible, "every message a person can read was reached")
  assert.equal(new Set(out.held.map((m) => m.id)).size, visible, "and none twice")
  assert.ok(out.held.every((m, i) => i === 0 || m.time > out.held[i - 1]!.time), "in order")
})

test("a conversation with no hidden rows pages exactly as before", async () => {
  const { rows, visible } = conversation(95, 0)
  const out = await walk(rows)
  assert.equal(out.held.length, visible)
  assert.equal(out.pages, 3, "95 messages is the newest 30 and then 30, 30 and 5")
})

test("a conversation shorter than a page has nothing older", async () => {
  const { rows, visible } = conversation(12, 3)
  const out = await walk(rows)
  assert.equal(out.firstPage, visible)
  assert.equal(out.pages, 0)
})
