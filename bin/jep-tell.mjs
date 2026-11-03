#!/usr/bin/env node
// `jep-tell CONVERSATION MESSAGE...`: send another jep conversation a message.
//
//   jep-tell "map render" "the build is done, you can rerun the shot"
//   echo "long message" | jep-tell "map render" -
//
// It becomes a turn in that conversation, drawn there as a message from this one. The first time for
// each pair the person is asked on a card in THIS conversation; later ones go straight through, up to
// a few an hour. It does not wait for a reply: if the other one answers, that arrives as a message
// to you. Plain node, no imports from the tree.
import { ask } from "./lib/control.mjs"

const [target, ...rest] = process.argv.slice(2)
if (!target || target.startsWith("-")) {
  console.error('usage: jep-tell CONVERSATION MESSAGE...   (jep-read --list names the conversations)')
  process.exit(2)
}
let message = rest.join(" ")
if (rest.length === 1 && rest[0] === "-") {
  message = ""
  for await (const chunk of process.stdin) message += chunk
}
if (!message.trim()) {
  console.error("jep-tell: give the message to send")
  process.exit(2)
}
const r = await ask({ op: "tell", target, message, cwd: process.cwd() })
console[r.ok ? "log" : "error"](r.ok ? r.message : `jep-tell: ${r.message}`)
process.exit(r.ok ? 0 : 1)
