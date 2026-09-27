// Low priority at your limit: a Claude turn carries the header Claude Code's
// own /low-priority sends, through ANTHROPIC_CUSTOM_HEADERS, and only when the
// conversation has it switched on.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dir = await mkdtemp(path.join(os.tmpdir(), "jep-claude-lowpri-"))
const seen = path.join(dir, "headers.txt")
const bin = path.join(dir, "claude")
const lines = [
  { type: "system", subtype: "init", session_id: "s-lp" },
  { type: "assistant", session_id: "s-lp", message: { model: "m", content: [{ type: "text", text: "ok" }] } },
  { type: "result", subtype: "success", session_id: "s-lp" },
]
await writeFile(
  bin,
  `#!/bin/sh
[ "$1" = "--help" ] && exit 0
printf '%s' "$ANTHROPIC_CUSTOM_HEADERS" > "${seen}"
cat <<'EOF2'
${lines.map((l) => JSON.stringify(l)).join("\n")}
EOF2
`,
)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = dir

const { ClaudeAdapter, turnEnv, LOW_PRIORITY_HEADER } = await import("../src/harnesses/claude.ts")

test("the header is added to what is already there, never twice, and off means off", () => {
  assert.equal(turnEnv({ A: "1" }, false).ANTHROPIC_CUSTOM_HEADERS, undefined)
  // a daemon started from inside a low-priority turn inherits the header
  assert.equal(turnEnv({ ANTHROPIC_CUSTOM_HEADERS: LOW_PRIORITY_HEADER }, false).ANTHROPIC_CUSTOM_HEADERS, undefined)
  assert.equal(turnEnv({ ANTHROPIC_CUSTOM_HEADERS: `x-gateway: abc\n${LOW_PRIORITY_HEADER}` }, false).ANTHROPIC_CUSTOM_HEADERS, "x-gateway: abc")
  assert.equal(turnEnv({}, true).ANTHROPIC_CUSTOM_HEADERS, LOW_PRIORITY_HEADER)
  assert.equal(
    turnEnv({ ANTHROPIC_CUSTOM_HEADERS: "x-gateway: abc\nanthropic-usage-limit: fast" }, true).ANTHROPIC_CUSTOM_HEADERS,
    `x-gateway: abc\n${LOW_PRIORITY_HEADER}`,
  )
})

test("a turn carries the header only when the conversation has it on", async () => {
  const a = new ClaudeAdapter(dir)
  const s = await a.createSession("t")
  await a.prompt(s.id, "hi", { harnessSettings: { lowPriority: true } })
  assert.equal(await readFile(seen, "utf8"), LOW_PRIORITY_HEADER)
  await rm(seen)
  await a.prompt(s.id, "hi", { harnessSettings: { lowPriority: false } })
  assert.equal(await readFile(seen, "utf8"), "")
})

test("the phone offers it with the other Claude settings", () => {
  const a = new ClaudeAdapter(dir)
  assert.ok(a.settings().some((x) => x.id === "lowPriority" && x.default === false))
})
