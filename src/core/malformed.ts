import type { Message } from "./types.ts"

// Some models, free ones above all, write a tool call out as text instead of making it: the XML their
// training used (`<invoke name="shell"><parameter …>`, a `dots_function_call` block, a `<tool_call>`
// with JSON) ends up in the reasoning or the reply. The harness sees a message with no tool call in it
// and takes the turn for finished, so the agent goes quiet mid-task with its next step written down
// and never run. That is not the agent's decision to stop, so jep treats it as a failed turn.

const TOOL_AS_TEXT: RegExp[] = [
  /<dots_function_call>/i,
  /<function_calls?>[\s\S]*<invoke\b/i,
  /<invoke\b[^>]*\bname\s*=\s*["'][^"']+["'][^>]*>[\s\S]*<(?:parameter|\/invoke)\b/i,
  /<tool_call>\s*\{[\s\S]*"name"[\s\S]*<\/tool_call>/i,
]

/** was this turn's last message a tool call written as text, with no real tool call beside it? */
export function malformedToolCall(message: Message | undefined): boolean {
  if (!message || message.role !== "assistant") return false
  if (message.parts.some((p) => p.kind === "tool")) return false
  const text = message.parts
    .map((p) => (p.kind === "text" || p.kind === "reasoning" ? p.text : ""))
    .join("\n")
  return TOOL_AS_TEXT.some((re) => re.test(text))
}

/** consecutive corrections jep will make before leaving the turn ended */
export const MALFORMED_RETRY_MAX = 3

/** what the agent is told: plain, and about the one thing to change */
export const MALFORMED_NOTE =
  "Your last message wrote a tool call out as text, so it did not run. Call the tool through the tool interface this time, and carry on from where you were."
