#!/usr/bin/env node
// `jep-watch`: hand a slow wait to the jep daemon, from any agent's shell.
//
//   jep-watch [--note TEXT] [--every SECONDS] [--max MINUTES] [--session ID] -- CHECK...
//
// CHECK is a shell command that exits 0 when the thing is finished. The daemon
// runs it outside the turn and starts a new turn in this conversation when it
// passes or time runs out. A background job started inside a turn dies when the
// turn's process ends, so it can never wake the agent; this can.
//
// Plain node, no imports from the tree: it runs from whatever shell the agent has.
import { ask } from "./lib/control.mjs"

const USAGE = "usage: jep-watch [--note TEXT] [--every SECONDS] [--max MINUTES] [--session ID] -- CHECK..."
const args = process.argv.slice(2)
const dashdash = args.indexOf("--")
const head = dashdash < 0 ? args : args.slice(0, dashdash)
// Help is help wherever it appears. `jep-watch --help` alone was handled, but
// `jep-watch --every 30 --help` fell through and offered "--help" to the daemon
// as a check — which ran as `/bin/sh -c --help` and burned an hour of watch.
if (head.includes("-h") || head.includes("--help")) {
  console.log(USAGE)
  process.exit(0)
}
const flags = { note: "", every: "", max: "", session: process.env.JEP_SESSION ?? "" }
let i = 0
for (; i < args.length; i++) {
  const a = args[i]
  if (a === "--") {
    i++
    break
  }
  const key = a.startsWith("--") ? a.slice(2) : ""
  // An unknown option is a mistake, not a check. Silently folding it into CHECK
  // is how "--list" and "--help" became watches that could never pass.
  if (!(key in flags)) {
    console.error(`jep-watch: unknown option ${a}`)
    console.error(USAGE)
    console.error("if a flag really is part of your command, put it after `--`.")
    process.exit(2)
  }
  flags[key] = args[++i] ?? ""
}
const check = args.slice(i).join(" ").trim()
if (!check) {
  console.error(USAGE)
  process.exit(2)
}
// The same guard the daemon now applies: a check's first word must be a program.
if (check.startsWith("-")) {
  console.error(`jep-watch: "${check}" is a flag, not a command.`)
  console.error(USAGE)
  process.exit(2)
}

const r = await ask({
  check,
  note: flags.note,
  every_seconds: Number(flags.every) || undefined,
  max_minutes: Number(flags.max) || undefined,
  session: flags.session,
  cwd: process.cwd(),
})
console[r.ok ? "log" : "error"](r.ok ? r.message : `jep-watch: ${r.message}`)
process.exit(r.ok ? 0 : 1)
