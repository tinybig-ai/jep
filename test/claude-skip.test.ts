// "Skip permission prompts" must still attach the ask host: measured against the
// real CLI, bypass sends only AskUserQuestion to it, and without it -p does not
// offer that tool at all.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-claude-skip-"))
const SID = "0b7c3a52-2222-4a4a-9b9b-7cfc686cbe0e"
const argsSeen = path.join(home, "args.txt")
const bin = path.join(home, "claude")
await writeFile(
  bin,
  `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "--permission-prompt-tool"
  exit 0
fi
printf '%s\\n' "$@" > "${argsSeen}"
echo '{"type":"system","subtype":"init","session_id":"${SID}"}'
echo '{"type":"result","subtype":"success","session_id":"${SID}","result":"ok"}'
`,
)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = home

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("skipping permissions keeps both the bypass flag and the ask host", async (t) => {
  const a = new ClaudeAdapter(home, { dataHome: home })
  t.after(() => a.close())
  await a.prompt(`claude://${SID}`, "hi", { harnessSettings: { dangerouslySkipPermissions: true } })
  const args = (await readFile(argsSeen, "utf8")).trim().split("\n")
  assert.ok(args.includes("--dangerously-skip-permissions"))
  assert.ok(args.includes("--permission-prompt-tool"))
})

test("a conversation's own MCP servers are added beside the ask host, and their tools allowed", async (t) => {
  const a = new ClaudeAdapter(home, { dataHome: home })
  t.after(() => a.close())
  await a.prompt(`claude://${SID}`, "hi", { mcp: { mm: { command: "factormost-tools", env: { MM_TOKEN: "tok" } } } })
  const args = (await readFile(argsSeen, "utf8")).trim().split("\n")
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!)
  assert.deepEqual(Object.keys(config.mcpServers).sort(), ["jep", "mm"])
  assert.deepEqual(config.mcpServers.mm, { command: "factormost-tools", args: [], env: { MM_TOKEN: "tok" } })
  assert.match(args[args.indexOf("--allowed-tools") + 1]!, /(^|,)mcp__mm(,|$)/)
})
