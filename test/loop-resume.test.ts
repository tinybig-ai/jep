import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway } from "../src/clients/gateway/index.ts"
import { startContinuity } from "../src/app/continuity.ts"
import { RESUME_TEXT } from "../src/core/restarts.ts"
import { pair, stallable } from "./support/gateway.ts"

// A restart is jep's own doing, not the person's word to stop. A loop that was running carries on after it.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const runningLoop = (sessionID: string) => ({
  sessionID,
  workspace: tmpdir(),
  spec: { goal: "make the build green", max: 8 },
  iteration: 1,
  status: "running",
  startedAt: Date.now() - 60_000,
  updatedAt: Date.now() - 30_000,
})

async function boot(loops: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "lr-"))
  writeFileSync(join(dataHome, "gateway-loops.json"), JSON.stringify(loops))
  for (const [file, body] of Object.entries(extra)) writeFileSync(join(dataHome, file), JSON.stringify(body))
  const g = await startGateway({
    adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }],
    dataHome,
    port: 0,
    pairCode: "TESTCODE",
    pairLimit: 100,
    resumesLoops: true,
  })
  const c = await startContinuity({ dataHome, turns: g.turns, restoreAfterMs: 50 })
  const base = `http://127.0.0.1:${g.port}`
  const headers = { authorization: `Bearer ${await pair(base, "TESTCODE")}`, "content-type": "application/json" }
  const loop = async () => ((await (await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })).json()) as { loop: { status: string; iteration: number; error?: string } | null }).loop
  return { a, base, headers, loop, close: async () => (c.close(), g.close()) }
}

test("a loop that was running carries on after a restart, and says why its last turn was cut off", { timeout: 20_000 }, async () => {
  const t = await boot({ s1: runningLoop("s1") })
  try {
    for (let i = 0; i < 100 && t.a.calls.length === 0; i++) await sleep(50)
    assert.ok(t.a.calls[0], "a turn started on its own")
    assert.match(t.a.calls[0]!, /Goal: make the build green/)
    assert.match(t.a.calls[0]!, /restarted while the loop was running/)
    // the loop is alive and goes on: when that turn ends, the next is queued
    for (let i = 0; i < 100 && t.a.calls.length < 2; i++) await sleep(50)
    assert.match(t.a.calls[1] ?? "", /Continue the loop/, "it did not die after one turn")
    // (the fake agent answers instantly, so it may already have run to its cap: it was running, not dead)
    const after = await t.loop()
    assert.ok(after && ["running", "exhausted"].includes(after.status), `alive after the restart, not stopped: ${after?.status} ${after?.error ?? ""}`)
    assert.ok(after.iteration >= 2, "it moved on from where it was")
    await fetch(`${t.base}/loop/stop`, { method: "POST", headers: t.headers, body: JSON.stringify({ id: "s1" }) })
  } finally {
    await t.close()
  }
})

test("the cut-off turn is not also picked up on its own: one turn resumes the loop, not two", { timeout: 20_000 }, async () => {
  const t = await boot({ s1: runningLoop("s1") }, { "interrupted.json": [{ key: "s1", resume: false }] })
  try {
    for (let i = 0; i < 100 && t.a.calls.length === 0; i++) await sleep(50)
    await sleep(300)
    assert.ok(!t.a.calls.includes(RESUME_TEXT), "no second, plain 'carry on' turn beside the loop's")
    await fetch(`${t.base}/loop/stop`, { method: "POST", headers: t.headers, body: JSON.stringify({ id: "s1" }) })
  } finally {
    await t.close()
  }
})

test("a loop that had ended stays ended, and one whose conversation is gone ends saying so", { timeout: 20_000 }, async () => {
  const t = await boot({
    s1: { ...runningLoop("s1"), status: "done" },
    "goose://gone": runningLoop("goose://gone"),
  })
  try {
    await sleep(600)
    assert.equal(t.a.calls.length, 0, "a finished loop does not start again")
    assert.equal((await t.loop())?.status, "done")
  } finally {
    await t.close()
  }
})

test("a daemon that does not resume loops still ends them, rather than leave them reading as alive", { timeout: 20_000 }, async () => {
  const a = stallable({ hold: () => false })
  const dataHome = mkdtempSync(join(tmpdir(), "lr-"))
  writeFileSync(join(dataHome, "gateway-loops.json"), JSON.stringify({ s1: runningLoop("s1") }))
  const g = await startGateway({ adapters: () => [{ name: "fake-ws", adapter: { ...a.adapter, workspace: tmpdir() } }], dataHome, port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  try {
    const base = `http://127.0.0.1:${g.port}`
    const headers = { authorization: `Bearer ${await pair(base, "TESTCODE")}`, "content-type": "application/json" }
    const h = (await (await fetch(`${base}/history`, { method: "POST", headers, body: JSON.stringify({ id: "s1" }) })).json()) as { loop: { status: string } }
    assert.equal(h.loop.status, "stopped")
  } finally {
    await g.close()
  }
})
