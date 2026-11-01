// MCP servers a client defines for one conversation: checked, kept with the
// conversation (in a file only this user can read), handed to every turn, and
// refused outright for a harness that cannot take them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, statSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConversationMcp } from "../src/core/mcp.ts"
import { startGateway } from "../src/clients/gateway/index.ts"
import { fakeAdapter, pair } from "./support/gateway.ts"

test("a definition is checked: names, reserved names, spaces, env", () => {
  const ok = parseConversationMcp({ mm: { command: "factormost-tools", args: ["--character", "ada"], env: { MM_TOKEN: "abc" } } })
  assert.equal(ok.ok, true)
  assert.deepEqual(parseConversationMcp(undefined), { ok: true, value: {} })
  for (const bad of [
    { "jep-tools": { command: "x" } },
    { "Bad Name": { command: "x" } },
    { a: { command: "has space" } },
    { a: { command: "x", args: ["two words"] } },
    { a: { command: "x", env: { "1BAD": "v" } } },
    { a: { command: "x", env: { OK: "two words" } } },
    { a: "not an object" },
    ["array"],
    Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, { command: "x" }])),
  ])
    assert.equal(parseConversationMcp(bad).ok, false, JSON.stringify(bad).slice(0, 60))
})

async function gatewayWith(takesMcp: boolean) {
  const base = fakeAdapter()
  const seen: unknown[] = []
  const adapter = {
    ...base,
    ...(takesMcp ? { takesMcp: true } : {}),
    async prompt(sessionID: string, text: string, opts?: { mcp?: unknown }) {
      seen.push(opts?.mcp)
      return base.prompt(sessionID, text)
    },
  }
  const dataHome = mkdtempSync(join(tmpdir(), "gw-mcp-"))
  const gw = await startGateway({ adapters: () => [{ name: "fake-ws", adapter }], dataHome, port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  const url = `http://127.0.0.1:${gw.port}`
  const token = await pair(url, "TESTCODE")
  const call = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  return { gw, call, seen, dataHome }
}

const def = { mm: { command: "factormost-tools", env: { MM_TOKEN: "secret" } } }

test("a conversation's servers reach every turn, and the file holding them is private", async (t) => {
  const { gw, call, seen, dataHome } = await gatewayWith(true)
  t.after(() => gw.close())
  const made = await call("/new", { workspace: "fake-ws", mcp: def })
  assert.equal(made.status, 200)
  const { session } = (await made.json()) as { session: { id: string } }
  const r = await call("/prompt", { id: session.id, text: "hi" })
  assert.equal(r.status, 200)
  assert.deepEqual(seen.at(-1), def)
  const file = join(dataHome, "gateway-mcp.json")
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.match(readFileSync(file, "utf8"), /factormost-tools/)
})

test("a harness that cannot take them refuses the conversation instead of dropping them", async (t) => {
  const { gw, call } = await gatewayWith(false)
  t.after(() => gw.close())
  const r = await call("/new", { workspace: "fake-ws", mcp: def })
  assert.equal(r.status, 400)
  assert.match(((await r.json()) as { error: string }).error, /cannot take MCP servers/)
  // without servers the same conversation is fine
  assert.equal((await call("/new", { workspace: "fake-ws" })).status, 200)
})

test("a bad definition is refused with the reason", async (t) => {
  const { gw, call } = await gatewayWith(true)
  t.after(() => gw.close())
  const r = await call("/new", { workspace: "fake-ws", mcp: { jep: { command: "x" } } })
  assert.equal(r.status, 400)
  assert.match(((await r.json()) as { error: string }).error, /jep's own/)
})

test("deleting by the real id also removes a definition still kept under the placeholder", async (t) => {
  const base = fakeAdapter()
  // a harness whose new conversations start as "s1" and are later known as "real-1"
  const real = { id: "real-1", title: "Test", workspace: "/tmp/ws", createdAt: 1, updatedAt: 2 }
  const adapter = {
    ...base,
    takesMcp: true,
    canonicalId: (id: string) => (id === "s1" ? "real-1" : id),
    async getSession(id: string) { return id === "real-1" || id === "s1" ? real : null },
    async listSessions() { return [real] },
    async deleteSession() { return true },
  }
  const dataHome = mkdtempSync(join(tmpdir(), "gw-mcp-"))
  const gw = await startGateway({ adapters: () => [{ name: "fake-ws", adapter }], dataHome, port: 0, pairCode: "TESTCODE", pairLimit: 100 })
  t.after(() => gw.close())
  const url = `http://127.0.0.1:${gw.port}`
  const token = await pair(url, "TESTCODE")
  const call = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  assert.equal((await call("/new", { workspace: "fake-ws", mcp: def })).status, 200)
  const file = join(dataHome, "gateway-mcp.json")
  assert.match(readFileSync(file, "utf8"), /"s1"/)
  assert.equal((await call("/delete", { id: "real-1" })).status, 200)
  assert.doesNotMatch(readFileSync(file, "utf8"), /factormost-tools/, "the token went with the conversation")
})
