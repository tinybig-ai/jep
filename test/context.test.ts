// The header that tells a harness it is being driven through jep, and which
// shell tools jep exposes, is added once per conversation and never twice: the
// Telegram bot builds its own, so the adapter must stand down when it is
// already there, and a chat that turned the header off must be able to keep it
// off. contextFor is the one rule every adapter calls.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { JEP_CONTEXT, JEP_CONTEXT_FOOTER, contextFor } from "../src/core/transcript.ts"

const HEADER = `${JEP_CONTEXT}\n\n${JEP_CONTEXT_FOOTER}\n\n`

test("the header is added once, then the conversation is briefed", () => {
  const briefed = new Set<string>()
  assert.equal(contextFor("hello", briefed, "s1"), HEADER)
  assert.ok(briefed.has("s1"))
  assert.equal(contextFor("again", briefed, "s1"), "")
  // another conversation is its own
  assert.equal(contextFor("hello", briefed, "s2"), HEADER)
})

test("a text that already carries the header is not given a second one", () => {
  const briefed = new Set<string>()
  const text = `${JEP_CONTEXT}\n${JEP_CONTEXT_FOOTER}\n\nhello`
  assert.equal(contextFor(text, briefed, "s1"), "")
  // the client briefed it, so the adapter must not repeat it later either
  assert.equal(contextFor("again", briefed, "s1"), "")
})

test("brief:false keeps the header off, and does not mark the conversation briefed", () => {
  const briefed = new Set<string>()
  assert.equal(contextFor("hello", briefed, "s1", false), "")
  assert.ok(!briefed.has("s1"))
  // turning the toggle back on briefs exactly once
  assert.equal(contextFor("hello", briefed, "s1", true), HEADER)
})

// The header is what makes jep-watch/jep-restart/jep-show discoverable, so it
// must actually reach the harness. The fake codex records the prompt it was
// run with, and it is run twice on one conversation: the header rides the
// first turn and only the first.
const TID = "019a0000-bbbb-7ccc-8ddd-000000000002"
const home = await mkdtemp(path.join(os.tmpdir(), "jep-context-"))
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
process.env.CODEX_BIN = bin
process.env.CODEX_HOME = home
const { CodexAdapter } = await import("../src/harnesses/codex.ts")

const promptOf = async (): Promise<string> => {
  const args = (await readFile(argsSeen, "utf8")).split("\n")
  return args.slice(args.lastIndexOf(TID) + 1).join("\n").trim()
}

test("an adapter briefs the first turn of a conversation, and only the first", async () => {
  const a = new CodexAdapter(home)
  await a.prompt(`codex://${TID}`, "first")
  assert.equal(await promptOf(), `${HEADER}first`)
  await a.prompt(`codex://${TID}`, "second")
  assert.equal(await promptOf(), "second")
  await a.close?.()
})

// Compaction folds the early conversation — header and all — into a summary, so
// the next turn has to be briefed again. The marker stays in history forever,
// so the same compaction must not re-brief on every read.
const { createServer } = await import("node:http")
const { OpenCodeAdapter } = await import("../src/harnesses/opencode.ts")

test("a compaction re-briefs the next turn, once", async () => {
  let posts: any[][] = []
  let rows: any[] = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      res.writeHead(200, { "content-type": "application/json" })
      if (req.method === "POST" && url.pathname === "/session/ses_c/message") {
        posts.push(JSON.parse(body).parts)
        res.end(JSON.stringify({ info: { id: "msg_a", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "ok" }] }))
      } else if (url.pathname === "/session/ses_c/message") {
        res.end(JSON.stringify(rows))
      } else res.end("{}")
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  const port = (server.address() as { port: number }).port
  try {
    const a = new OpenCodeAdapter({} as any, "/ws", `http://127.0.0.1:${port}`)
    const textOf = (i: number): string => posts[i]!.find((p) => p.type === "text" && !p.metadata)?.text ?? ""

    await a.prompt("opencode://ses_c", "first", { timeoutMs: 0 })
    assert.equal(textOf(0), `${HEADER}first`)

    // the harness compacted the conversation
    rows = [{ info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ id: "p1", type: "compaction" }] }]
    await a.messages("opencode://ses_c")

    await a.prompt("opencode://ses_c", "second", { timeoutMs: 0 })
    assert.equal(textOf(1), `${HEADER}second`, "the turn after a compaction is briefed again")

    // the same marker read again must not un-brief
    await a.messages("opencode://ses_c")
    await a.prompt("opencode://ses_c", "third", { timeoutMs: 0 })
    assert.equal(textOf(2), "third", "a compaction is handled once, not on every read")
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
