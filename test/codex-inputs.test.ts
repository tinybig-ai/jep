import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rememberFailedCodexInput } from "../src/harnesses/codex-inputs.ts"

test("inputs rejected before Codex records them survive a new adapter without duplicating native inputs", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "jep-codex-inputs-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bin = join(home, "codex")
  await writeFile(bin, '#!/bin/sh\nprintf "invalid image arguments" >&2\nexit 1\n')
  await chmod(bin, 0o755)
  process.env.CODEX_BIN = bin
  process.env.CODEX_HOME = home
  const { CodexAdapter } = await import("../src/harnesses/codex.ts")
  const first = new CodexAdapter(home)
  const answer = await first.prompt("codex://missing", "where is this message?", { filePaths: ["/tmp/shot.jpg"] })
  assert.match(answer.error?.message ?? "", /invalid image arguments/)
  await first.close()
  const next = new CodexAdapter(home)
  t.after(() => next.close())
  const restored = await next.messages("codex://missing")
  assert.equal(restored.length, 1)
  assert.match(restored[0]!.parts[0]!.kind === "text" ? restored[0]!.parts[0]!.text : "", /where is this message\?[\s\S]*shot.jpg/)
  const time = Date.now()
  await rememberFailedCodexInput(home, "recorded", "already saved", time)
  await mkdir(join(home, "sessions"))
  await writeFile(join(home, "sessions", "rollout-recorded.jsonl"), JSON.stringify({
    timestamp: new Date(time).toISOString(), type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "already saved" }] },
  }) + "\n")
  assert.equal((await next.messages("codex://recorded")).length, 1)
})
