import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
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
  // a test can make the listing fail (a timeout, a locked store) ...
  if (existsSync(store + ".fail")) { console.error("database is locked"); process.exit(1) }
  // ... or leave an older session of the same name behind, as a turn that ran without --resume does
  const twins = existsSync(store + ".twin") ? Object.keys(db).map((name) => ({ id: "2025_" + name, name, working_dir: dirs[name] ?? process.cwd(), created_at: "2025-12-31T00:00:00Z", updated_at: "2025-12-31T00:00:09Z" })) : []
  if (twins.length) { console.log(JSON.stringify([...Object.entries(db).map(([name]) => ({ id: "2026_" + name, name, working_dir: dirs[name] ?? process.cwd(), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:09Z" })), ...twins])); process.exit(0) }
  console.log(JSON.stringify(Object.entries(db).map(([name, s]) => ({ id: "2026_" + name, name, working_dir: dirs[name] ?? process.cwd(), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:09Z" }))))
  process.exit(0)
}
if (args[0] === "session" && args[1] === "export") {
  const s = db[value("--name")]
  console.log(JSON.stringify(s ? { provider_name: "openrouter", conversation: s } : {}))
  process.exit(s ? 0 : 1)
}
if (args[0] === "run" && (value("-t") ?? "").includes("WEDGE")) {
  // goose waiting on a tool that never returns; once the tool is killed it carries on and finishes the turn
  const { spawn } = await import("node:child_process")
  const tool = spawn("sh", ["-c", "sleep 600"], { stdio: "ignore" })
  writeFileSync(store + ".wedge", String(tool.pid))
  await new Promise((r) => tool.on("exit", r))
}
if (args[0] === "run" && (value("-t") ?? "").includes("STUCK")) {
  // a goose waiting on a tool that will not end: it ignores SIGTERM, and so does the tool it started
  const { spawn } = await import("node:child_process")
  process.on("SIGTERM", () => {})
  const tool = spawn("sh", ["-c", "trap '' TERM; sleep 600"], { stdio: "ignore" })
  writeFileSync(store + ".pids", JSON.stringify({ goose: process.pid, tool: tool.pid }))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
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
const logDir = path.join(home, "logs")
process.env.JEP_GOOSE_LOG_DIR = logDir

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


// what goose 1.57 writes when a provider refuses with Retry-After: the JSON escapes the quotes
const refusal = (conversation: string, seconds: number) =>
  `{"level":"WARN","fields":{"message":"Request failed, retrying (1/3): RateLimitExceeded { details: \\"Go usage limit exceeded\\", retry_delay: Some(${seconds}s) }"},"span":{"gen_ai.conversation.id":"${conversation}"}}`

test("a refusal goose would sit out for an hour reads as words; a short one does not", async () => {
  const { gooseRefusal } = await import("../src/harnesses/goose.ts")
  assert.match(gooseRefusal(refusal("c1", 3600)) ?? "", /Go usage limit exceeded.*60 min/)
  assert.equal(gooseRefusal(refusal("c1", 5)), null, "a few seconds is goose's to retry")
  assert.equal(gooseRefusal('{"fields":{"message":"RateLimitExceeded { details: \\"x\\", retry_delay: None }"}}'), null)
})

test("the log watcher reports this run's refusal and ignores another conversation's", async () => {
  const { watchGooseLog } = await import("../src/harnesses/goose.ts")
  const { mkdir, appendFile } = await import("node:fs/promises")
  const since = Date.now()
  const dir = path.join(logDir, new Date(since).toISOString().slice(0, 10))
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, "run.log")
  const seen: string[] = []
  const stop = watchGooseLog(since, "mine", (m) => seen.push(m))
  try {
    await appendFile(file, refusal("theirs", 3600) + "\n")
    await new Promise((r) => setTimeout(r, 3_500))
    assert.equal(seen.length, 0, "another run's refusal is not this turn's")
    await appendFile(file, refusal("mine", 3600) + "\n")
    await new Promise((r) => setTimeout(r, 3_500))
    assert.equal(seen.length, 1)
    assert.match(seen[0]!, /usage limit/)
  } finally {
    stop()
  }
})


test("two goose sessions under one name are one conversation in the list", async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const adapter = await startGooseAdapter(workspace)
  const session = await adapter.createSession("t")
  await adapter.prompt(session.id, "hi")
  await writeFile(store + ".twin", "1")
  try {
    const list = (await adapter.listSessions()).filter((x) => x.id === session.id)
    assert.equal(list.length, 1, "one row, not one per goose session")
    assert.equal(list[0]!.createdAt, Date.parse("2025-12-31T00:00:00Z"), "it begins when the first one did")
  } finally {
    await rm(store + ".twin", { force: true })
  }
})

test("a listing that fails does not make a running conversation look new", async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const adapter = await startGooseAdapter(workspace)
  const session = await adapter.createSession("t")
  await adapter.prompt(session.id, "one")
  await writeFile(store + ".fail", "1")
  try {
    // goose would exit 3 on "resume mismatch" if the second turn started a fresh session
    const reply = await adapter.prompt(session.id, "two")
    assert.equal(reply.role, "assistant")
  } finally {
    await rm(store + ".fail", { force: true })
  }
})

test("stop ends a goose that ignores SIGTERM, tool and all, within seconds", { timeout: 20_000 }, async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const adapter = await startGooseAdapter(workspace)
  const session = await adapter.createSession("t")
  const turn = adapter.prompt(session.id, "STUCK").then(() => "finished", (e) => (e as Error).name)
  const pidsFile = store + ".pids"
  for (let i = 0; i < 100 && !existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 50))
  const { goose, tool } = JSON.parse(readFileSync(pidsFile, "utf8")) as { goose: number; tool: number }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  assert.ok(alive(goose) && alive(tool))
  const t0 = Date.now()
  assert.equal(await adapter.abort(session.id), true)
  assert.equal(await turn, "TurnAbortedError")
  assert.ok(Date.now() - t0 < 8_000, `stopped in ${Date.now() - t0} ms`)
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(!alive(goose), "goose is gone")
  assert.ok(!alive(tool), "so is the tool it was waiting on")
  await rm(pidsFile, { force: true })
})

test("a tool goose is stuck on can be killed, and goose finishes the turn", { timeout: 20_000 }, async () => {
  const workspace = await mkdtemp(path.join(home, "workspace-"))
  const adapter = await startGooseAdapter(workspace)
  const session = await adapter.createSession("t")
  const turn = adapter.prompt(session.id, "WEDGE").then((m) => m.role, (e) => (e as Error).name)
  const file = store + ".wedge"
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50))
  const tool = Number(readFileSync(file, "utf8"))
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  assert.ok(alive(tool))
  assert.equal(await adapter.unwedge(session.id, 60_000), true)
  assert.equal(await turn, "assistant", "the turn was not abandoned: goose saw the tool fail and finished")
  assert.ok(!alive(tool))
  assert.equal(await adapter.unwedge(session.id, 60_000), false, "nothing running now")
  await rm(file, { force: true })
})
