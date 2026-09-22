// adapters/codex.ts — codex writes its own context into the rollout; it must
// not be rendered as something the user said (it showed up as a wall of XML on
// the first message of a codex conversation).

import { test } from "node:test"
import assert from "node:assert/strict"
import { isCodexInjectedContext, externalAgentCall, externalAgentResult } from "../src/adapters/codex.ts"

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

// Driven by another agent, codex records its tool calls and their results as
// assistant text. They are tools, and as prose they bury the answer.

const CALL = `[external_agent_tool_call: Bash]
description: Search for draftMode usage in bot.ts
command: grep -n "draftMode" src/telegram/bot.ts
[/external_agent_tool_call]`

test("codex's external-agent tool call is a tool, not prose", () => {
  assert.deepEqual(externalAgentCall(CALL), {
    name: "Bash",
    input: { description: "Search for draftMode usage in bot.ts", command: 'grep -n "draftMode" src/telegram/bot.ts' },
  })
})

test("codex's external-agent tool result is recognised", () => {
  assert.equal(externalAgentResult("[external_agent_tool_result]\n644  file.md\n[/external_agent_tool_result]"), "644  file.md")
  assert.equal(externalAgentResult("[external_agent_tool_result]\nno closing tag"), "no closing tag")
})

test("ordinary prose is neither a call nor a result", () => {
  assert.equal(externalAgentCall("hello"), null)
  assert.equal(externalAgentCall("[external_agent_tool_call: Bash] unterminated"), null)
  assert.equal(externalAgentResult("hello"), null)
})
