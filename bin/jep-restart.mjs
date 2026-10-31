#!/usr/bin/env node
// `jep-restart`: restart the jep daemon safely, from any agent's shell.
//
//   jep-restart [--wait MINUTES]
//
// The daemon restarts once every turn has ended, this one included, so run it
// and then END YOUR TURN: do not sleep, poll or wait for it. A restart fired
// from inside a turn (launchctl, kill) ends that turn's own process mid-command.
// If a turn is still running after --wait minutes (default 10), the daemon
// restarts anyway and picks the cut-off turns up again afterwards.
//
// Plain node, no imports from the tree: it runs from whatever shell the agent has.
import { ask } from "./lib/control.mjs"

const args = process.argv.slice(2)
let wait
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--wait") wait = Number(args[++i])
  else {
    console.error("usage: jep-restart [--wait MINUTES]")
    process.exit(2)
  }
}

const r = await ask({ op: "restart", wait_minutes: wait || undefined })
console[r.ok ? "log" : "error"](r.ok ? r.message : `jep-restart: ${r.message}`)
process.exit(r.ok ? 0 : 1)
