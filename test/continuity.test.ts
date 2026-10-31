import test from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway } from "../src/clients/gateway/index.ts"
import { startContinuity, type ContinuityOpts } from "../src/app/continuity.ts"
import { TurnLedger } from "../src/core/ledger.ts"
import { pair, stallable } from "./support/gateway.ts"

// The daemon's own services, started the way the daemon starts them: the
// gateway runs the turns, continuity sees them only through gw.turns.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ask = (dataHome: string, req: object) =>
  new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
    const c = net.createConnection(join(dataHome, "control.sock"))
    let buf = ""
    c.on("connect", () => c.write(`${JSON.stringify(req)}\n`))
    c.on("data", (d) => (buf += d.toString()))
    c.on("end", () => resolve(JSON.parse(buf)))
    c.on("error", reject)
  })

async function boot(a: ReturnType<typeof stallable>, dataHome: string, opts: Partial<ContinuityOpts> = {}, ledger?: TurnLedger) {
  // a real directory as the workspace: a watch's check runs in it
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }],
    dataHome,
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
    ...(ledger ? { ledger } : {}),
  })
  const c = await startContinuity({ dataHome, turns: g.turns, ...opts })
  const base = `http://127.0.0.1:${g.port}`
  const token = await pair(base, "TESTCODE")
  return {
    base,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    close: async () => {
      c.close()
      await g.close()
    },
  }
}

const journalOf = (dataHome: string) => JSON.parse(readFileSync(join(dataHome, "interrupted.json"), "utf8"))

test("jep-watch hands a wait to the daemon, which starts a turn when the check passes", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "ct-watch-"))
  const t = await boot(a, dataHome)
  try {
    const answer = await ask(dataHome, { check: "true", note: "the render", every_seconds: 5, session: "s1" })
    assert.equal(answer.ok, true)
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && !a.calls.some((c) => c.includes("the render"))) await sleep(100)
    const turn = a.calls.find((c) => c.includes("the render"))
    assert.ok(turn, "a turn started on its own")
    assert.match(turn, /has finished/)
  } finally {
    await t.close()
  }
})

test("jep-restart waits for the running turn, then restarts, so no agent has to time it", { timeout: 20_000 }, async () => {
  const a = stallable()
  const dataHome = mkdtempSync(join(tmpdir(), "ct-restart-"))
  let restarts = 0
  const t = await boot(a, dataHome, { restart: () => void restarts++ })
  try {
    const first = fetch(`${t.base}/prompt`, { method: "POST", headers: t.headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    await sleep(100)
    const answer = await ask(dataHome, { op: "restart" })
    assert.equal(answer.ok, true)
    assert.match(answer.message, /end this turn/i)
    await sleep(3_200)
    assert.equal(restarts, 0, "the turn is still running, so the daemon does not restart")
    a.release("first")
    await first
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && restarts === 0) await sleep(100)
    assert.equal(restarts, 1, "every turn ended, so it restarts once")
  } finally {
    await t.close()
  }
})

test("jep-restart says so when the daemon cannot restart itself", async () => {
  const dataHome = mkdtempSync(join(tmpdir(), "ct-restart-"))
  const t = await boot(stallable(), dataHome)
  try {
    assert.equal((await ask(dataHome, { op: "restart" })).ok, false)
  } finally {
    await t.close()
  }
})

test("the journal holds a turn while it runs, and nothing once it has ended", async () => {
  const a = stallable()
  const dataHome = mkdtempSync(join(tmpdir(), "ct-journal-"))
  const t = await boot(a, dataHome)
  try {
    const first = fetch(`${t.base}/prompt`, { method: "POST", headers: t.headers, body: JSON.stringify({ id: "s1", text: "first" }) })
    await sleep(150)
    assert.deepEqual(journalOf(dataHome), [{ key: "s1", resume: false }])
    a.release("first")
    await first
    await sleep(100)
    assert.deepEqual(journalOf(dataHome), [])
  } finally {
    await t.close()
  }
})

test("a turn a restart cut off is picked up on the next start, once", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "ct-resume-"))
  writeFileSync(join(dataHome, "interrupted.json"), JSON.stringify([{ key: "s1", resume: false }, { key: "s2", resume: true }]))
  const t = await boot(a, dataHome, { restoreAfterMs: 50 })
  try {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && a.calls.length === 0) await sleep(50)
    assert.equal(a.calls.length, 1, "s1 is picked up; s2 was itself a pick-up and is left to a person")
    assert.match(a.calls[0]!, /restarted while you were working/)
    assert.match(a.calls[0]!, /jep-restart/)
  } finally {
    await t.close()
  }
})

test("a watch survives a restart and fires after it", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "ct-watches-"))
  writeFileSync(
    join(dataHome, "watches.json"),
    JSON.stringify([{ key: "s1", startedAt: Date.now() - 1000, spec: { check: "true", note: "the long render", everyMs: 100, maxMs: 60_000 } }]),
  )
  const t = await boot(a, dataHome, { restoreAfterMs: 50 })
  try {
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && !a.calls.some((c) => c.includes("the long render"))) await sleep(50)
    assert.ok(a.calls.some((c) => c.includes("the long render")), "the restored watch started a turn")
    assert.deepEqual(JSON.parse(readFileSync(join(dataHome, "watches.json"), "utf8")), [], "and is no longer saved once it has fired")
  } finally {
    await t.close()
  }
})

test("a turn another client runs (the bot) holds the restart back and is journaled", { timeout: 20_000 }, async () => {
  const ledger = new TurnLedger()
  const dataHome = mkdtempSync(join(tmpdir(), "ct-bot-"))
  let restarts = 0
  const t = await boot(stallable(), dataHome, { restart: () => void restarts++ }, ledger)
  try {
    const botTurnOver = ledger.begin("bot-session")
    assert.deepEqual(journalOf(dataHome), [{ key: "bot-session", resume: false }])
    assert.equal((await ask(dataHome, { op: "restart" })).ok, true)
    await sleep(3_200)
    assert.equal(restarts, 0, "the bot's turn is still running, so the daemon waits")
    botTurnOver()
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline && restarts === 0) await sleep(100)
    assert.equal(restarts, 1)
    assert.deepEqual(journalOf(dataHome), [])
  } finally {
    await t.close()
  }
})

test("a turn cut off by shutdown stays in the journal for the next start", async () => {
  const ledger = new TurnLedger()
  const dataHome = mkdtempSync(join(tmpdir(), "ct-cut-"))
  const t = await boot(stallable(), dataHome, {}, ledger)
  const over = ledger.begin("s1")
  ledger.close() // what the daemon does first when it is told to stop
  over()
  await t.close()
  assert.deepEqual(journalOf(dataHome), [{ key: "s1", resume: false }])
})
