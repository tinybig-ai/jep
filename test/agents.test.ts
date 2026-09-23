// core/agents.ts — a requested agent id that the harness doesn't offer must
// never reach the harness (it used to reach claude as "--agent 'build' not
// found"). It resolves to "harness default" instead.

import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveAgent } from "../src/core/agents.ts"

const agents = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
]

test("a known id passes through, an unknown one is dropped", () => {
  assert.equal(resolveAgent(agents, "plan"), "plan")
  assert.equal(resolveAgent(agents, "build"), "build")
  assert.equal(resolveAgent(agents, "nope"), undefined)
})

test("no agents, no id, or an empty id all mean the harness default", () => {
  assert.equal(resolveAgent(undefined, "build"), undefined)
  assert.equal(resolveAgent([], "build"), undefined)
  assert.equal(resolveAgent(agents, null), undefined)
  assert.equal(resolveAgent(agents, ""), undefined)
})
