// A question is one shape whatever harness asked it. opencode says `multiple`,
// Claude's AskUserQuestion says `multiSelect`; both become the same AskQuestion
// list, the same option ids, and the same answer map. These pin the mapping and
// the MCP server that carries the answers back to Claude.
import { test } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { answersFor, groupAskQuestions, parseOptionIDs, questionAsk } from "../src/core/questions.ts"

test("a question's options carry a question index, and the full label is kept", () => {
  const g = groupAskQuestions([
    { question: "Which store?", header: "Store", options: [{ label: "Postgres" }, { label: "SQLite" }] },
  ])
  assert.equal(g.count, 1)
  assert.deepEqual(
    g.questions[0]?.options.map((o) => o.id),
    ["0:Postgres", "0:SQLite"],
  )
  assert.equal(g.labels.get("0:Postgres"), "Postgres", "the harness gets the whole label, not the clipped id")
  assert.deepEqual(g.keys, ["Which store?"], "answers are keyed by the question text")
})

test("a multi-select is kept per question, and Claude's name for it is understood", () => {
  const g = groupAskQuestions([
    { question: "A?", options: [{ label: "A1" }] },
    { question: "B?", multiSelect: true, options: [{ label: "B1" }, { label: "B2" }] },
  ])
  assert.equal(g.count, 2)
  assert.deepEqual(
    g.questions[1]?.options.map((o) => o.id),
    ["1:B1", "1:B2"],
    "the second question's choices are indexed under 1",
  )
  assert.equal(g.questions[1]?.multiple, true, "multiSelect reads as multiple")
  assert.equal(g.questions[0]?.multiple, undefined)
})

test("answers fold back into one map keyed by each question, in order", () => {
  const g = groupAskQuestions([
    { question: "A?", options: [{ label: "A1" }] },
    { question: "B?", multiSelect: true, options: [{ label: "B1" }, { label: "B2" }] },
  ])
  // one-question ask sends the bare id
  assert.deepEqual(answersFor("0:A1", g), { "A?": "A1" })
  // several questions arrive together, as a JSON array of the picked ids
  assert.deepEqual(answersFor(JSON.stringify(["0:A1", "1:B1", "1:B2"]), g), { "A?": "A1", "B?": "B1, B2" })
})

test("a multi-select item that holds the separator is quoted, as the CLI does", () => {
  const g = groupAskQuestions([{ question: "Q?", multiSelect: true, options: [{ label: "Redis, not Memcached" }, { label: "Z" }] }])
  assert.equal(answersFor(JSON.stringify(["0:Redis, not Memcached", "0:Z"]), g)["Q?"], '"Redis, not Memcached", Z')
})

test("an untouched question is omitted, not shifted into its neighbour's slot", () => {
  const g = groupAskQuestions([
    { question: "A?", options: [{ label: "A1" }] },
    { question: "B?", options: [{ label: "B1" }] },
  ])
  assert.deepEqual(answersFor("1:B1", g), { "B?": "B1" })
})

test("questionAsk builds the ask clients draw, and is null without questions", () => {
  const q = questionAsk("ask1", "s1", { questions: [{ question: "Q?", options: [{ label: "X" }] }] }, { callID: "tu_1" })
  assert.ok(q)
  assert.equal(q.ask.kind, "question")
  assert.equal(q.ask.title, "Q?")
  assert.equal(q.ask.callID, "tu_1")
  assert.equal(q.ask.questions?.length, 1)
  assert.equal(questionAsk("ask1", "s1", {}), null)
  assert.equal(questionAsk("ask1", "s1", { questions: [] }), null)
})

test("option ids parse as one id or a JSON array", () => {
  assert.deepEqual(parseOptionIDs("0:X"), ["0:X"])
  assert.deepEqual(parseOptionIDs('["0:X","1:Y"]'), ["0:X", "1:Y"])
  assert.deepEqual(parseOptionIDs(""), [])
})

// The MCP server Claude spawns is what carries the answer back. A question's
// answers ride on `updatedInput`, which the tool reads; a permission stays the
// allow/deny it always was.
const here = path.dirname(fileURLToPath(import.meta.url))
const MCP = path.join(here, "..", "src", "harnesses", "claude-ask-mcp.mjs")

const callMcp = async (answer: Record<string, unknown>, args: Record<string, unknown>): Promise<{ decision: unknown; seen: any[] }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jep-ask-mcp-"))
  const sock = path.join(dir, "ask.sock")
  const seen: any[] = []
  const server = net.createServer((conn) => {
    let buf = ""
    conn.on("data", (c) => {
      buf += c.toString()
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const req = JSON.parse(line)
        seen.push(req)
        conn.write(`${JSON.stringify({ id: req.id, ...answer })}\n`)
      }
    })
  })
  await new Promise<void>((r) => server.listen(sock, () => r()))
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, JEP_ASK_SOCKET: sock, JEP_ASK_SESSION: "ses_x" },
    stdio: ["pipe", "pipe", "pipe"],
  })
  try {
    const replies: any[] = []
    let out = ""
    child.stdout!.on("data", (c) => {
      out += c.toString()
      let nl
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl).trim()
        out = out.slice(nl + 1)
        if (line) replies.push(JSON.parse(line))
      }
    })
    const send = (obj: unknown) => child.stdin!.write(`${JSON.stringify(obj)}\n`)
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ask", arguments: args } })
    const deadline = Date.now() + 5000
    let reply: any
    while (Date.now() < deadline && !(reply = replies.find((r) => r.id === 2))) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(reply, "the MCP server answered the call")
    return { decision: JSON.parse(reply.result.content[0].text), seen }
  } finally {
    child.kill()
    await new Promise<void>((r) => server.close(() => r()))
  }
}

test("the ask MCP carries a question's answers back as updatedInput", async () => {
  const updatedInput = { questions: [{ question: "Which?" }], answers: { "Which?": "Yes, do that" } }
  const { decision, seen } = await callMcp(
    { decision: "allow", updatedInput },
    { tool_name: "AskUserQuestion", input: { questions: [{ question: "Which?" }] }, tool_use_id: "tu_1" },
  )
  assert.deepEqual(decision, { behavior: "allow", updatedInput })
  assert.equal(seen[0].tool, "AskUserQuestion", "jep sees the tool name")
  assert.deepEqual(seen[0].input, { questions: [{ question: "Which?" }] })
})

test("a permission still answers with its allow, and the input unchanged", async () => {
  const input = { command: "ls" }
  const { decision } = await callMcp(
    { decision: "allow" },
    { tool_name: "Bash", input, tool_use_id: "tu_2" },
  )
  assert.deepEqual(decision, { behavior: "allow", updatedInput: input })
})
