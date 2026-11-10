import test from "node:test"
import assert from "node:assert/strict"
import { parseModelRef } from "../src/core/models.ts"

test("a model reference keeps the full nested model id", () => {
  assert.deepEqual(parseModelRef("litellm/chatgpt/gpt-5.6-luna"), { providerID: "litellm", modelID: "chatgpt/gpt-5.6-luna" })
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude-sonnet-4"), { providerID: "openrouter", modelID: "anthropic/claude-sonnet-4" })
  assert.deepEqual(parseModelRef("codex/gpt-6.1-sol"), { providerID: "codex", modelID: "gpt-6.1-sol" })
  for (const ref of [undefined, "", "model", "/model", "provider/"]) assert.equal(parseModelRef(ref), undefined)
})
