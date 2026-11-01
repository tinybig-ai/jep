// A conversation's title is what the person typed first. jep's context header rides
// the first prompt of every conversation, so a title read straight from the record
// showed "[jep context — background only…]" in every list.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { JEP_CONTEXT, JEP_CONTEXT_FOOTER } from "../src/core/transcript.ts"

test("a claude conversation's title leaves out jep's header and attachment list", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jep-titles-"))
  const ws = path.join(home, "ws")
  await mkdir(ws)
  process.env.CLAUDE_HOME = home
  const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")
  const a = new ClaudeAdapter(ws, { dataHome: home })
  t.after(() => a.close())
  // where claude keeps a project's transcripts: the folder path with / and . as -
  const dir = path.join(home, "projects", ws.replace(/[/.]/g, "-"))
  await mkdir(dir, { recursive: true })
  const id = "0b7c3a52-4444-4a4a-9b9b-7cfc686cbe0e"
  const text = `${JEP_CONTEXT}\n\n${JEP_CONTEXT_FOOTER}\n\nfix the login page\n\nAttached files:\n- /tmp/a.png`
  const row = { type: "user", sessionId: id, cwd: ws, timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: text } }
  await writeFile(path.join(dir, `${id}.jsonl`), JSON.stringify(row) + "\n")
  const listed = await a.listSessions()
  const mine = listed.find((s) => s.id.endsWith(id))
  assert.ok(mine, `listed: ${JSON.stringify(listed.map((s) => s.id))}`)
  assert.equal(mine!.title, "fix the login page")
})
