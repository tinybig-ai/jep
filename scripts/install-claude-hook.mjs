#!/usr/bin/env node
// Registers the desktop handoff hook (claude-handoff-hook.mjs) in Claude Code's
// user settings, so a window that missed a turn sent from the phone says so
// instead of forking the conversation. Run by install.sh / install-linux.sh;
// safe to re-run (a registration that is already there is left alone, and an
// old path to the hook is replaced). JEP_NO_CLAUDE_HOOK=1 skips it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

if (process.env.JEP_NO_CLAUDE_HOOK === "1") process.exit(0)

const hook = resolve(dirname(fileURLToPath(import.meta.url)), "claude-handoff-hook.mjs")
// the installer passes the node it found on PATH (a stable symlink); this
// process's own path can be a versioned one that breaks at the next upgrade
const command = `${process.env.JEP_NODE || process.execPath} ${hook}`
const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")

let settings = {}
if (existsSync(file)) {
  try {
    settings = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    // never overwrite a settings file we cannot read: it would lose everything in it
    console.error(`claude hook: ${file} is not valid JSON; left alone. Add the hook by hand: ${command}`)
    process.exit(0)
  }
}

settings.hooks ??= {}
let changed = false
for (const event of ["SessionStart", "UserPromptSubmit"]) {
  const groups = (settings.hooks[event] ??= [])
  // an earlier install from another checkout or node: take it out
  for (const g of groups) {
    const before = g.hooks?.length ?? 0
    g.hooks = (g.hooks ?? []).filter((h) => !(String(h.command ?? "").includes("claude-handoff-hook.mjs") && h.command !== command))
    if (g.hooks.length !== before) changed = true
  }
  settings.hooks[event] = groups.filter((g) => g.hooks.length > 0)
  if (!settings.hooks[event].some((g) => g.hooks.some((h) => h.command === command))) {
    settings.hooks[event].push({ hooks: [{ type: "command", command, timeout: 10 }] })
    changed = true
  }
}
if (changed) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  console.log(`claude hook: registered in ${file}`)
} else {
  console.log("claude hook: already registered")
}
