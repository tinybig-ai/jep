import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway } from "../src/clients/gateway/index.ts"
import { startContinuity } from "../src/app/continuity.ts"
import type { ChatDirectory, ChatInfo } from "../src/core/ports.ts"
import type { Message } from "../src/core/types.ts"
import { pair, stallable } from "./support/gateway.ts"

const control = (dataHome: string, req: object) =>
  new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
    const c = net.createConnection(join(dataHome, "control.sock"))
    let buf = ""
    c.on("connect", () => c.write(`${JSON.stringify(req)}\n`))
    c.on("data", (d) => (buf += d.toString()))
    c.on("end", () => resolve(JSON.parse(buf)))
    c.on("error", reject)
  })

const info = (id: string, title: string): ChatInfo => ({ id, title, harness: "goose", workspace: "/w/map", updatedAt: 1 })
const say = (text: string): Message => ({ id: "m", sessionID: "x", role: "user", time: 1, parts: [{ kind: "text", text }] })

// the asking conversation is the fake adapter's s1; the one it wants to read is "other"
async function boot(answers: (string | null)[]) {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "rd-"))
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }],
    dataHome,
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
  })
  const asked: { key: string; title: string; detail: string }[] = []
  const chats: ChatDirectory = {
    async list() {
      return [info("s1", "Asker"), info("other", "Map render blank")]
    },
    async read(id) {
      return id === "other" ? { info: info("other", "Map render blank"), messages: [say("the secret plan")] } : null
    },
    async askPerson(key, ask) {
      asked.push({ key, title: ask.title, detail: ask.detail })
      return answers.shift() ?? null
    },
  }
  const c = await startContinuity({ dataHome, turns: g.turns, chats })
  return { dataHome, asked, close: async () => (c.close(), g.close()) }
}

test("a read asks the person, names both conversations, and reads only on yes", { timeout: 20_000 }, async () => {
  const t = await boot(["allow", "reject", null])
  try {
    const yes = await control(t.dataHome, { op: "read", target: "render", session: "s1" })
    assert.equal(yes.ok, true)
    assert.match(yes.message, /Another conversation: Map render blank/)
    assert.match(yes.message, /the secret plan/)
    assert.equal(t.asked[0]!.key, "s1", "the card is raised in the asking conversation")
    assert.match(t.asked[0]!.detail, /"Asker" wants to read "Map render blank"/)

    const no = await control(t.dataHome, { op: "read", target: "render", session: "s1" })
    assert.equal(no.ok, false)
    assert.ok(!no.message.includes("secret"))
    assert.match(no.message, /said no/)

    const silent = await control(t.dataHome, { op: "read", target: "render", session: "s1" })
    assert.equal(silent.ok, false)
    assert.match(silent.message, /nobody answered/)
    assert.equal(t.asked.length, 3, "an allow-once is asked again")
  } finally {
    await t.close()
  }
})

test("always is remembered for that pair, and only that pair", { timeout: 20_000 }, async () => {
  const t = await boot(["always"])
  try {
    assert.equal((await control(t.dataHome, { op: "read", target: "render", session: "s1" })).ok, true)
    assert.equal((await control(t.dataHome, { op: "read", target: "render", session: "s1" })).ok, true)
    assert.equal(t.asked.length, 1, "the second read did not ask")
    assert.match(readFileSync(join(t.dataHome, "chat-grants.json"), "utf8"), /s1.*other/)
  } finally {
    await t.close()
  }
})

test("listing needs no yes, and a conversation cannot read itself", { timeout: 20_000 }, async () => {
  const t = await boot([])
  try {
    const list = await control(t.dataHome, { op: "read", list: true })
    assert.match(list.message, /other {2}goose {2}Map render blank/)
    assert.equal(t.asked.length, 0)
    const self = await control(t.dataHome, { op: "read", target: "Asker", session: "s1" })
    assert.equal(self.ok, false)
    assert.match(self.message, /this conversation/)
    assert.ok(!existsSync(join(t.dataHome, "chat-grants.json")))
  } finally {
    await t.close()
  }
})

test("the card the gateway raises is an ask in the conversation, answered through /respond", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "rd-gw-"))
  const g = await startGateway({ adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }], dataHome, port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const headers = { authorization: `Bearer ${await pair(base, "TESTCODE")}`, "content-type": "application/json" }
    const options = [{ id: "allow", label: "Allow once", style: "success" as const }, { id: "reject", label: "Deny", style: "danger" as const }]
    const answer = g.chats.askPerson("s1", { title: "Read another conversation?", detail: "A wants to read B.", options }, 10_000)
    const history = async () => (await (await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })).json()) as { asks: { id: string; state: string; title: string; display?: { title?: string } }[] }
    let card = (await history()).asks.find((x) => x.state === "pending")
    assert.ok(card, "the conversation holds a pending card")
    assert.equal(card.title, "Read another conversation?")
    assert.ok(card.display, "clients get the sentence to show")
    const r = await fetch(`${base}/respond`, { method: "POST", headers, body: JSON.stringify({ askID: card.id, optionID: "allow" }) })
    assert.equal(r.status, 200)
    assert.equal(await answer, "allow")
    card = (await history()).asks.find((x) => x.id === card!.id)
    assert.equal(card!.state, "answered")
  } finally {
    await g.close()
  }
})

test("a card nobody answers closes itself and the read is refused", { timeout: 10_000 }, async () => {
  const a = stallable({ hold: () => false })
  const g = await startGateway({ adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }], dataHome: mkdtempSync(join(tmpdir(), "rd-to-")), port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  try {
    assert.equal(await g.chats.askPerson("s1", { title: "t", detail: "d", options: [{ id: "allow", label: "Allow once" }] }, 150), null)
  } finally {
    await g.close()
  }
})
