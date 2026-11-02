// Carryover: a whole conversation written out as one markdown file, so a new
// agent on a different harness (claude to goose, say) can read it and continue.
// Pure: the gateway reads the messages and writes the file. The file opens with
// a note to the reader, because the new agent gets it as an attachment and has
// no other idea what it is.
import type { Message, Part } from "./types.ts"
import { transcriptText } from "./transcript.ts"

const clip = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut)` : text
}

const fence = (body: string): string => {
  const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}\n${body}\n${ticks}`
}

const renderPart = (part: Part, role: string): string => {
  switch (part.kind) {
    case "text": {
      const text = role === "user" ? transcriptText(part.text) : part.text
      return text.trim()
    }
    case "quote":
      return part.text.trim().split("\n").map((l) => `> ${l}`).join("\n")
    case "tool":
      return [
        `Tool call: ${part.title ? `${part.name} (${part.title})` : part.name}`,
        part.input === undefined ? "" : `Input:\n${fence(clip(part.input, 1500))}`,
        part.output === undefined || part.output === "" ? "" : `Output:\n${fence(clip(part.output, 1500))}`,
      ].filter(Boolean).join("\n")
    case "file":
      return `File: ${part.filePath}`
    default:
      return "" // reasoning, snapshots and harness internals are not carried over
  }
}

export interface CarryoverMeta {
  title?: string
  harness?: string
  workspace?: string
}

export const renderCarryover = (messages: Message[], meta: CarryoverMeta = {}): string => {
  const head = [
    "# Carryover from an earlier conversation",
    "",
    "A person was working with another coding agent and moved the work to you.",
    "Below is the full conversation so far. Read it, then continue the work. Do not redo finished steps.",
    "Files named in it may have changed since. Check the real state before you rely on it.",
    "",
    ...(meta.title ? [`- Title: ${meta.title}`] : []),
    ...(meta.harness ? [`- Earlier agent: ${meta.harness}`] : []),
    ...(meta.workspace ? [`- Workspace: ${meta.workspace}`] : []),
    `- Messages: ${messages.length}`,
    "",
    "---",
    "",
  ]
  const body = [...messages]
    .sort((a, b) => a.time - b.time)
    .map((m) => {
      const text = m.parts.map((p) => renderPart(p, m.role)).filter(Boolean).join("\n\n")
      return text ? `## ${m.role === "user" ? "User" : "Assistant"} (${new Date(m.time).toISOString()})\n\n${text}\n` : ""
    })
    .filter(Boolean)
  return [...head, ...body].join("\n")
}
