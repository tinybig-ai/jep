#!/usr/bin/env node
// The one-command entry point: `npx --yes github:tinybig-ai/jep`, or a global
// `jep` once installed. It exists only because jep runs its TypeScript directly
// and needs a Node flag that npm's generated bin shim won't add — so it re-execs
// node with that flag and otherwise stays out of the way (same stdio, same
// signals, same exit code).
//
// When installed, the package has a compiled `dist/app/tg.js`.
// When running from source, it uses `src/app/tg.ts` with --experimental-strip-types.

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)

if (args.includes("--version") || args.includes("-v")) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  console.log(pkg.version)
  process.exit(0)
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`jep — one interface for every coding agent

Usage:
  jep                 run the daemon against the current directory
  jep --version       print the version

Env:
  JEP_TG_TOKEN        Telegram bot token, from @BotFather (required live)
  JEP_WORKSPACES      ':'-separated workspace dirs (default: the cwd)
  JEP_DATA_HOME       data dir (default: ~/.local/share/jep-tg)
  JEP_GW_PORT         also serve the gateway on this port

Docs: https://github.com/tinybig-ai/jep`)
  process.exit(0)
}

const distEntry = join(root, "dist", "app", "tg.js")
const srcEntry = join(root, "src", "app", "tg.ts")
// Under node_modules we are an installed package: there is no `src` build step
// on the user's machine, so the compiled `dist` is what runs. Anywhere else we
// are the repo itself, where `src` is the live truth and `dist` (if a build left
// one behind) would be stale.
const installed = root.split(sep).includes("node_modules")

let entry
let spawnArgs
if (!installed && existsSync(srcEntry)) {
  entry = srcEntry
  spawnArgs = ["--experimental-strip-types", entry, ...args]
} else if (existsSync(distEntry)) {
  entry = distEntry
  spawnArgs = [entry, ...args]
} else if (existsSync(srcEntry)) {
  entry = srcEntry
  spawnArgs = ["--experimental-strip-types", entry, ...args]
} else {
  console.error(`jep: cannot find ${distEntry} or ${srcEntry} — is the package intact?`)
  process.exit(1)
}

const env = { ...process.env }
// A one-liner shouldn't scatter your sessions into a fresh temp dir each run:
// default the store to where a launchd install keeps it, unless the caller said
// otherwise (the daemon itself still falls back to a temp dir when unset).
if (!env.JEP_DATA_HOME) env.JEP_DATA_HOME = join(homedir(), ".local", "share", "jep-tg")

const child = spawn(process.execPath, spawnArgs, {
  stdio: "inherit",
  env,
})
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal))
}
child.on("exit", (code) => process.exit(code ?? 1))