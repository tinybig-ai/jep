// adapters/codex.ts — codex writes its own context into the rollout; it must
// not be rendered as something the user said (it showed up as a wall of XML on
// the first message of a codex conversation).

import { test } from "node:test"
import assert from "node:assert/strict"
import { isCodexInjectedContext } from "../src/adapters/codex.ts"

const INJECTED = `<workspace_roots><root>/Users/user/Documents/code/jep</root></workspace_roots>
<permission_profile type="managed"><file_system type="restricted">...</file_system></permission_profile>
<environment_context><cwd>/Users/user/Documents/code/jep</cwd></environment_context>`

test("codex's own environment block is recognised", () => {
  assert.equal(isCodexInjectedContext(INJECTED), true)
  assert.equal(isCodexInjectedContext("<environment_context>x</environment_context>"), true)
  assert.equal(isCodexInjectedContext("<permission_profile type=\"managed\">x"), true)
})

test("a real message is not mistaken for context", () => {
  assert.equal(isCodexInjectedContext("hello"), false)
  assert.equal(isCodexInjectedContext("what does <div> do here?"), false)
  assert.equal(isCodexInjectedContext(""), false)
})
