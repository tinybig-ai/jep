// Prints the pairing codes the machine's daemon is currently accepting, so a
// client can be paired without hunting through the boot log. The daemon reports
// each client's state through the PairingAdmin port and aggregates it into one
// file, so this stays ignorant of every client's own storage. Run it with the
// same JEP_DATA_HOME the daemon uses.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PairingStatus } from "../core/pairing.ts"

const DATA_HOME = process.env.JEP_DATA_HOME ?? join(homedir(), ".local", "share", "jep-tg")
const FILE = join(DATA_HOME, "pairing-status.json")

let rows: PairingStatus[] = []
try {
  const parsed = JSON.parse(readFileSync(FILE, "utf8")) as unknown
  if (Array.isArray(parsed)) rows = parsed as PairingStatus[]
} catch {
  rows = []
}

console.log("")
console.log("jep pairing")
console.log("")
console.log(`  data home  ${DATA_HOME}`)

if (!rows.length) {
  console.log("")
  console.log("  no pairing state found there.")
  console.log("  is the daemon running with JEP_DATA_HOME pointing here?")
  console.log("  (scripts/install.sh uses ~/.local/share/jep-tg by default)")
  console.log("")
  process.exit(1)
}

for (const r of rows) {
  const who = r.owner ? `owner: ${r.owner}` : `${r.devices} device${r.devices === 1 ? "" : "s"}`
  console.log("")
  console.log(`  ${r.label.padEnd(26)}${who}`)
  if (r.code) {
    console.log(`    ${"code".padEnd(7)}${r.code}`)
    if (r.hint) console.log(`    ${r.hint.replace("<code>", r.code)}`)
  } else {
    console.log(`    ${"code".padEnd(7)}(none yet, restart the daemon so it writes one)`)
  }
}

console.log("")
console.log("  current as of the daemon's last write; restart it to mint a new one")
console.log("")
