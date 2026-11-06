#!/usr/bin/env node
// `jep-read CONVERSATION [--last N]` / `jep-read --list`: read another jep conversation.
//
//   jep-read --list                    the conversations: id, agent, title
//   jep-read "map render" --last 20    the newest 20 messages of the one that matches
//
// The asking conversation is JEP_SESSION, which jep sets in every turn's shell, or --session ID. Without
// one the daemon guesses from the working directory, and fails when several conversations run there.
//
// Reading asks the person first: a card appears in THIS conversation naming both, and the command
// waits for the answer. If they say no, or nobody answers, nothing is read. Plain node, no imports
// from the tree: it runs from whatever shell the agent has.
import { ask } from "./lib/control.mjs"

const args = process.argv.slice(2)
let list = false
let last
let session = process.env.JEP_SESSION ?? ""
const words = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--list") list = true
  else if (args[i] === "--last") last = Number(args[++i])
  else if (args[i] === "--session") session = args[++i] ?? ""
  else if (args[i].startsWith("-")) {
    console.error("usage: jep-read CONVERSATION [--last N] [--session ID]   |   jep-read --list")
    process.exit(2)
  } else words.push(args[i])
}
if (!list && !words.length) {
  console.error("usage: jep-read CONVERSATION [--last N] [--session ID]   |   jep-read --list")
  process.exit(2)
}
const r = await ask({ op: "read", list: list || undefined, target: words.join(" "), last: last || undefined, session, cwd: process.cwd() })
console[r.ok ? "log" : "error"](r.ok ? r.message : `jep-read: ${r.message}`)
process.exit(r.ok ? 0 : 1)
