// Codex stores developer/system instructions beside the conversation. Those
// records must never become assistant replies in history or the live stream.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Part } from "../src/core/types.ts"

const home = await mkdtemp(join(tmpdir(), "jep-codex-visibility-"))
const bin = join(home, "codex.mjs")
await writeFile(bin, `#!/usr/bin/env node
import { readFileSync } from "node:fs"
process.stdout.write(readFileSync(new URL("stream.jsonl", import.meta.url), "utf8"))
`)
await chmod(bin, 0o755)
await mkdir(join(home, "sessions"))
process.env.CODEX_BIN = bin
process.env.CODEX_HOME = home
const { CodexAdapter } = await import("../src/harnesses/codex.ts")

const jsonl = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
const words = (parts: Part[]): string[] => parts.flatMap((p) => p.kind === "text" ? [p.text] : [])

test("Codex only exposes conversation roles, including when the user discusses instruction tags", async (t) => {
  t.after(() => rm(home, { recursive: true, force: true }))
  const adapter = new CodexAdapter(home)
  t.after(() => adapter.close())

  await t.test("response_item history excludes every role except user and assistant", async () => {
    const messages = [
      { role: "system", text: "runtime instructions" },
      { role: "developer", text: "<skills_instructions>private skills</skills_instructions>" },
      { role: "user", text: "Why am I seeing skills_instructions and model_instructions?" },
      { role: "developer", text: "<model_instructions>private model instructions</model_instructions>" },
      { role: "assistant", text: "The reply can mention <skills_instructions> without being hidden." },
      { role: "developer", text: "[external_agent_tool_call: shell]\ncommand: internal\n[/external_agent_tool_call]" },
      { role: "future-internal-role", text: "unknown instructions" },
      { text: "message without a role" },
    ]
    await writeFile(join(home, "sessions", "rollout-roles.jsonl"), jsonl(messages.map(({ role, text }) => ({
      type: "response_item",
      payload: { type: "message", role, content: [{ type: "input_text", text }] },
    }))))
    const history = await adapter.messages("codex://roles")
    assert.deepEqual(history.map((m) => ({ role: m.role, text: words(m.parts) })), [
      { role: "user", text: [messages[2]!.text] },
      { role: "assistant", text: [messages[4]!.text] },
    ])
  })

  const items = [
    { type: "DeveloperMessage", text: "<skills_instructions>private skills</skills_instructions>" },
    { type: "SystemMessage", text: "private system instructions" },
    { type: "AgentMessage", role: "developer", text: "<model_instructions>private model instructions</model_instructions>" },
    { type: "agent_message", role: "system", text: "private system instructions" },
    { type: "AgentMessage", role: "future-internal-role", text: "unknown instructions" },
    { type: "AgentMessage", text: "Fixed the visible transcript." },
  ]

  await t.test("Desktop event history hides internal message items", async () => {
    await writeFile(join(home, "sessions", "rollout-desktop.jsonl"), jsonl([
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", text: "Fix this leak" } } },
      ...items.map((item) => ({ type: "event_msg", payload: { type: "item_completed", item } })),
    ]))
    const history = await adapter.messages("codex://desktop")
    assert.deepEqual(history.map((m) => ({ role: m.role, text: words(m.parts) })), [
      { role: "user", text: ["Fix this leak"] },
      { role: "assistant", text: ["Fixed the visible transcript."] },
    ])
  })

  await t.test("live replies and events hide internal message items", async () => {
    await writeFile(join(home, "stream.jsonl"), jsonl([
      { type: "thread.started", thread_id: "live" },
      ...items.map((item) => ({ type: "item.completed", item })),
      { type: "turn.completed", usage: {} },
    ]))
    const feed = adapter.events()[Symbol.asyncIterator]()
    await feed.next() // attach before the fake CLI starts
    const visible: Part[] = []
    const collecting = (async () => {
      for await (const event of { [Symbol.asyncIterator]: () => feed }) {
        if (event.type === "part.updated" && event.part) visible.push(event.part)
        if (event.type === "session.idle") break
      }
    })()
    const reply = await adapter.prompt("codex://live", "Fix this leak")
    await collecting
    assert.deepEqual(reply.parts, [{ kind: "text", text: "Fixed the visible transcript." }])
    assert.deepEqual(visible, reply.parts)
  })
})
