// Compacting a Claude conversation: `claude -p --resume <id> /compact`, and a
// compacted transcript read back with the same divider opencode's draws.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, readFile, copyFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-claude-compact-"))
const SID = "f22b4dff-6b55-4b38-9ea9-7cfc686cbe0e"
await mkdir(path.join(home, "projects", "-work-probe"), { recursive: true })
// a real transcript Claude Code 2.1.283 wrote for a turn followed by /compact
await copyFile(path.join(import.meta.dirname, "..", "fixture", "claude-compacted.jsonl"), path.join(home, "projects", "-work-probe", `${SID}.jsonl`))

const argsSeen = path.join(home, "args.txt")
const bin = path.join(home, "claude")
await writeFile(
  bin,
  `#!/bin/sh
[ "$1" = "--help" ] && exit 0
printf '%s\\n' "$@" > "${argsSeen}"
[ -n "$FAKE_SLOW" ] && sleep 2
echo '{"is_error":false,"num_turns":0,"session_id":"${SID}"}'
`,
)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = home

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("a compacted transcript reads as the conversation plus one divider", async () => {
  const a = new ClaudeAdapter("/work/probe")
  const rows = await a.messages(`claude://${SID}`)
  const shape = rows.map((m) => [m.role, m.parts.map((p) => (p.kind === "text" ? p.text : p.kind === "other" ? p.nativeType : p.kind)).join("|")])
  assert.deepEqual(shape, [
    ["user", "Remember the word walrus. Reply with ok."],
    ["assistant", "ok"],
    ["user", "compaction"],
  ])
})

test("compact runs /compact on the conversation and reports how it went", async () => {
  const a = new ClaudeAdapter(home)
  assert.equal(await a.compact(`claude://${SID}`), true)
  const args = (await readFile(argsSeen, "utf8")).trim().split("\n")
  assert.deepEqual(args, ["-p", "--output-format", "json", "--resume", SID, "/compact"])
})

test("compact is refused while the conversation is busy, not run twice", async () => {
  process.env.FAKE_SLOW = "1"
  const a = new ClaudeAdapter(home)
  const first = a.compact(`claude://${SID}`)
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(await a.compact(`claude://${SID}`), false)
  assert.equal(await first, true)
  delete process.env.FAKE_SLOW
})
