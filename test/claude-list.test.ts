// adapters/claude.ts: listing reads ~/.claude/projects, which holds every
// Claude Code transcript on the machine. Six served workspaces used to read and
// parse the whole store six times per listing, and a watcher cleared the cache
// on any change, so one busy transcript elsewhere made every listing a full
// re-read. A file is parsed once, shared by every adapter, until it changes.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "claude-home-"))
process.env.CLAUDE_HOME = home
const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

const ws = "/work/space"
const project = join(home, "projects", "-work-space")
mkdirSync(project, { recursive: true })
const file = join(project, "aaaaaaaa-0000-0000-0000-000000000001.jsonl")
const line = (o: object) => JSON.stringify(o) + "\n"
const titled = (t: string) =>
  line({ type: "user", cwd: ws, sessionId: "aaaaaaaa-0000-0000-0000-000000000001", timestamp: "2026-10-01T10:00:00Z", message: { content: "hello" } }) +
  line({ type: "custom-title", customTitle: t, timestamp: "2026-10-01T10:00:01Z" })

const titles = async (a: InstanceType<typeof ClaudeAdapter>) => (await a.listSessions()).map((s) => s.title)

test("a transcript is parsed once for every adapter, and again only once it changes", async () => {
  // a whole second, so setting it back later lands on exactly the same time
  const when = new Date("2026-10-01T10:00:05Z")
  writeFileSync(file, titled("first"))
  utimesSync(file, when, when)
  const one = new ClaudeAdapter(ws)
  const two = new ClaudeAdapter(ws)
  assert.deepEqual(await titles(one), ["first"])

  // same size, same time, different words: a listing that read the file would see "secnd"
  writeFileSync(file, titled("secnd"))
  utimesSync(file, when, when)
  assert.deepEqual(await titles(one), ["first"], "an unchanged file is not read again")
  assert.deepEqual(await titles(two), ["first"], "another adapter uses the same parse")

  appendFileSync(file, line({ type: "custom-title", customTitle: "third", timestamp: "2026-10-01T10:00:02Z" }))
  assert.deepEqual(await titles(two), ["third"], "a grown file is read again")
  assert.deepEqual(await titles(one), ["third"])
})
