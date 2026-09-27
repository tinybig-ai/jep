#!/usr/bin/env node
// A desktop Claude Code hook: catches a window up on what happened on the
// phone (through jep) before it answers your next message.
//
// Each Claude Code window keeps its conversation in memory and never re-reads
// the transcript. When jep runs a turn in the same conversation from the phone,
// a window that stayed open has not seen it. jep stamps every phone turn
// (<jep data home>/claude-turns/<session id>); this hook remembers when the
// window loaded the conversation, and when a phone turn is newer it reads the
// phone's messages from the transcript (they are the ones Claude Code wrote as
// `sdk-cli`, jep's `claude -p`) and hands them to Claude with your message.
// If they cannot be read, it stops the message instead and says to reopen
// (`claude -c`), which loads everything.
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

  let missed
  try {
    missed = phoneMessages(String(input.transcript_path ?? ""), loadedAt)
  } catch {
    missed = null
  }
  if (!missed) {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: "This conversation continued on your phone (jep). Run `claude -c` to pick it up.",
      }),
    )
    return
  }
  // caught up: this window now knows what the phone did, so the next message
  // is not replayed again. A window opened before the hook existed never ran
  // SessionStart, so the folder may not be there yet.
  mkdirSync(loadedDir, { recursive: true })
  writeFileSync(mark, String(Date.now()))
  if (missed.length === 0) return
  process.stdout.write(
    JSON.stringify({
      systemMessage: `Caught up on ${missed.length} message(s) from your phone.`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: catchUp(missed),
      },
    }),
  )
}

// what was said on the phone since `since`: the prompts and the replies, not
// the tool calls between them (their effects are in the files and in git)
function phoneMessages(transcript, since) {
  if (!transcript) return null
  const out = []
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue
    let d
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (d.entrypoint !== "sdk-cli" || d.isSidechain || d.isMeta) continue
    if (!(Date.parse(d.timestamp ?? "") > since)) continue
    const content = d.message?.content
    // a reply sent with a quote is blocks of text (the quote, then the words);
    // a tool result is blocks too, but not text ones, and is left out
    const said =
      typeof content === "string"
        ? content.trim()
        : Array.isArray(content) && content.length && content.every((c) => c?.type === "text")
          ? content.map((c) => String(c.text ?? "").trim()).filter(Boolean).join("\n\n")
          : ""
    if (d.type === "user" && said) {
      out.push({ who: "User (on the phone)", text: said })
    } else if (d.type === "assistant" && Array.isArray(content)) {
      const text = content.filter((c) => c?.type === "text" && c.text?.trim()).map((c) => c.text.trim()).join("\n\n")
      if (text) out.push({ who: "Assistant (on the phone)", text })
    }
  }
  return out
}

const CATCH_UP_MAX = 12_000

function catchUp(missed) {
  let body = missed.map((m) => `${m.who}:\n${m.text}`).join("\n\n---\n\n")
  // the newest part matters most: keep the end if it has to be cut
  if (body.length > CATCH_UP_MAX) body = `[earlier part cut]\n\n${body.slice(-CATCH_UP_MAX)}`
  return [
    "This conversation continued from the user's phone (through jep) after this window loaded it.",
    "Here is what was said there, oldest first. Treat it as part of this conversation; its changes are already in the files and git.",
    "",
    body,
  ].join("\n")
}

try {
  main()
} catch {
  // unsure means allow: a broken check must never stop you typing
}
