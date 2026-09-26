import { test } from "node:test"
import assert from "node:assert/strict"
import { matchModel } from "../src/clients/telegram/model-match.ts"

const labels = [
  "default",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5-5",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "opencode/big-pickle",
]

test("the full label or the bare model id", () => {
  assert.equal(matchModel("openai/gpt-5", labels).model, "openai/gpt-5")
  assert.equal(matchModel("gpt-5", labels).model, "openai/gpt-5", "an exact id beats the longer one containing it")
  assert.equal(matchModel("BIG-PICKLE", labels).model, "opencode/big-pickle")
})

test("a unique part of a name", () => {
  assert.equal(matchModel("sonnet", labels).model, "anthropic/claude-sonnet-5")
  assert.equal(matchModel("pickle", labels).model, "opencode/big-pickle")
  assert.equal(matchModel("gpt5mini", labels).model, "openai/gpt-5-mini", "separators do not matter")
})

test("a typo", () => {
  assert.equal(matchModel("big-pickel", labels).model, "opencode/big-pickle")
  assert.equal(matchModel("claude-sonet-5", labels).model, "anthropic/claude-sonnet-5")
})

test("several matches take the first in the list", () => {
  // "/model opus" should just work, however many opuses there are
  const many = [...labels, "openrouter/claude-opus-4"]
  assert.equal(matchModel("opus", many).model, "anthropic/claude-opus-5-5")
  assert.equal(matchModel("claude", labels).model, "anthropic/claude-sonnet-5")
})

test("nothing near it: the closest few are offered, nothing is switched", () => {
  const far = matchModel("llama", labels)
  assert.equal(far.model, undefined)
  assert.equal(far.model, undefined)
  assert.equal(far.close.length, 3)
})
