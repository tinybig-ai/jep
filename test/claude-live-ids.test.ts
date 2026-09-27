// A Claude turn is several API messages (think, say, call a tool, then say
// more), and Claude Code writes each of their content blocks as a transcript
// entry of its own. The live stream must name each block the way the
// transcript does. Keyed by the session instead, every block of the turn piled
// into one live row, and the phone showed the reply once from the record and
// again, glued together, in the "responding…" row.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, copyFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { DomainEvent } from "../src/core/types.ts"

const home = await mkdtemp(path.join(os.tmpdir(), "jep-claude-live-"))
const SID = "e25596bb-7857-4bcf-8abf-18069bc9a890"
const fixture = path.join(import.meta.dirname, "..", "fixture")
await mkdir(path.join(home, "projects", "-work-probe"), { recursive: true })
// a real turn Claude Code 2.1.283 ran (haiku: a sentence, `echo hi`, "done"),
// the transcript it wrote and the stream-json it printed while writing it
await copyFile(path.join(fixture, "claude-two-messages.jsonl"), path.join(home, "projects", "-work-probe", `${SID}.jsonl`))
const bin = path.join(home, "claude")
await writeFile(
  bin,
  `#!/bin/sh
[ "$1" = "--help" ] && exit 0
cat "${path.join(fixture, "claude-two-messages.stream.jsonl")}"
`,
)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = home

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("each streamed block is the record's own message, not one row for the turn", async (t) => {
  const a = new ClaudeAdapter(home, { dataHome: home })
  const seen: DomainEvent[] = []
  const stop = new AbortController()
  const reading = (async () => {
    for await (const e of a.events(stop.signal)) seen.push(e)
  })()
  await a.prompt(`claude://${SID}`, "go", { harnessSettings: { dangerouslySkipPermissions: true } })
  await new Promise((r) => setTimeout(r, 50))
  stop.abort()
  await reading.catch(() => {})
  t.after(() => a.close())

  const record = await a.messages(`claude://${SID}`)
  const assistant = new Map(record.filter((m) => m.role === "assistant").map((m) => [m.id, m]))

  // what streamed into each message, by the id it streamed under
  const streamed = new Map<string, string>()
  for (const e of seen) {
    if (e.type !== "part.delta" || e.partType !== "text") continue
    streamed.set(e.messageID, (streamed.get(e.messageID) ?? "") + e.text)
  }
  assert.ok(streamed.size >= 2, "the turn's two replies stream as two messages")
  for (const [id, text] of streamed) {
    const m = assistant.get(id)
    assert.ok(m, `streamed message ${id} is a message in the record`)
    const recorded = m.parts.filter((p) => p.kind === "text").map((p) => p.text).join("")
    assert.equal(text, recorded, "a live row holds its own message's words, nothing more")
  }

  // the tool call and its result land on the record's tool message too
  const tools = seen.filter((e) => e.type === "part.updated" && e.partType === "tool")
  assert.ok(tools.length >= 2)
  for (const e of tools) {
    const m = assistant.get((e as { messageID: string }).messageID)
    assert.ok(m?.parts.some((p) => p.kind === "tool"), "the tool's live row is the record's tool message")
  }

  // no two messages share a part id, so a client keying by part alone does not glue them
  const partIDs = new Map<string, string>()
  for (const e of seen) {
    if (e.type !== "part.delta") continue
    const owner = partIDs.get(e.partID)
    assert.ok(!owner || owner === e.messageID, `part ${e.partID} belongs to one message`)
    partIDs.set(e.partID, e.messageID)
  }
})
