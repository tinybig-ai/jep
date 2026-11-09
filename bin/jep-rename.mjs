#!/usr/bin/env node
// `jep-rename TITLE...`: give the jep conversation this agent is in a new title.
//
//   jep-rename Fix the login redirect
//
// The words after the command are the title, quoted or not. Plain node, no
// imports from the tree: it runs from whatever shell the agent has. The conversation is JEP_SESSION,
// which jep sets in every turn's shell, or --session ID.
import { ask } from "./lib/control.mjs"

const argv = process.argv.slice(2)
let session = process.env.JEP_SESSION ?? ""
const at = argv.indexOf("--session")
if (at >= 0) {
  session = argv[at + 1] ?? ""
  argv.splice(at, 2)
}
const title = argv.filter((a) => !a.startsWith("-")).join(" ").trim()
if (!title) {
  console.error("usage: jep-rename TITLE")
  process.exit(2)
}
const r = await ask({ op: "rename", title, session, cwd: process.cwd() })
console[r.ok ? "log" : "error"](r.ok ? r.message : `jep-rename: ${r.message}`)
process.exit(r.ok ? 0 : 1)
