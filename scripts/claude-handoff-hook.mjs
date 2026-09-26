#!/usr/bin/env node
// A desktop Claude Code hook: stops a message typed into a window that is out
// of date because the conversation continued on the phone (through jep).
//
// Each Claude Code window keeps its conversation in memory and never re-reads
// the transcript. When jep runs a turn in the same conversation from the phone,
// a window that stayed open has not seen it, and typing there forks the
// transcript into two threads. jep stamps every phone turn
// (<jep data home>/claude-turns/<session id>); this hook remembers when the
// window loaded the conversation, and refuses a message when a phone turn is
// newer than that. Reopening (`claude -c`) loads everything and clears it.
//
// Wire it in ~/.claude/settings.json for SessionStart and UserPromptSubmit.
// It never gets in the way when it cannot tell: any failure allows the message.

import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const dataHome = process.env.JEP_DATA_HOME ?? join(homedir(), ".local", "share", "jep-tg")
const turnsDir = join(dataHome, "claude-turns")
const loadedDir = join(dataHome, "claude-windows")

// the claude process this hook runs for: the nearest ancestor that is one
function claudeAncestor() {
  let pid = process.ppid
  for (let i = 0; i < 8 && pid > 1; i++) {
    const [ppid, ...cmd] = execFileSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/)
    const command = cmd.join(" ")
    if (/(^|\/)claude(\s|$)/.test(command)) return { pid, command }
    pid = Number(ppid)
  }
  return null
}

const startedAt = (pid) => Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim())

function main() {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}")
  const session = String(input.session_id ?? "")
  if (!/^[\w-]+$/.test(session)) return
  const claude = claudeAncestor()
  // jep's own turns run `claude -p`: that is the phone, never a stale window
  if (!claude || /\s-p(\s|$)|--print/.test(claude.command)) return
  const mark = join(loadedDir, `${session}.${claude.pid}`)

  if (input.hook_event_name === "SessionStart") {
    // startup, /resume, /clear: this window now holds the conversation as it is
    mkdirSync(loadedDir, { recursive: true })
    writeFileSync(mark, String(Date.now()))
    return
  }
  if (input.hook_event_name !== "UserPromptSubmit") return

  let phoneAt = 0
  try {
    phoneAt = Number(readFileSync(join(turnsDir, session), "utf8"))
  } catch {
    return // the phone never touched this conversation
  }
  let loadedAt
  try {
    loadedAt = Number(readFileSync(mark, "utf8"))
  } catch {
    loadedAt = startedAt(claude.pid) // opened before this hook existed
  }
  if (!(phoneAt > loadedAt)) return
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: "This conversation continued on your phone (jep). Run `claude -c` to pick it up.",
    }),
  )
}

try {
  main()
} catch {
  // unsure means allow: a broken check must never stop you typing
}
