// scripts/claude-handoff-hook.mjs, run the way Claude Code runs it: as a
// child of a process named `claude`, one long-lived window.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const hook = path.resolve(import.meta.dirname, "..", "scripts", "claude-handoff-hook.mjs")

async function window(steps: (transcript: string) => string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jep-hook-"))
  const data = path.join(dir, "data")
  await mkdir(path.join(data, "claude-turns"), { recursive: true })
  const transcript = path.join(dir, "t.jsonl")
  const bin = path.join(dir, "bin")
  await mkdir(bin)
  // `claude` here is a stand-in window: each `ev` is one hook call from it
  await writeFile(
    path.join(bin, "claude"),
    `#!/bin/sh
ev() { echo "$1" | sh -c "node ${hook}"; echo "<<end>>"; }
stamp() { node -e 'require("fs").writeFileSync(process.argv[1], String(Date.now()))' "${data}/claude-turns/abc"; }
say() { node -e 'const [f,e,w,t]=process.argv.slice(1);require("fs").appendFileSync(f, JSON.stringify({type:w,entrypoint:e,timestamp:new Date().toISOString(),message:{content:w==="user"?t:[{type:"text",text:t}]}})+"\\n")' "${transcript}" "$1" "$2" "$3"; }
${steps(transcript)}
`,
  )
  await chmod(path.join(bin, "claude"), 0o755)
  const out = execFileSync(path.join(bin, "claude"), { env: { ...process.env, JEP_DATA_HOME: data }, encoding: "utf8" })
  return { outputs: out.split("<<end>>\n").slice(0, -1).map((o) => o.trim()), transcript }
}

const prompt = (t: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "abc", transcript_path: t })

test("a window opened before the hook existed still catches up (no SessionStart ever ran)", async () => {
  const { outputs } = await window(
    (t) => `
sleep 1
say sdk-cli user "sent from the phone"
say sdk-cli assistant "answered on the phone"
say cli user "typed on the desktop"
stamp
ev '${prompt(t)}'
ev '${prompt(t)}'
`,
  )
  const first = JSON.parse(outputs[0]!)
  assert.equal(first.systemMessage, "Caught up on 2 message(s) from your phone.")
  assert.match(first.hookSpecificOutput.additionalContext, /sent from the phone[\s\S]*answered on the phone/)
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /typed on the desktop/)
  assert.equal(outputs[1], "", "caught up once, not on every message")
})

test("a reply sent with a quote catches up with its quote; tool results stay out", async () => {
  // what jep's claude adapter writes for a quoted reply, then a tool result
  const writer = path.join(await mkdtemp(path.join(os.tmpdir(), "jep-hook-w-")), "w.mjs")
  await writeFile(
    writer,
    `import { appendFileSync } from "node:fs"
const w = (o) => appendFileSync(process.argv[2], JSON.stringify({ entrypoint: "sdk-cli", timestamp: new Date().toISOString(), ...o }) + "\\n")
w({ type: "user", message: { content: [{ type: "text", text: "[in reply to]\\n> shall I?" }, { type: "text", text: "yes, ship it" }] } })
w({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "secret output" }] } })
`,
  )
  const { outputs } = await window(
    (t) => `
sleep 1
node ${writer} ${t}
stamp
ev '${prompt(t)}'
`,
  )
  const ctx = JSON.parse(outputs[0]!).hookSpecificOutput.additionalContext as string
  assert.match(ctx, /> shall I\?[\s\S]*yes, ship it/)
  assert.doesNotMatch(ctx, /secret output/)
})
