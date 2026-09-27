// Claude takes a quote as a content block of its own, ahead of the message
// (stream-json on stdin), and its transcript keeps the blocks apart, so the
// quote comes back without anyone reading it out of the words.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-claude-quote-"))
const SID = "0b7c3a52-1111-4a4a-9b9b-7cfc686cbe0e"
const dir = path.join(home, "projects", "-work-probe")
await mkdir(dir, { recursive: true })
const stdinSeen = path.join(home, "stdin.txt")
const argsSeen = path.join(home, "args.txt")
const bin = path.join(home, "claude")
await writeFile(
  bin,
  `#!/bin/sh
[ "$1" = "--help" ] && exit 0
printf '%s\\n' "$@" > "${argsSeen}"
cat > "${stdinSeen}"
echo '{"type":"system","subtype":"init","session_id":"${SID}"}'
echo '{"type":"result","subtype":"success","session_id":"${SID}","result":"ok"}'
`,
)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = home

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("a quote goes in as its own block, and the words stay as typed", async (t) => {
  const a = new ClaudeAdapter(home, { dataHome: home })
  t.after(() => a.close())
  await a.prompt(`claude://${SID}`, "yes, that", { quote: "shall I?", harnessSettings: { dangerouslySkipPermissions: true } })
  const args = (await readFile(argsSeen, "utf8")).trim().split("\n")
  assert.ok(args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json")
  assert.ok(!args.includes("yes, that"), "the message is on stdin, not an argument")
  const sent = JSON.parse((await readFile(stdinSeen, "utf8")).trim())
  assert.deepEqual(sent.message.content, [
    { type: "text", text: "[in reply to]\n> shall I?" },
    { type: "text", text: "yes, that" },
  ])
})

test("without a quote the message is still an argument", async (t) => {
  const a = new ClaudeAdapter(home, { dataHome: home })
  t.after(() => a.close())
  await a.prompt(`claude://${SID}`, "plain", { harnessSettings: { dangerouslySkipPermissions: true } })
  const args = (await readFile(argsSeen, "utf8")).trim().split("\n")
  assert.ok(args.includes("plain"))
  assert.ok(!args.includes("--input-format"))
})

test("the transcript's quote block reads back as a quote; a typed blockquote does not", async (t) => {
  const user = (content: unknown, uuid: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-09-27T10:00:00Z", message: { role: "user", content } })
  await writeFile(
    path.join(dir, `${SID}.jsonl`),
    [
      user([{ type: "text", text: "[in reply to]\n> shall I?" }, { type: "text", text: "yes, that" }], "u1"),
      user("> my own quote\n\nand my words", "u2"),
    ].join("\n") + "\n",
  )
  const a = new ClaudeAdapter("/work/probe", { dataHome: home })
  t.after(() => a.close())
  const rows = await a.messages(`claude://${SID}`)
  assert.deepEqual(rows.map((m) => m.parts), [
    [{ kind: "quote", text: "shall I?" }, { kind: "text", text: "yes, that" }],
    [{ kind: "text", text: "> my own quote\n\nand my words" }],
  ])
})
