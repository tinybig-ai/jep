import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startGateway } from "../src/clients/gateway/index.ts"
import { fakeAdapter, pair } from "./support/gateway.ts"

test("Keep going conditions persist per conversation without starting work or breaking old clients", async (t) => {
  const dataHome = await mkdtemp(join(tmpdir(), "jep-keep-until-"))
  t.after(() => rm(dataHome, { recursive: true, force: true }))
  const adapter = fakeAdapter()
  let prompts = 0
  adapter.prompt = async () => { prompts++; throw new Error("saving must not start a turn") }
  const boot = () => startGateway({ adapters: () => [{ name: "test", adapter }], dataHome, port: 0, pairCode: "TESTCODE" })
  let g = await boot()
  t.after(() => g.close())
  let base = `http://127.0.0.1:${g.port}`
  const token = await pair(base, "TESTCODE")
  const post = (path: string, body: object) => fetch(base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  const call = async (path: string, body: object) => (await post(path, body)).json() as Promise<any>
  assert.equal((await call("/conversation-settings", { id: "s1" })).until, "")
  assert.equal((await call("/set-conversation-mode", { id: "s1", mode: "keep", until: "  login works  " })).until, "login works")
  assert.equal(prompts, 0)
  assert.equal((await call("/conversation-settings", { id: "other" })).until, "")
  // An older client sets only the mode. It must not erase the saved condition.
  await call("/set-conversation-mode", { id: "s1", mode: "normal" })
  await g.close()
  g = await boot()
  base = `http://127.0.0.1:${g.port}`
  const held = await call("/conversation-settings", { id: "s1" })
  assert.equal(held.mode, "normal")
  assert.equal(held.until, "login works")
  for (const until of [123, null, "x".repeat(1001)]) {
    assert.equal((await post("/set-conversation-mode", { id: "s1", mode: "keep", until })).status, 400)
  }
  assert.equal((await call("/conversation-settings", { id: "s1" })).until, "login works")
  assert.equal((await call("/set-conversation-mode", { id: "s1", mode: "keep", until: "" })).until, "")
  assert.equal((await call("/conversation-settings", { id: "s1" })).until, "")
  assert.equal(prompts, 0)
  await call("/set-conversation-mode", { id: "pending", mode: "keep", until: "the new session is ready" })
  // Test a fresh canonical id, not one with an existing settings record.
  adapter.canonicalId = (id) => id === "pending" ? "new-session" : id
  assert.equal((await call("/conversation-settings", { id: "new-session" })).until, "the new session is ready")
  assert.equal((await call("/conversation-settings", { id: "new-session" })).mode, "keep")
})
