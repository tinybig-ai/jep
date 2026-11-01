// A new conversation runs under a placeholder id until Claude names it. The ask server is
// started with the placeholder, so an ask raised in the first turn arrived under that name, and
// no client (which shows the conversation under its real id) ever drew the card: the turn waited
// for an answer forever. The ask must reach clients under the real id.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-claude-ask-"))
const SID = "0b7c3a52-3333-4a4a-9b9b-7cfc686cbe0e"
const bin = path.join(home, "claude.mjs")
// a stand-in for `claude -p`: names the session, then asks permission the way the ask MCP does
await writeFile(
  bin,
  `#!/usr/bin/env node
import net from "node:net"
const args = process.argv.slice(2)
if (args[0] === "--help") { console.log("--permission-prompt-tool"); process.exit(0) }
const config = JSON.parse(args[args.indexOf("--mcp-config") + 1])
const { JEP_ASK_SOCKET, JEP_ASK_SESSION } = config.mcpServers.jep.env
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "${SID}" }))
const conn = net.createConnection(JEP_ASK_SOCKET, () => {
  conn.write(JSON.stringify({ id: "q1", session: JEP_ASK_SESSION, tool: "Bash", input: { command: "ls" }, toolUseID: "tu1" }) + "\\n")
})
conn.on("data", () => {
  conn.end()
  console.log(JSON.stringify({ type: "result", subtype: "success", session_id: "${SID}", result: "done" }))
  process.exit(0)
})
`,
)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = home

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("an ask raised in a new conversation's first turn reaches clients under its real id", async (t) => {
  const a = new ClaudeAdapter(home, { dataHome: home })
  t.after(() => a.close())
  const created = await a.createSession("first")
  assert.match(created.id, /pending/)
  const ac = new AbortController()
  const asks: { sessionID: string; id: string }[] = []
  ;(async () => {
    for await (const evt of a.events(ac.signal)) {
      if (evt.type === "ask.requested") {
        asks.push({ sessionID: evt.sessionID, id: evt.ask.id })
        await a.respondAsk(evt.sessionID, evt.ask.id, "allow")
      }
    }
  })().catch(() => {})
  await a.prompt(created.id, "list the files")
  ac.abort()
  assert.equal(asks.length, 1)
  assert.equal(asks[0]!.sessionID, `claude://${SID}`, "not the placeholder it started under")
})
