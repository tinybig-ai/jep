#!/usr/bin/env node
// `jep-end-turn`: tell jep this turn finished everything it was asked.
//
//   jep-end-turn
//
// In a conversation set to keep going, jep starts another turn when this one
// ends, and keeps doing that until you run this. Run it only when the request
// is done — jep started this work from a phone and there is nobody at a terminal
// to answer "are you finished?".
//
// Plain node, no imports from the tree: it runs from whatever shell the agent
// has. The conversation is JEP_SESSION, which jep sets in every turn's shell,
// or --session ID.
import { ask } from "./lib/control.mjs"

const argv = process.argv.slice(2)
let session = process.env.JEP_SESSION ?? ""
const at = argv.indexOf("--session")
if (at >= 0) {
  session = argv[at + 1] ?? ""
  argv.splice(at, 2)
}
if (argv.some((a) => a === "-h" || a === "--help")) {
  console.log("usage: jep-end-turn [--session ID]\n\nSay this turn finished everything you were asked. Only run it when it has.")
  process.exit(0)
}
const r = await ask({ op: "end-turn", done: true, session, cwd: process.cwd() })
console[r.ok ? "log" : "error"](r.ok ? r.message : `jep-end-turn: ${r.message}`)
process.exit(r.ok ? 0 : 1)
