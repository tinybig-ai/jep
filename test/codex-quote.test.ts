// codex takes nothing but text, so a quote is a headed block ahead of the
// message, and messages() takes back exactly that block.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-codex-quote-"))
const TID = "019a0000-aaaa-7bbb-8ccc-000000000001"
const argsSeen = path.join(home, "args.txt")
const bin = path.join(home, "codex")
await writeFile(
  bin,
  `#!/bin/sh
printf '%s\\n' "$@" > "${argsSeen}"
echo '{"type":"thread.started","thread_id":"${TID}"}'
echo '{"type":"turn.completed","usage":{}}'
`,
)
await chmod(bin, 0o755)
await mkdir(path.join(home, "sessions", "2026", "09", "27"), { recursive: true })
process.env.CODEX_BIN = bin
process.env.CODEX_HOME = home

const { CodexAdapter } = await import("../src/harnesses/codex.ts")

test("a quote goes in as the headed block, and comes back as a quote part", async () => {
  const a = new CodexAdapter(home)
  await a.prompt(`codex://${TID}`, "yes, that", { quote: "shall I?" })
  const args = (await readFile(argsSeen, "utf8")).split("\n")
  const prompt = args.slice(args.lastIndexOf(TID) + 1).join("\n").trim()
  assert.equal(prompt, "[in reply to]\n> shall I?\n\nyes, that")

  const said = (text: string) =>
    JSON.stringify({ timestamp: "2026-09-27T10:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } })
  await writeFile(
    path.join(home, "sessions", "2026", "09", "27", `rollout-2026-09-27T10-00-00-${TID}.jsonl`),
    [
      JSON.stringify({ timestamp: "2026-09-27T10:00:00Z", type: "session_meta", payload: { id: TID, cwd: home } }),
      said(prompt),
      said("> my own quote\n\nand my words"),
    ].join("\n") + "\n",
  )
  const rows = (await a.messages(`codex://${TID}`)).filter((m) => m.role === "user")
  assert.deepEqual(rows.map((m) => m.parts), [
    [{ kind: "quote", text: "shall I?" }, { kind: "text", text: "yes, that" }],
    [{ kind: "text", text: "> my own quote\n\nand my words" }],
  ])
  await a.close?.()
})
