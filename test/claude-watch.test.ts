// A Claude conversation continued on the desktop reaches a phone that has it
// open: the adapter watches the transcripts and says a conversation changed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, appendFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-claude-watch-"))
const project = path.join(home, "projects", "-some-project")
await mkdir(project, { recursive: true })
process.env.CLAUDE_HOME = home
process.env.JEP_CHANGE_QUIET_MS = "100"

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("a transcript written elsewhere is announced once per burst, as session.changed", async () => {
  const a = new ClaudeAdapter(home)
  const ac = new AbortController()
  const seen: unknown[] = []
  const reading = (async () => {
    for await (const evt of a.events(ac.signal)) if (evt.type === "session.changed") seen.push(evt)
  })()
  await new Promise((r) => setTimeout(r, 200)) // the watcher is up
  const file = path.join(project, "abc-123.jsonl")
  // a desktop turn: many appends in quick succession
  for (let i = 0; i < 5; i++) await appendFile(file, `{"type":"user","n":${i}}\n`)
  await appendFile(path.join(project, "notes.txt"), "not a transcript\n")
  await new Promise((r) => setTimeout(r, 600))
  ac.abort()
  await a.close()
  await reading
  assert.deepEqual(seen, [{ type: "session.changed", sessionID: "claude://abc-123" }])
})
