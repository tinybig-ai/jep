// adapters/claude.ts — the status line's fill rate. Claude Code knows each
// model's context window and says so on every result (modelUsage[...].
// contextWindow); jep used to report 0 for every Claude model, so the phone
// could show tokens used but never "of how many". And the turn's result.usage
// is the sum over every API call in it, which read as a context many times the
// size of the one the model actually held.
//
// CLAUDE_BIN is read when the module loads, so it is pointed at a fake before
// the adapter is imported.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, chmod } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const dir = await mkdtemp(path.join(os.tmpdir(), "jep-claude-ctx-"))
const bin = path.join(dir, "claude")
const lines = [
  { type: "system", subtype: "init", session_id: "s-ctx" },
  {
    type: "assistant",
    session_id: "s-ctx",
    message: {
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2_000 },
    },
  },
  {
    type: "result",
    subtype: "success",
    session_id: "s-ctx",
    total_cost_usd: 0.01,
    // three calls' worth, added up
    usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 6_000 },
    modelUsage: {
      "claude-haiku-4-5": { outputTokens: 15, contextWindow: 200_000 },
      "claude-sonnet-5": { outputTokens: 2, contextWindow: 1_000_000 },
    },
  },
]
await writeFile(bin, `#!/bin/sh\n[ "$1" = "--help" ] && exit 0\ncat <<'EOF'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nEOF\n`)
await chmod(bin, 0o755)
process.env.CLAUDE_BIN = bin
process.env.CLAUDE_HOME = dir // no settings.json: nothing configured
process.env.JEP_DATA_HOME = dir // turn stamps land here, never in the real data home

const { ClaudeAdapter } = await import("../src/harnesses/claude.ts")

test("the last call's usage is the context, not the turn's sum", async () => {
  const a = new ClaudeAdapter(dir)
  const s = await a.createSession("t")
  const m = await a.prompt(s.id, "hi")
  assert.equal(m.tokens?.cache.read, 40_000)
})

test("a model's context window is learned from the turn that ran on it", async () => {
  const a = new ClaudeAdapter(dir)
  const before = await a.capabilities()
  assert.equal(before.get("claude/claude-haiku-4-5")?.contextLimit, 200_000, "the 200K default before any turn")
  assert.equal(await a.defaultModel(), null)

  const s = await a.createSession("t")
  await a.prompt(s.id, "hi", { model: { providerID: "claude", modelID: "haiku" } })
  const caps = await a.capabilities()
  assert.equal(caps.get("claude/claude-sonnet-5")?.contextLimit, 1_000_000, "reported, not assumed")
  // the alias the turn asked for resolves to the model that actually ran
  assert.equal(caps.get("claude/haiku")?.contextLimit, 200_000)
  // nothing configured, but the CLI's choice is known now
  assert.equal(await a.defaultModel(), "claude/claude-haiku-4-5")
})

test("a 1M variant says so in its id", async () => {
  process.env.JEP_CLAUDE_MODELS = "claude-opus-5[1m]"
  try {
    const caps = await new ClaudeAdapter(dir).capabilities()
    assert.equal(caps.get("claude/claude-opus-5[1m]")?.contextLimit, 1_000_000)
  } finally {
    delete process.env.JEP_CLAUDE_MODELS
  }
})
