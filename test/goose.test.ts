import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-goose-"))
const bin = path.join(home, "goose.mjs")
const store = path.join(home, "store.json")
// a stand-in for the goose CLI: run / session list / session export, one store file
await writeFile(
  bin,
  `#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs"
const args = process.argv.slice(2)
const store = ${JSON.stringify(store)}
const dirsFile = store + ".dirs"
const db = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {}
// like goose: a session remembers the folder its first run started in
const dirs = existsSync(dirsFile) ? JSON.parse(readFileSync(dirsFile, "utf8")) : {}
const value = (flag) => args[args.indexOf(flag) + 1]
if (args[0] === "--version") { console.log("1.57.0-test"); process.exit(0) }
if (args[0] === "session" && args[1] === "list") {
  console.log(JSON.stringify(Object.entries(db).map(([name, s]) => ({ id: "2026_" + name, name, working_dir: dirs[name] ?? process.cwd(), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:09Z" }))))
  process.exit(0)
}
if (args[0] === "session" && args[1] === "export") {
  const s = db[value("--name")]
  console.log(JSON.stringify(s ? { provider_name: "openrouter", conversation: s } : {}))
  process.exit(s ? 0 : 1)
}
if (args[0] === "run") {
  const name = value("--name")
  const resumed = args.includes("--resume")
  if (resumed !== (name in db)) { console.error("resume mismatch"); process.exit(3) }
  const conv = db[name] ?? []
  const meta = { userVisible: true, agentVisible: true }
  const user = { id: "u" + conv.length, role: "user", created: 1767225601, content: [{ type: "text", text: value("-t") }], metadata: meta }
  const call = { id: "a" + conv.length, role: "assistant", created: 1767225602, content: [{ type: "toolRequest", id: "t1", toolCall: { status: "success", value: { name: "shell", arguments: { command: "ls" } } } }], metadata: meta }
  const result = { id: "r" + conv.length, role: "user", created: 1767225603, content: [{ type: "toolResponse", id: "t1", toolResult: { status: "success", value: { content: [{ type: "text", text: "a.txt" }], isError: false } } }], metadata: meta }
  const answer = { id: "b" + conv.length, role: "assistant", created: 1767225604, content: [{ type: "text", text: "GOOSE_OK" }], metadata: { ...meta, inference: { provider: "openrouter", requestedModel: "m1" }, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, elapsedMs: 40 } } }
  const hidden = { id: "h" + conv.length, role: "user", created: 1767225601, content: [{ type: "text", text: "<turn-context>" }], metadata: { userVisible: false, agentVisible: true } }
  db[name] = [...conv, user, hidden, call, result, answer]
  writeFileSync(store, JSON.stringify(db))
  dirs[name] ??= process.cwd()
  writeFileSync(dirsFile, JSON.stringify(dirs))
  for (const m of [call, result, answer]) console.log(JSON.stringify({ type: "message", message: m }))
  console.log(JSON.stringify({ type: "complete", total_tokens: 10 }))
  process.exit(0)
}
process.exit(2)
`,
)
await chmod(bin, 0o755)
await writeFile(path.join(home, "config.yaml"), "GOOSE_PROVIDER: openrouter\nGOOSE_MODEL: m1\n")
process.env.JEP_GOOSE_BIN = bin
process.env.JEP_GOOSE_CONFIG = path.join(home, "config.yaml")

const { startGooseAdapter } = await import("../src/harnesses/goose.ts")

test("Goose keeps a conversation across turns and maps tools, usage and hidden notes", async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const adapter = await startGooseAdapter(workspace)
  assert.equal((await adapter.health()).healthy, true)
  assert.equal(await adapter.defaultModel(), "openrouter/m1")

  const session = await adapter.createSession("t")
  const events = adapter.events()[Symbol.asyncIterator]()
  await events.next()
  const reply = await adapter.prompt(session.id, "hello", { quote: "earlier" })
  assert.equal((reply.parts[0] as { text: string }).text, "GOOSE_OK")
  assert.equal(reply.model, "openrouter/m1")
  assert.deepEqual(reply.tokens, { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } })

  // a second turn resumes the same goose session
  await adapter.prompt(session.id, "again")
  const messages = await adapter.messages(session.id)
  const users = messages.filter((m) => m.role === "user")
  assert.deepEqual(users[0]?.parts, [{ kind: "quote", text: "earlier" }, { kind: "text", text: "hello" }])
  assert.equal(users.length, 2) // the hidden turn-context notes and tool results are not messages
  const tool = messages.flatMap((m) => m.parts).find((p) => p.kind === "tool")
  assert.ok(tool && tool.kind === "tool")
  assert.equal(tool.name, "shell")
  assert.equal(tool.output, "a.txt")
  assert.equal(tool.status, "completed")

  const seen: string[] = []
  for (;;) {
    const next = await events.next()
    seen.push(next.value.type)
    if (next.value.type === "session.idle") break
  }
  assert.ok(seen.includes("part.updated") && seen.includes("part.delta"))
  assert.equal((await adapter.listSessions()).length, 1)
  await adapter.close()
})

test("Goose lists the models of its custom providers after the default", async () => {
  const { mkdir } = await import("node:fs/promises")
  await mkdir(path.join(home, "custom_providers"), { recursive: true })
  await writeFile(path.join(home, "custom_providers", "p.json"), JSON.stringify({ name: "custom_p", models: [{ name: "m1" }, { name: "m2" }] }))
  const adapter = await startGooseAdapter(await mkdtemp(path.join(home, "workspace-")))
  assert.deepEqual(await adapter.models(), [
    { providerID: "openrouter", modelID: "m1" },
    { providerID: "custom_p", modelID: "m1" },
    { providerID: "custom_p", modelID: "m2" },
  ])
  await adapter.close()
})

test("a goose adapter lists only the sessions of its own folder, not those of a folder inside it", async () => {
  const parent = await mkdtemp(path.join(home, "parent-"))
  const child = path.join(parent, "child")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(child)
  const outer = await startGooseAdapter(parent)
  const inner = await startGooseAdapter(child)
  try {
    const s = await inner.createSession("in the child")
    await inner.prompt(s.id, "hello")
    const innerIds = (await inner.listSessions()).map((x) => x.id)
    const outerIds = (await outer.listSessions()).map((x) => x.id)
    assert.ok(innerIds.includes(s.id))
    assert.ok(!outerIds.includes(s.id), "goose's -w matches by prefix; the parent must not claim the child's chat")
  } finally {
    await outer.close?.()
    await inner.close?.()
  }
})

test("messages stamped in the same second keep the record's order", async () => {
  const { mapGooseMessages } = await import("../src/harnesses/goose.ts")
  const meta = { userVisible: true, agentVisible: true }
  const msgs = mapGooseMessages(
    [
      { id: "u", role: "user", created: 1767225601, content: [{ type: "text", text: "hi" }], metadata: meta },
      { id: "a", role: "assistant", created: 1767225601, content: [{ type: "text", text: "on it" }], metadata: meta },
      { id: "b", role: "assistant", created: 1767225601, content: [{ type: "text", text: "done" }], metadata: meta },
    ],
    "goose://x",
  )
  const times = msgs.map((m) => m.time)
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "assistant"])
  assert.ok(times[0]! < times[1]! && times[1]! < times[2]!, `strictly increasing: ${times}`)
  assert.equal(times[0], 1767225601000)
})
