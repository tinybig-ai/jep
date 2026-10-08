import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-pi-"))
const bin = path.join(home, "pi.mjs")
await writeFile(
  bin,
  `#!/usr/bin/env node
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("0.84.1-test"); process.exit(0) }
const value = (flag) => args[args.indexOf(flag) + 1]
const dir = value("--session-dir")
const id = value("--session-id")
const prompt = args.at(-1)
await mkdir(dir, { recursive: true })
let file = (await readdir(dir)).find((name) => name.endsWith("_" + id + ".jsonl"))
if (!file) file = "2026-01-01T00-00-00-000Z_" + id + ".jsonl"
const full = path.join(dir, file)
let lines = []
try { lines = (await readFile(full, "utf8")).trim().split("\\n").filter(Boolean) } catch {}
if (!lines.length) lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: process.cwd() }))
const userId = "user-" + lines.length
const assistantId = "assistant-" + lines.length
lines.push(JSON.stringify({ type: "message", id: userId, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1767225601000 } }))
const answer = { role: "assistant", content: [{ type: "text", text: "PI_OK" }], api: "openai-completions", provider: "free-models", model: "auto", usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1767225602000 }
lines.push(JSON.stringify({ type: "message", id: assistantId, parentId: userId, timestamp: "2026-01-01T00:00:02.000Z", message: answer }))
await writeFile(full, lines.join("\\n") + "\\n")
console.log(JSON.stringify({ type: "session", version: 3, id, cwd: process.cwd() }))
console.log(JSON.stringify({ type: "message_start", message: answer }))
console.log(JSON.stringify({ type: "message_update", message: answer, assistantMessageEvent: { type: "text_delta", delta: "PI_OK" } }))
console.log(JSON.stringify({ type: "message_end", message: answer }))
console.log(JSON.stringify({ type: "agent_end", messages: [answer] }))
`,
)
await chmod(bin, 0o755)
await writeFile(path.join(home, "models.json"), JSON.stringify({ providers: { "free-models": { models: [{ id: "auto", input: ["text"], contextWindow: 200000 }] } } }))

process.env.JEP_PI_BIN = bin
process.env.JEP_PI_AGENT_DIR = home

const { startPiAdapter } = await import("../src/harnesses/pi.ts")

test("Pi uses the shared router defaults and keeps a session across turns", async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const dataHome = await mkdtemp(path.join(home, "data-"))
  const adapter = await startPiAdapter(workspace, { dataHome })
  const health = await adapter.health()
  assert.equal(health.healthy, true)
  assert.equal(await adapter.defaultModel(), "free-models/auto")
  assert.deepEqual(await adapter.models(), [{ providerID: "free-models", modelID: "auto" }])

  const session = await adapter.createSession("router test")
  assert.equal((await adapter.listSessions()).length, 1)
  const reply = await adapter.prompt(session.id, "hello", { quote: "previous" })
  assert.equal(reply.role, "assistant")
  assert.equal(reply.parts[0]?.kind, "text")
  assert.equal((reply.parts[0] as { text: string }).text, "PI_OK")

  const messages = await adapter.messages(session.id)
  assert.equal(messages.length, 2)
  assert.deepEqual(messages[0]?.parts, [{ kind: "quote", text: "previous" }, { kind: "text", text: "hello" }])
  assert.equal(messages[1]?.model, "free-models/auto")
  assert.equal(messages[1]?.cost, 0)

  const stream = adapter.events()
  assert.equal((await stream[Symbol.asyncIterator]().next()).value?.type, "server.connected")
  await adapter.close()
})

test("Pi maps the JSON stream and deletes its session", async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const adapter = await startPiAdapter(workspace, { dataHome: await mkdtemp(path.join(home, "data-")) })
  const session = await adapter.createSession()
  const events = adapter.events()[Symbol.asyncIterator]()
  await events.next()
  await adapter.prompt(session.id, "hello")
  const seen: string[] = []
  for (;;) {
    const next = await events.next()
    if (next.done) break
    seen.push(next.value.type)
    if (next.value.type === "session.idle") break
  }
  assert.ok(seen.includes("part.delta"))
  assert.ok(seen.includes("session.idle"))
  assert.equal(await adapter.deleteSession(session.id), true)
  assert.equal((await adapter.listSessions()).length, 0)
  await adapter.close()
})
