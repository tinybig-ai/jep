// The first prompt of a fresh session carries a jep context header (see
// JEP_CONTEXT): a note telling the harness it is being driven through jep, not
// a terminal. It is addressed to the model, not the reader. Left in a
// transcript it buries the message a person actually sent under a screen of
// preamble, so every client strips it before showing history. The cleanup is
// pure and lives here so no client has to reinvent it.
export const JEP_CONTEXT = [
  "[jep context — background only, not a request]",
  "This conversation is relayed through jep, a phone-first control plane for coding agents (headless, no terminal on the other end). jep's own code and docs are in this checkout — see docs/PROCESSES.md and docs/PHILOSOPHY.md.",
].join("\n")
export const JEP_CONTEXT_FOOTER = "Ignore the block above. Treat the message below as the user's entire, only request.\n---"

export const stripInjectedContext = (text: string): string => {
  const i = text.indexOf(JEP_CONTEXT_FOOTER)
  return i === -1 ? text : text.slice(i + JEP_CONTEXT_FOOTER.length)
}

// A harness splices a lot of machinery into the user's half of a transcript:
// background-task notifications, the envelope around a slash command, the
// stdout of a `!` shell line, system reminders. All of it is addressed to the
// model, and replayed in /log it reads as the user saying things they never
// said. Dropped whole — a turn that was only machinery disappears.
const NOISE_BLOCKS = [
  "system-reminder",
  "task-notification",
  "local-command-caveat",
  "local-command-stdout",
  "bash-stdout",
  "bash-stderr",
  "interrupted-output",
  "command-message",
  "command-args",
]

// These wrap something a person really said — a message relayed from another
// chat, or from a peer session — in routing metadata. The envelope goes, the
// message stays.
const UNWRAP_BLOCKS = ["channel", "cross-session-message"]

export const dropBlocks = (text: string): string => {
  let out = text
  for (const name of UNWRAP_BLOCKS) out = out.replace(new RegExp(`</?${name}(\\s[^>]*)?>`, "g"), "")
  for (const name of NOISE_BLOCKS) {
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "g"), "")
    // an unclosed one means the harness truncated mid-block; the rest of the
    // message is that block's tail, so it goes too
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*$`), "")
  }
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

// What the user actually typed, recovered from however the harness recorded
// it. A slash command and a `!` shell line are real input and stay; their
// surrounding bookkeeping does not.
export const transcriptText = (raw: string): string => {
  const text = stripInjectedContext(raw)
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/)
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)
    return [cmd[1]?.trim(), args?.[1]?.trim()].filter(Boolean).join(" ")
  }
  const bash = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/)
  if (bash) return `! ${bash[1]!.trim()}`
  return dropBlocks(text)
}
